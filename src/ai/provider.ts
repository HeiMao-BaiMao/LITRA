import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { AiSettings } from "../settings.ts";

const FLOAT_PARAMETER_KEYS = new Set([
  "temperature",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
]);

const PLAMO_API_HOST = "api.platform.preferredai.jp";
const SAKURA_API_HOST = "api.ai.sakura.ad.jp";
const OPENCODE_API_HOST = "opencode.ai";
// OpenCode Go の Anthropic Messages 互換モデル(公式ドキュメント準拠)。
// それ以外は OpenAI Chat Completions 互換。
const OPENCODE_GO_ANTHROPIC_MODELS = new Set([
  "minimax-m3",
  "minimax-m2.7",
  "minimax-m2.5",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-plus",
  "qwen3.5-plus",
]);
const PLAMO_UNSUPPORTED_SCHEMA_KEYS = new Set(["$schema", "propertyNames"]);
const SAKURA_RETRY_STATUS_CODES = new Set([429, 439]);
const SAKURA_MIN_REQUEST_INTERVAL_MS = 2500;
const SAKURA_RETRY_DELAYS_MS = [2500, 5000, 10000, 20000];
// OpenCode Go は短時間のレート制限(429)や上流モデルの一時エラー(5xx)を返す
// ことがあり、AI SDK 標準の数秒のリトライでは回復しない。リクエスト間隔を
// 空けつつ、長めのバックオフで再試行する。
const OPENCODE_RETRY_STATUS_CODES = new Set([429, 500, 502, 503, 529]);
const OPENCODE_MIN_REQUEST_INTERVAL_MS = 1500;
const OPENCODE_RETRY_DELAYS_MS = [3000, 8000, 20000, 40000];

interface RequestThrottle {
  nextRequestAt: number;
  queue: Promise<void>;
}

const requestThrottles = new Map<string, RequestThrottle>();

/**
 * JSON 上で float 型として定義されているパラメーターが整数値の場合でも
 * 小数点を維持してシリアライズする。一部の API（PLaMo など）は整数と float
 * を区別してバリデーションするため、1.0 を 1 として送信すると 500 エラーに
 * なるケースがある。
 */
function preserveNumberTypes(bodyJson: string): string {
  const keyAlternation = Array.from(FLOAT_PARAMETER_KEYS).join("|");
  const pattern = new RegExp(
    `"(${keyAlternation})"\\s*:\\s*(-?\\d+)(?![\\.\\deE])`,
    "g",
  );
  return bodyJson.replace(pattern, '"$1":$2.0');
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish);
  });
}

async function waitForRequestSlot(key: string, minIntervalMs: number): Promise<void> {
  let throttle = requestThrottles.get(key);
  if (!throttle) {
    throttle = { nextRequestAt: 0, queue: Promise.resolve() };
    requestThrottles.set(key, throttle);
  }

  const previous = throttle.queue;
  let release: () => void = () => {};
  throttle.queue = new Promise<void>((resolve) => {
    release = resolve;
  });

  try {
    await previous;
    const waitMs = Math.max(0, throttle.nextRequestAt - Date.now());
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    throttle.nextRequestAt = Date.now() + minIntervalMs;
  } finally {
    release();
  }
}

function parseRetryAfterMs(headers: Headers): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return undefined;

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return undefined;
}

function getRetryDelayMs(response: Response, retryIndex: number, delays: number[]): number {
  return parseRetryAfterMs(response.headers) ??
    delays[Math.min(retryIndex, delays.length - 1)];
}

function isValidationErrorResponse(text: string): boolean {
  return /validation errors?|Input should be|Unprocessable Entity|invalid/i.test(text);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlamoUrl(url: string): boolean {
  try {
    return new URL(url).hostname === PLAMO_API_HOST;
  } catch {
    return url.includes(PLAMO_API_HOST);
  }
}

function isSakuraUrl(url: string): boolean {
  try {
    return new URL(url).hostname === SAKURA_API_HOST;
  } catch {
    return url.includes(SAKURA_API_HOST);
  }
}

function isOpenCodeUrl(url: string): boolean {
  try {
    return new URL(url).hostname === OPENCODE_API_HOST;
  } catch {
    return url.includes(OPENCODE_API_HOST);
  }
}

function isResponsesUrl(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith("/responses");
  } catch {
    return url.includes("/responses");
  }
}

function normalizePlamoJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizePlamoJsonSchema);
  if (!isPlainObject(value)) return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (PLAMO_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    result[key] = normalizePlamoJsonSchema(child);
  }
  return result;
}

function normalizePlamoTool(toolValue: unknown): unknown {
  if (!isPlainObject(toolValue)) return toolValue;
  const fn = toolValue.function;
  if (!isPlainObject(fn)) return toolValue;
  const parameters = normalizePlamoJsonSchema(fn.parameters);

  return {
    ...toolValue,
    function: {
      ...fn,
      parameters,
    },
  };
}

