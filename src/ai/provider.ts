import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { AiSettings } from "../settings.ts";
import {
  createCodexFetch,
} from "../providers/codex-auth.ts";
import {
  createCopilotFetch,
  DEFAULT_COPILOT_BASE,
  getCopilotModelEndpoint,
} from "../providers/copilot-auth.ts";

const FLOAT_PARAMETER_KEYS = new Set([
  "temperature",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
]);

const PLAMO_API_HOST = "api.platform.preferredai.jp";
const SAKURA_API_HOST = "api.ai.sakura.ad.jp";
const OPENCODE_API_HOST = "opencode.ai";
const DEEPSEEK_API_HOST = "api.deepseek.com";
// OpenCode Go の Anthropic Messages 互換モデル(公式ドキュメント準拠)。
// それ以外は OpenAI Chat Completions 互換。
export const OPENCODE_GO_ANTHROPIC_MODELS = new Set([
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
const OPENCODE_RETRY_DELAYS_MS = [2000, 4000, 8000, 16000];

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

function isDeepSeekUrl(url: string): boolean {
  try {
    return new URL(url).hostname === DEEPSEEK_API_HOST;
  } catch {
    return url.includes(DEEPSEEK_API_HOST);
  }
}

export function resolveProviderBaseUrl(provider: AiSettings["provider"], configuredBaseUrl: string): string {
  const baseUrl = configuredBaseUrl.trim();
  if (provider === "deepseek" && isOpenCodeUrl(baseUrl)) {
    return `https://${DEEPSEEK_API_HOST}`;
  }
  if (provider === "opencode" && isDeepSeekUrl(baseUrl)) {
    return `https://${OPENCODE_API_HOST}/zen/go/v1`;
  }
  return baseUrl;
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
  // Chat Completions 形式({type:"function", function:{parameters}})にも対応する
  if (isPlainObject(toolValue.function) && isPlainObject(toolValue.function.parameters)) {
    return {
      ...toolValue,
      function: {
        ...toolValue.function,
        parameters: normalizePlamoJsonSchema(toolValue.function.parameters),
      },
    };
  }
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

// OpenCode Go は HTTP ステータスコードが 200 でも、本文内に上流モデル側の
// 一時的なエラー（レートリミット、過負荷、上流の失敗など）を返すことがある。
// AI SDK に 503 として認識させて APICallError を発生させるため、JSON の
// error.message / message フィールド、もしくは SSE の `event: error` の
// data 内でマーカーを検出した場合のみリトライ／合成レスポンスの対象とする。
// 正常なストリーム本文中の単語（小説テキスト等）を誤検知しないよう、
// エラー構造の中でのみ判定する。
const OPENCODE_TRANSIENT_ERROR_PATTERNS: RegExp[] = [
  /upstream request failed/i,
  /upstream error/i,
  /upstream unavailable/i,
  /\boverloaded\b/i,
  /temporarily unavailable/i,
  /service unavailable/i,
  /rate[- ]?limit/i,
  /too many requests/i,
  /throttl/i,
  /bad gateway/i,
  /gateway timeout/i,
  /connection reset/i,
  /connection refused/i,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /socket hang up/i,
];

function extractMessageFromParsedJson(value: unknown): string | undefined {
  if (!isPlainObject(value)) return undefined;

  const top = value.message;
  if (typeof top === "string" && top.trim()) return top;

  const error = value.error;
  if (isPlainObject(error)) {
    const nested = error.message;
    if (typeof nested === "string" && nested.trim()) return nested;
  }

  return undefined;
}

function extractOpenCodeStructuredErrorMessage(text: string): string | undefined {
  // 1) 単一 JSON レスポンス（例: {"error":{"message":"..."}}）。
  try {
    const parsed: unknown = JSON.parse(text);
    const fromJson = extractMessageFromParsedJson(parsed);
    if (fromJson) return fromJson;
  } catch {
    // JSON として解釈できない場合は SSE 解析へ。
  }

  // 2) SSE ストリームの `event: error` ブロック。
  for (const event of parseSseEvents(text)) {
    if (event.event !== "error") continue;
    if (!event.data) return "OpenCode stream error";

    try {
      const parsed: unknown = JSON.parse(event.data);
      const fromJson = extractMessageFromParsedJson(parsed);
      if (fromJson) return fromJson;
    } catch {
      // JSON でなければ生 data をそのまま返す。
    }
    return event.data;
  }

  return undefined;
}

function isOpenCodeTransientErrorText(text: string): boolean {
  // 純テキストや通常の SSE `data:` チャンクでは false を返す。
  // 判定対象は JSON error フィールド／SSE `event: error` の data のみ。
  const message = extractOpenCodeStructuredErrorMessage(text);
  if (!message) return false;
  // 抽出したメッセージ（error.message / SSE event:error の data）が
  // バリデーションエラーを示す場合のみリトライ対象外とする。
  // 本文全体に対する判定は避ける（error.type/code に "invalid" が含まれていても
  // message が upstream エラーを示す場合はリトライすべきため）。
  if (isValidationErrorResponse(message)) return false;
  return OPENCODE_TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function extractOpenCodeErrorMessage(text: string): string | undefined {
  // 構造化エラーが取れればそれを、なければ本文の先頭をそのまま使う。
  const structured = extractOpenCodeStructuredErrorMessage(text);
  const message = structured ?? (text.trim() ? text.slice(0, 200) : undefined);
  if (!message) return undefined;
  // 呼び出し側で isOpenCodeTransientErrorText により transient 判定済み
  // である前提だが、マッチしない場合もそのまま返す（抽出責務のみ）。
  return message;
}

function openCodeErrorResponse(original: Response, message: string): Response {
  const headers = new Headers(original.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");

  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        message,
        type: "opencode_upstream_error",
      },
    }),
    {
      status: 503,
      statusText: "OpenCode upstream error",
      headers,
    },
  );
}

const STREAM_PEEK_MAX_CHARS = 2048;

interface PeekedStream {
  /// 先頭から覗き見たテキスト（エラー検知用）
  text: string;
  /// 覗き見で消費した生チャンク（返却時に再生する）
  chunks: Uint8Array[];
  reader: ReadableStreamDefaultReader<Uint8Array>;
  /// 覗き見中にストリームが終端に達したか
  done: boolean;
}

/**
 * ストリームの先頭だけを読み取り、エラー検知に使う。
 * 最初の SSE イベント境界（\n\n）か一定サイズまでで打ち切る。
 * 消費したチャンクは replayedResponse で再生されるため失われない。
 */
async function peekStreamHead(body: ReadableStream<Uint8Array>): Promise<PeekedStream> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let text = "";
  let done = false;
  while (text.length < STREAM_PEEK_MAX_CHARS && !text.includes("\n\n")) {
    const result = await reader.read();
    if (result.done) {
      done = true;
      break;
    }
    chunks.push(result.value);
    text += decoder.decode(result.value, { stream: true });
  }
  return { text, chunks, reader, done };
}