function normalizePlamoRequestBody(bodyJson: string): string {
  const parsed: unknown = JSON.parse(bodyJson);
  if (!isPlainObject(parsed)) return preserveNumberTypes(JSON.stringify(parsed));

  const body: Record<string, unknown> = { ...parsed };

  // PLaMo の Chat Completions 仕様にない OpenAI 固有パラメーターは送らない。
  delete body.parallel_tool_calls;
  delete body.top_k;

  if (Array.isArray(body.tools)) {
    body.tools = body.tools.map(normalizePlamoTool);
  }

  return preserveNumberTypes(JSON.stringify(body));
}

function normalizeSakuraResponsesTool(toolValue: unknown): unknown {
  if (!isPlainObject(toolValue)) return toolValue;
  if (!isPlainObject(toolValue.parameters)) return toolValue;

  return {
    ...toolValue,
    parameters: normalizePlamoJsonSchema(toolValue.parameters),
  };
}

function responseContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!isPlainObject(part)) return JSON.stringify(part);
        if (typeof part.text === "string") return part.text;
        if (typeof part.output === "string") return part.output;
        if (typeof part.content === "string") return part.content;
        if (Array.isArray(part.content)) return responseContentToText(part.content);
        return JSON.stringify(part);
      })
      .filter((part) => part.trim().length > 0)
      .join("\n");
  }
  if (isPlainObject(content)) {
    if (typeof content.text === "string") return content.text;
    if (typeof content.output === "string") return content.output;
    if (typeof content.content === "string") return content.content;
    if (Array.isArray(content.content)) return responseContentToText(content.content);
  }
  return content == null ? "" : JSON.stringify(content);
}

function responseInputItemToText(item: unknown): string {
  if (typeof item === "string") return item;
  if (!isPlainObject(item)) return JSON.stringify(item);

  const type = typeof item.type === "string" ? item.type : undefined;
  if (type === "item_reference") return "";

  const role = typeof item.role === "string" ? item.role : undefined;
  if (role) {
    const content = responseContentToText(item.content);
    return content ? `【${role}】\n${content}` : "";
  }

  if (type === "function_call") {
    const name = typeof item.name === "string" ? item.name : "unknown";
    const args = responseContentToText(item.arguments);
    return `【tool_call】\nname: ${name}${args ? `\narguments: ${args}` : ""}`;
  }

  if (type === "function_call_output") {
    return `【tool_result】\n${responseContentToText(item.output)}`;
  }

  const content = responseContentToText(item.content ?? item.output ?? item.text);
  return content || JSON.stringify(item);
}

function normalizeSakuraResponsesInput(body: Record<string, unknown>): void {
  const instructions = typeof body.instructions === "string" ? body.instructions.trim() : "";
  delete body.instructions;
  delete body.previous_response_id;
  delete body.conversation;
  delete body.store;
  delete body.parallel_tool_calls;

  if (Array.isArray(body.input)) {
    const inputText = body.input
      .map(responseInputItemToText)
      .filter((part) => part.trim().length > 0)
      .join("\n\n");
    body.input = [instructions, inputText].filter((part) => part.trim().length > 0).join("\n\n") ||
      "続けてください。";
    return;
  }

  if (typeof body.input === "string") {
    body.input = [instructions, body.input].filter((part) => part.trim().length > 0).join("\n\n") ||
      "続けてください。";
  }
}

function normalizeSakuraRequestBody(bodyJson: string, url: string): string {
  const parsed: unknown = JSON.parse(bodyJson);
  if (!isPlainObject(parsed)) return preserveNumberTypes(JSON.stringify(parsed));

  const body: Record<string, unknown> = { ...parsed };
  if (isResponsesUrl(url)) {
    normalizeSakuraResponsesInput(body);
  }
  if (Array.isArray(body.tools)) {
    body.tools = body.tools.map(normalizeSakuraResponsesTool);
  }

  return preserveNumberTypes(JSON.stringify(body));
}

function parseSseEvents(text: string): Array<{ event?: string; data: string }> {
  return text
    .split(/\r?\n\r?\n/)
    .map((rawEvent) => {
      let event: string | undefined;
      const dataLines: string[] = [];
      for (const line of rawEvent.split(/\r?\n/)) {
        if (line.startsWith("event:")) {
          event = line.slice("event:".length).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trimStart());
        }
      }
      return { event, data: dataLines.join("\n") };
    })
    .filter((event) => event.event || event.data);
}

function extractPlamoStreamErrorMessage(text: string): string | undefined {
  for (const event of parseSseEvents(text)) {
    if (event.event !== "error") continue;
    if (!event.data) return "PLaMo stream error";

    try {
      const parsed: unknown = JSON.parse(event.data);
      if (isPlainObject(parsed)) {
        const message = parsed.message;
        if (typeof message === "string" && message.trim()) return message;

        const error = parsed.error;
        if (isPlainObject(error) && typeof error.message === "string" && error.message.trim()) {
          return error.message;
        }
      }
    } catch {
      // Fall through to returning the raw data below.
    }

    return event.data;
  }

  return undefined;
}

function plamoErrorResponse(original: Response, message: string): Response {
  const headers = new Headers(original.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");

  return new Response(
    JSON.stringify({
      error: {
        message,
        type: "plamo_stream_error",
      },
    }),
    {
      status: 500,
      statusText: "PLaMo stream error",
      headers,
    },
  );
}

async function debugFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  let body = init?.body ? String(init.body) : undefined;
  const isSakuraRequest = isSakuraUrl(url);
  const isOpenCodeRequest = isOpenCodeUrl(url);
  const abortSignal = init?.signal ?? undefined;

  if (body) {
    try {
      body = isPlamoUrl(url)
        ? normalizePlamoRequestBody(body)
        : isSakuraRequest
          ? normalizeSakuraRequestBody(body, url)
          : preserveNumberTypes(JSON.stringify(JSON.parse(body)));
      init = { ...init, body };
    } catch {
      // ignore parse error
    }
  }

  for (let attempt = 0; ; attempt++) {
    if (isSakuraRequest) {
      await waitForRequestSlot("sakura", SAKURA_MIN_REQUEST_INTERVAL_MS);
    } else if (isOpenCodeRequest) {
      await waitForRequestSlot("opencode", OPENCODE_MIN_REQUEST_INTERVAL_MS);
    }

    console.log("[phenex] fetch request", url, body);
    const res = await tauriFetch(input, init);
    const clone = res.clone ? res.clone() : res;
    const text = await clone.text();
    console.log("[phenex] fetch response", res.status, text.slice(0, 500));

    if (
      isSakuraRequest &&
      SAKURA_RETRY_STATUS_CODES.has(res.status) &&
      !isValidationErrorResponse(text) &&
      !abortSignal?.aborted &&
      attempt < SAKURA_RETRY_DELAYS_MS.length
    ) {
      const retryDelayMs = getRetryDelayMs(res, attempt, SAKURA_RETRY_DELAYS_MS);
      console.warn("[phenex] Sakura rate-limit response; retrying", {
        status: res.status,
        attempt: attempt + 1,
        retryDelayMs,
      });
      await sleep(retryDelayMs, abortSignal);
      continue;
    }

    if (
      isOpenCodeRequest &&
      OPENCODE_RETRY_STATUS_CODES.has(res.status) &&
      !isValidationErrorResponse(text) &&
      !abortSignal?.aborted &&
      attempt < OPENCODE_RETRY_DELAYS_MS.length
    ) {
      const retryDelayMs = getRetryDelayMs(res, attempt, OPENCODE_RETRY_DELAYS_MS);
      console.warn("[phenex] OpenCode Go rate-limit/unavailable response; retrying", {
        status: res.status,
        attempt: attempt + 1,
        retryDelayMs,
      });
      await sleep(retryDelayMs, abortSignal);
      continue;
    }

    if (res.ok && isPlamoUrl(url)) {
      const plamoStreamError = extractPlamoStreamErrorMessage(text);
      if (plamoStreamError) {
        console.error("[phenex] PLaMo stream error:", plamoStreamError);
        return plamoErrorResponse(res, plamoStreamError);
      }
    }

    return res;
  }
}

export function createModel(settings: AiSettings) {
  const baseURL = settings.baseUrl.trim();
  const apiKey =
    settings.apiKey.trim() || (settings.provider === "llamacpp" ? "sk-no-key-required" : settings.apiKey);
  console.log(
    "[phenex] createModel",
    JSON.stringify({
      provider: settings.provider,
      model: settings.model,
      baseURL: baseURL || "(default)",
      hasApiKey: Boolean(apiKey && apiKey !== "sk-no-key-required"),
    }),
  );
  const common = {
    apiKey,
    fetch: debugFetch,
    ...(baseURL ? { baseURL } : {}),
  };

  switch (settings.provider) {
    case "openai":
    case "llamacpp":
    case "sakura":
    case "plamo": {
      const openai = createOpenAI(common);
      // PLaMo は /v1/responses に対応していないので Chat Completions を使う。
      if (settings.provider === "plamo") {
        return openai.chat(settings.model);
      }
      if (settings.provider === "sakura") {
        return openai.responses(settings.model);
      }
      return openai(settings.model);
    }
    case "opencode":
      if (OPENCODE_GO_ANTHROPIC_MODELS.has(settings.model)) {
        return createAnthropic(common)(settings.model);
      }
      return createOpenAI(common).chat(settings.model);
    case "anthropic":
      return createAnthropic(common)(settings.model);
    case "deepseek":
      return createDeepSeek(common)(settings.model);
    case "google":
      return createGoogleGenerativeAI(common)(settings.model);
    default: {
      const provider: never = settings.provider;
      throw new Error(`Unsupported AI provider: ${provider}`);
    }
  }
}