/**
 * 覗き見済みのチャンクを先頭に再生しつつ、残りをリアルタイムで
 * パススルーする Response を作る。ストリーミングを維持したまま
 * 先頭エラー検知を可能にするための仕組み。
 */
function replayedResponse(original: Response, peeked: PeekedStream): Response {
  const { chunks, reader, done } = peeked;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      if (done) controller.close();
    },
    async pull(controller) {
      const result = await reader.read();
      if (result.done) {
        controller.close();
      } else {
        controller.enqueue(result.value);
      }
    },
    cancel(reason) {
      void reader.cancel(reason);
    },
  });
  return new Response(stream, {
    status: original.status,
    statusText: original.statusText,
    headers: new Headers(original.headers),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// (旧 reasoning_content → <think> タグ SSE 書き換えは削除した。
//  OpenCode Go の OpenAI 互換経路は @ai-sdk/deepseek クライアントで呼ぶことで
//  reasoning_content のパースと返送(DeepSeek V4 の必須要件)をネイティブに行う。)

// OpenCode Go はクライアント識別ヘッダが無いリクエストを匿名扱いにして
// 厳格なレート制限をかけるため、本家クライアント(sample/opencode の
// session/llm/request.ts)と同じヘッダを付与する。
const OPENCODE_CLIENT_VERSION = "1.17.18";
const OPENCODE_USER_AGENT = `opencode/${OPENCODE_CLIENT_VERSION}`;
const opencodeSessionId = `ses_${crypto.randomUUID().replace(/-/g, "")}`;
const OPENCODE_PROJECT_ID_STORAGE_KEY = "litra.opencode.projectId";
let opencodeProjectIdCache: string | undefined;

function opencodeProjectId(): string {
  if (opencodeProjectIdCache) return opencodeProjectIdCache;
  const generated = `prj_${crypto.randomUUID().replace(/-/g, "")}`;
  try {
    const existing = localStorage.getItem(OPENCODE_PROJECT_ID_STORAGE_KEY);
    if (existing) {
      opencodeProjectIdCache = existing;
      return existing;
    }
    localStorage.setItem(OPENCODE_PROJECT_ID_STORAGE_KEY, generated);
  } catch {
    // localStorage が使えない環境ではセッション内固定にフォールバック
  }
  opencodeProjectIdCache = generated;
  return generated;
}

function withOpenCodeHeaders(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  if (!headers.has("x-opencode-client")) headers.set("x-opencode-client", "cli");
  if (!headers.has("x-opencode-session")) headers.set("x-opencode-session", opencodeSessionId);
  if (!headers.has("x-opencode-request")) {
    headers.set("x-opencode-request", `msg_${crypto.randomUUID().replace(/-/g, "")}`);
  }
  if (!headers.has("x-opencode-project")) headers.set("x-opencode-project", opencodeProjectId());
  if (!headers.has("user-agent")) headers.set("User-Agent", OPENCODE_USER_AGENT);
  return { ...init, headers };
}

/**
 * OpenCode Go(OpenAI 互換経路)のリクエスト正規化。
 * GLM-5 系は content が空文字の assistant + tool_calls メッセージを拒否するため、
 * OpenAI 標準で許される content: null に置き換える。
 */
function normalizeOpenCodeRequestBody(bodyJson: string): string {
  const parsed: unknown = JSON.parse(bodyJson);
  if (isRecord(parsed) && Array.isArray(parsed.messages)) {
    for (const message of parsed.messages) {
      if (
        isRecord(message) &&
        message.role === "assistant" &&
        Array.isArray(message.tool_calls) &&
        message.content === ""
      ) {
        message.content = null;
      }
    }
  }
  return preserveNumberTypes(JSON.stringify(parsed));
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
          : isOpenCodeRequest
            ? normalizeOpenCodeRequestBody(body)
            : preserveNumberTypes(JSON.stringify(JSON.parse(body)));
      init = { ...init, body };
    } catch {
      // ignore parse error
    }
  }

  if (isOpenCodeRequest) {
    init = withOpenCodeHeaders(init);
  }

  for (let attempt = 0; ; attempt++) {
    if (isSakuraRequest) {
      await waitForRequestSlot("sakura", SAKURA_MIN_REQUEST_INTERVAL_MS);
    } else if (isOpenCodeRequest) {
      await waitForRequestSlot("opencode", OPENCODE_MIN_REQUEST_INTERVAL_MS);
    }

    console.log("[litra] fetch request", url, body ? body.slice(0, 500) : undefined);
    const res = await tauriFetch(input, init);

    // ストリーミング（SSE）成功レスポンスは全文を読まない。
    // 全文を await すると応答完了までチャンクが AI SDK に一切届かず、
    // リアルタイム表示が壊れる。先頭だけ覗いてエラー検知し、
    // 残りはパススルーで流す。
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    if (res.ok && contentType.includes("text/event-stream") && res.body) {
      const peeked = await peekStreamHead(res.body);
      console.log("[litra] fetch response (stream)", res.status, peeked.text.slice(0, 200));

      if (
        isOpenCodeRequest &&
        !abortSignal?.aborted &&
        isOpenCodeTransientErrorText(peeked.text)
      ) {
        await peeked.reader.cancel();
        if (attempt < OPENCODE_RETRY_DELAYS_MS.length) {
          const retryDelayMs = getRetryDelayMs(res, attempt, OPENCODE_RETRY_DELAYS_MS);
          console.warn("[litra] OpenCode Go transient upstream error in stream head; retrying", {
            status: res.status,
            attempt: attempt + 1,
            retryDelayMs,
          });
          await sleep(retryDelayMs, abortSignal);
          continue;
        }
        const openCodeErrorMessage =
          extractOpenCodeErrorMessage(peeked.text) ?? "OpenCode upstream error";
        console.error("[litra] OpenCode upstream error in stream head:", openCodeErrorMessage);
        return openCodeErrorResponse(res, openCodeErrorMessage);
      }

      if (isPlamoUrl(url)) {
        const plamoStreamError = extractPlamoStreamErrorMessage(peeked.text);
        if (plamoStreamError) {
          await peeked.reader.cancel();
          console.error("[litra] PLaMo stream error:", plamoStreamError);
          return plamoErrorResponse(res, plamoStreamError);
        }
      }

      return replayedResponse(res, peeked);
    }

    const clone = res.clone ? res.clone() : res;
    const text = await clone.text();
    console.log("[litra] fetch response", res.status, text.slice(0, 500));

    if (
      isSakuraRequest &&
      SAKURA_RETRY_STATUS_CODES.has(res.status) &&
      !isValidationErrorResponse(text) &&
      !abortSignal?.aborted &&
      attempt < SAKURA_RETRY_DELAYS_MS.length
    ) {
      const retryDelayMs = getRetryDelayMs(res, attempt, SAKURA_RETRY_DELAYS_MS);
      console.warn("[litra] Sakura rate-limit response; retrying", {
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
      console.warn("[litra] OpenCode Go rate-limit/unavailable response; retrying", {
        status: res.status,
        attempt: attempt + 1,
        retryDelayMs,
      });
      await sleep(retryDelayMs, abortSignal);
      continue;
    }

    // OpenCode は HTTP 200 で本文に transient エラーが乗るケースがあるため、
    // 本文ベースでもう一段リトライ判定する。400 系は恒久的な入力エラーの
    // 可能性が高いため再試行せず、ステータスリトライ（429/500/502/503/529）
    // でカバーされる 5xx 系のみ本文リトライの対象とする。正常な本文を
    // 誤検知しないよう、isOpenCodeTransientErrorText は JSON error /
    // SSE event: error 内のメッセージでのみマーカーを探す。
    // 注: validation エラー除外は isOpenCodeTransientErrorText 内で
    // 抽出メッセージに対して行う（本文全体だと error.type/code の "invalid"
    // に引っかかり transient upstream エラーがリトライされなくなるため）。
    if (
      isOpenCodeRequest &&
      res.ok &&
      !abortSignal?.aborted &&
      attempt < OPENCODE_RETRY_DELAYS_MS.length &&
      isOpenCodeTransientErrorText(text)
    ) {
      const retryDelayMs = getRetryDelayMs(res, attempt, OPENCODE_RETRY_DELAYS_MS);
      console.warn("[litra] OpenCode Go transient upstream error in body; retrying", {
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
        console.error("[litra] PLaMo stream error:", plamoStreamError);
        return plamoErrorResponse(res, plamoStreamError);
      }
    }

    // OpenCode は HTTP 200 で upstream エラーが返るケースがあるため、
    // AI SDK が 503 として認識できるよう合成レスポンスを返す。
    // 400 系は恒久的な入力エラーの可能性が高いためそのまま返す。
    if (isOpenCodeRequest && res.ok && isOpenCodeTransientErrorText(text)) {
      const openCodeErrorMessage = extractOpenCodeErrorMessage(text);
      if (openCodeErrorMessage) {
        console.error("[litra] OpenCode upstream error in body:", openCodeErrorMessage);
        return openCodeErrorResponse(res, openCodeErrorMessage);
      }
    }

    return res;
  }
}

export function createModel(settings: AiSettings) {
  const configuredBaseUrl = typeof settings.baseUrl === "string" ? settings.baseUrl.trim() : "";
  const baseURL = resolveProviderBaseUrl(settings.provider, configuredBaseUrl);
  if (baseURL !== configuredBaseUrl && settings.provider === "deepseek") {
    console.error("[litra] rejected OpenCode Go URL for DeepSeek provider; using official DeepSeek API");
  } else if (baseURL !== configuredBaseUrl && settings.provider === "opencode") {
    console.error("[litra] rejected DeepSeek URL for OpenCode Go provider; using official OpenCode Go API");
  }
  const trimmedApiKey = typeof settings.apiKey === "string" ? settings.apiKey.trim() : "";
  const apiKey =
    trimmedApiKey || (settings.provider === "llamacpp" ? "sk-no-key-required" : trimmedApiKey);
  console.log(
    "[litra] createModel",
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
      // Sakura の /v1/responses はマルチターン会話非対応と公式明記のため Chat Completions を使う。
      if (settings.provider === "sakura") {
        return openai.chat(settings.model);
      }
      // llama-server の /v1/responses は最近入った変換シムで、無いビルドも多い。
      // 素の openai(model) は Responses API に POST するため Chat Completions を明示する。
      if (settings.provider === "llamacpp") {
        return openai.chat(settings.model);
      }
      return openai(settings.model);
    }
    case "opencode":
      if (OPENCODE_GO_ANTHROPIC_MODELS.has(settings.model)) {
        return createAnthropic(common)(settings.model);
      }
      // OpenAI 互換経路(DeepSeek V4 / GLM / MiMo)は思考内容が delta.reasoning_content で
      // 届き、DeepSeek V4 ではマルチターンのツール呼び出し時に reasoning_content を
      // 「専用フィールドのまま」返送する必要がある(<think> タグ変換では 400)。
      // @ai-sdk/deepseek はこのパースと返送(V4 判定含む)をネイティブに行うため、
      // OpenAI 互換クライアントではなく DeepSeek クライアントで呼ぶ。
      return createDeepSeek(common)(settings.model);
    case "codex": {
      // Codex は OpenAI Responses API 互換。OAuth トークンは fetch ラッパーが処理する。
      const codexCommon = {
        ...common,
        apiKey: "sk-codex-oauth",
        fetch: createCodexFetch(),
        baseURL: baseURL || "https://chatgpt.com/backend-api/codex",
      };
      return createOpenAI(codexCommon).responses(settings.model);
    }
    case "github-copilot": {
      const endpoint = getCopilotModelEndpoint(settings.model);
      const copilotBaseUrl = baseURL || DEFAULT_COPILOT_BASE;
      const copilotCommon = {
        ...common,
        apiKey: "sk-copilot-oauth",
        fetch: createCopilotFetch(),
        baseURL: endpoint === "messages" ? `${copilotBaseUrl.replace(/\/$/, "")}/v1` : copilotBaseUrl,
      };
      if (endpoint === "messages") return createAnthropic(copilotCommon)(settings.model);
      const openai = createOpenAI(copilotCommon);
      return endpoint === "responses" ? openai.responses(settings.model) : openai.chat(settings.model);
    }
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
