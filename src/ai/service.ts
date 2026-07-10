import { generateText, isLoopFinished, stepCountIs, streamText, type ModelMessage, type StopCondition, type TextStreamPart, type ToolSet } from "ai";
import { createModel } from "./provider.ts";
import { buildProviderOptions, buildRetryOption, isGemini3Model } from "./provider-options.ts";
import {
  buildAssistantSystemPrompt,
  buildCharacterVoiceCardsPrompt,
  buildContinuationPlanPrompt,
  buildContinuationPrompt,
  buildContinuationRevisionPrompt,
  buildContinuationReviewPrompt,
  buildDraftSelectionPrompt,
  buildFeedbackPrompt,
  buildRewritePrompt,
  buildSceneStateCardPrompt,
  buildTargetedRevisionPrompt,
  buildToolCallNeedPrompt,
  formatMechanicalFindingsForReview,
  limitPromptText,
  parseDraftSelection,
  parseTargetedRevision,
  reviewRequiresRevision,
  toolCallNeedSchema,
  type FictionPromptExtras,
  type PromptScaffoldLevel,
} from "./prompts.ts";
import { checkDraft, sanitizeDraftText } from "./draft-checks.ts";
import { parsePlanBeats } from "./plan-beats.ts";
import type { AiSettings } from "../settings.ts";

// ビート分割生成で前ビートの生成分を文脈に継ぎ足す際、無制限に伸びないための上限
const BEAT_CONTEXT_CHAR_BUDGET = 12000;

const DEFAULT_ANTHROPIC_THINKING_BUDGET = 8000;
const TOOL_LOOP_MAX_STEPS = 16;
const DUPLICATE_TOOL_CALL_INPUT_LIMIT = 4;

function isDeepSeekThinkingEnabled(settings: AiSettings, toolsEnabled: boolean): boolean {
  // DeepSeek の thinking モードはツール呼び出しと両立しない。
  // ツールを使う場合、または役割プロファイル等で明示的に無効化されている場合は
  // thinking を無効にし、代わりに温度・top_p・ペナルティ類のサンプリングパラメータを有効にする。
  return settings.provider === "deepseek" && !toolsEnabled && settings.deepseekThinkingEnabled !== false;
}

function isGoogleGemini3(settings: AiSettings): boolean {
  return settings.provider === "google" && isGemini3Model(settings.model);
}

function buildTemperatureOption(settings: AiSettings, toolsEnabled = false) {
  // DeepSeek の thinking モードでは temperature は無視される。
  // OpenCode Go プロバイダでは OpenCode クライアントに合わせて temperature を送らない
  // (OpenCode の transform.ts:481-498 で DeepSeek/GLM/MiniMax/MiMo 等は undefined を返す)。
  if (isDeepSeekThinkingEnabled(settings, toolsEnabled)) return {};
  if (settings.provider === "opencode") return {};
  // Gemini 3 系は「temperature は既定値 1.0 のまま変更しない」ことが公式に強く
  // 推奨されており、変更するとループや推論品質の劣化を招き得るため送らない。
  if (isGoogleGemini3(settings)) return {};
  return { temperature: settings.temperature };
}

function buildAdvancedOptions(settings: AiSettings, toolsEnabled = false) {
  const providerOptions = buildProviderOptions(settings, toolsEnabled);
  // OpenCode Go プロバイダでは OpenCode クライアントに合わせるため、
  // topP / topK / frequencyPenalty / presencePenalty をすべて送らない
  // (transform.ts:500-507 と native-request.ts:135-143 で populate されない)。
  // Gemini 3 系も同様に、topP/topK 等の sampling params は公式に非推奨となり
  // thinkingConfig.thinkingLevel（buildProviderOptions 経由）に置き換わっている。
  const ignoreSampling =
    isDeepSeekThinkingEnabled(settings, toolsEnabled) ||
    settings.provider === "opencode" ||
    isGoogleGemini3(settings);
  const ignorePenalty = settings.provider === "sakura" || settings.provider === "opencode";
  return {
    ...(!ignoreSampling && settings.topP !== undefined && { topP: settings.topP }),
    ...(!ignoreSampling && settings.topK !== undefined && { topK: settings.topK }),
    ...(!ignoreSampling && !ignorePenalty && settings.frequencyPenalty !== undefined && {
      frequencyPenalty: settings.frequencyPenalty,
    }),
    ...(!ignoreSampling && !ignorePenalty && settings.presencePenalty !== undefined && {
      presencePenalty: settings.presencePenalty,
    }),
    ...(providerOptions && { providerOptions }),
  };
}

function hasTools(tools: ToolSet | undefined): tools is ToolSet {
  if (tools == null || Object.keys(tools).length === 0) return false;
  return true;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function duplicateToolCallInputCountIs(limit: number): StopCondition<any> {
  return ({ steps }) => {
    const counts = new Map<string, number>();
    for (const step of steps) {
      for (const toolCall of step.toolCalls) {
        const key = `${toolCall.toolName}:${stableStringify(toolCall.input)}`;
        const nextCount = (counts.get(key) ?? 0) + 1;
        if (nextCount >= limit) {
          console.warn("[litra:ai] stopping repeated tool call loop:", {
            toolName: toolCall.toolName,
            repeatedCalls: nextCount,
          });
          return true;
        }
        counts.set(key, nextCount);
      }
    }
    return false;
  };
}

function toolLoopStopConditions(
  stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>,
): Array<StopCondition<ToolSet>> {
  const base = Array.isArray(stopWhen)
    ? stopWhen
    : stopWhen
      ? [stopWhen]
      : [isLoopFinished() as StopCondition<ToolSet>];
  return [
    ...base,
    stepCountIs(TOOL_LOOP_MAX_STEPS) as StopCondition<ToolSet>,
    duplicateToolCallInputCountIs(DUPLICATE_TOOL_CALL_INPUT_LIMIT) as StopCondition<ToolSet>,
  ];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOptionalRange(
  value: number | undefined,
  min: number,
  max: number,
): number | undefined {
  if (!isFiniteNumber(value) || value < min || value > max) return undefined;
  return value;
}

export interface StreamRunResult {
  textChunkCount: number;
  textCharCount: number;
  reasoningChunkCount: number;
  reasoningCharCount: number;
  toolCallCount: number;
  toolResultCount: number;
  toolErrorCount: number;
  finishReason?: string;
  response?: {
    id: string;
    modelId: string;
    timestamp?: string;
  };
  stoppedAfterToolResult: boolean;
  stoppedAfterToolActivity: boolean;
  pendingToolCallIds: string[];
  responseMessages: ModelMessage[];
}

export type StreamToolEvent =
  | {
      type: "input-start";
      toolCallId: string;
      toolName: string;
    }
  | {
      type: "call";
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | {
      type: "result";
      toolCallId: string;
      toolName: string;
      input: unknown;
      output: unknown;
    }
  | {
      type: "error";
      toolCallId: string;
      toolName: string;
      input: unknown;
      error: unknown;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getStringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function extractReasoningChunk(part: unknown): string | undefined {
  if (!isRecord(part)) return undefined;
  const type = part.type;
  if (type !== "reasoning-delta" && type !== "reasoning") return undefined;
  return getStringField(part, ["delta", "text", "textDelta"]);
}

function extractTextChunk(part: unknown): string | undefined {
  if (!isRecord(part)) return undefined;
  const type = part.type;
  if (type !== "text-delta" && type !== "text") return undefined;
  return getStringField(part, ["delta", "text", "textDelta"]);
}

const THINK_OPEN_TAGS = ["<think>", "<thinking>"];
const THINK_CLOSE_TAGS = ["</think>", "</thinking>"];

interface ThinkTagRouter {
  push(chunk: string): void;
  flush(): void;
}

/**
 * OpenAI 互換プロバイダの一部は思考過程を reasoning-delta ではなく、
 * 本文ストリーム中の <think>...</think> として返す。タグ内を思考として
 * 分離し、本文へ混入させない。タグがチャンク境界で分割されるケースに
 * 備えて、タグの先頭になり得る末尾文字列はバッファに保持する。
 */
function createThinkTagRouter(
  emitText: (chunk: string) => void,
  emitReasoning: (chunk: string) => void,
): ThinkTagRouter {
  let buffer = "";
  let inThink = false;

  const findFirstTag = (
    text: string,
    tags: string[],
  ): { index: number; tag: string } | undefined => {
    let found: { index: number; tag: string } | undefined;
    for (const tag of tags) {
      const index = text.indexOf(tag);
      if (index >= 0 && (found === undefined || index < found.index)) {
        found = { index, tag };
      }
    }
    return found;
  };

  const partialTagHold = (text: string, tags: string[]): number => {
    let hold = 0;
    for (const tag of tags) {
      const maxLen = Math.min(tag.length - 1, text.length);
      for (let len = maxLen; len > hold; len--) {
        if (text.endsWith(tag.slice(0, len))) {
          hold = len;
          break;
        }
      }
    }
    return hold;
  };

  const emit = (chunk: string): void => {
    if (!chunk) return;
    if (inThink) {
      emitReasoning(chunk);
    } else {
      emitText(chunk);
    }
  };

  return {
    push(chunk: string): void {
      buffer += chunk;
      for (;;) {
        const tags = inThink ? THINK_CLOSE_TAGS : THINK_OPEN_TAGS;
        const match = findFirstTag(buffer, tags);
        if (match) {
          emit(buffer.slice(0, match.index));
          buffer = buffer.slice(match.index + match.tag.length);
          inThink = !inThink;
          continue;
        }
        const hold = partialTagHold(buffer, tags);
        const emitLength = buffer.length - hold;
        if (emitLength > 0) {
          emit(buffer.slice(0, emitLength));
          buffer = buffer.slice(emitLength);
        }
        return;
      }
    },
    flush(): void {
      const rest = buffer;
      buffer = "";
      emit(rest);
    },
  };
}

async function consumeStream(
  result: {
    fullStream: AsyncIterable<TextStreamPart<ToolSet>>;
    response: PromiseLike<{
      id: string;
      modelId: string;
      timestamp?: Date;
      messages: ModelMessage[];
    }>;
  },
  onChunk: (chunk: string) => void,
  onToolEvent?: (event: StreamToolEvent) => void,
  onReasoning?: (chunk: string) => void,
): Promise<StreamRunResult> {
  let chunkCount = 0;
  let charCount = 0;
  let reasoningChunkCount = 0;
  let reasoningCharCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let toolErrorCount = 0;
  let finishReason: string | undefined;
  let response: StreamRunResult["response"];
  let responseMessages: ModelMessage[] = [];
  let lastSignificantPart: "text" | "reasoning" | "tool-input" | "tool-call" | "tool-result" | "tool-error" | undefined;
  const pendingToolCallIds = new Set<string>();

  const emitReasoning = (chunk: string): void => {
    reasoningChunkCount++;
    reasoningCharCount += chunk.length;
    lastSignificantPart = "reasoning";
    if (reasoningChunkCount <= 3 || reasoningChunkCount % 10 === 0) {
      console.log(`[litra:ai] reasoning chunk #${reasoningChunkCount}:`, chunk.slice(0, 80));
    }
    onReasoning?.(chunk);
  };
  const emitText = (chunk: string): void => {
    chunkCount++;
    charCount += chunk.length;
    lastSignificantPart = "text";
    if (chunkCount <= 3 || chunkCount % 10 === 0) {
      console.log(`[litra:ai] text chunk #${chunkCount}:`, chunk.slice(0, 80));
    }
    onChunk(chunk);
  };
  // <think> タグ入りの本文を、思考と本文へ振り分ける
  const textRouter = createThinkTagRouter(emitText, emitReasoning);

  for await (const part of result.fullStream) {
    const reasoningChunk = extractReasoningChunk(part);
    if (reasoningChunk !== undefined) {
      if (!reasoningChunk) continue;
      emitReasoning(reasoningChunk);
      continue;
    }

    const textChunk = extractTextChunk(part);
    if (textChunk !== undefined) {
      if (!textChunk) continue;
      textRouter.push(textChunk);
      continue;
    }

    switch (part.type) {
      case "tool-input-start": {
        lastSignificantPart = "tool-input";
        pendingToolCallIds.add(part.id);
        console.log(`[litra:ai] tool input start: ${part.toolName}`);
        onToolEvent?.({
          type: "input-start",
          toolCallId: part.id,
          toolName: part.toolName,
        });
        break;
      }
      case "tool-call": {
        toolCallCount++;
        lastSignificantPart = "tool-call";
        pendingToolCallIds.add(part.toolCallId);
        console.log(`[litra:ai] tool call: ${part.toolName}`, part.input);
        onToolEvent?.({
          type: "call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
        });
        break;
      }
      case "tool-result": {
        if (part.preliminary) break;
        toolResultCount++;
        lastSignificantPart = "tool-result";
        pendingToolCallIds.delete(part.toolCallId);
        console.log(`[litra:ai] tool result: ${part.toolName}`, part.input);
        onToolEvent?.({
          type: "result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
          output: part.output,
        });
        break;
      }
      case "tool-error": {
        toolErrorCount++;
        lastSignificantPart = "tool-error";
        pendingToolCallIds.delete(part.toolCallId);
        console.error(`[litra:ai] tool error: ${part.toolName}`, part.error);
        onToolEvent?.({
          type: "error",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
          error: part.error,
        });
        break;
      }
      case "finish": {
        finishReason = part.finishReason;
        break;
      }
      case "finish-step": {
        response = {
          id: part.response.id,
          modelId: part.response.modelId,
          timestamp: part.response.timestamp instanceof Date
            ? part.response.timestamp.toISOString()
            : undefined,
        };
        break;
      }
      case "error": {
        throw part.error;
      }
    }
  }

  textRouter.flush();

  try {
    const streamResponse = await result.response;
    response = {
      id: streamResponse.id,
      modelId: streamResponse.modelId,
      timestamp: streamResponse.timestamp instanceof Date
        ? streamResponse.timestamp.toISOString()
        : undefined,
    };
    responseMessages = streamResponse.messages;
  } catch (error) {
    console.warn("[litra:ai] failed to read response messages:", error);
  }

  console.log(`[litra:ai] stream finished. text chunks: ${chunkCount}, tool results: ${toolResultCount}, finish: ${finishReason ?? "unknown"}`);
  return {
    textChunkCount: chunkCount,
    textCharCount: charCount,
    reasoningChunkCount,
    reasoningCharCount,
    toolCallCount,
    toolResultCount,
    toolErrorCount,
    finishReason,
    response,
    stoppedAfterToolResult: lastSignificantPart === "tool-result" || lastSignificantPart === "tool-error",
    stoppedAfterToolActivity:
      lastSignificantPart === "tool-input" ||
      lastSignificantPart === "tool-call" ||
      lastSignificantPart === "tool-result" ||
      lastSignificantPart === "tool-error",
    pendingToolCallIds: [...pendingToolCallIds],
    responseMessages,
  };
}

export interface StreamChatOptions {
  settings: AiSettings;
  messages: ModelMessage[];
  onChunk: (chunk: string) => void;
  onReasoning?: (chunk: string) => void;
  abortSignal?: AbortSignal;
  settingsContext?: string;
  tools?: ToolSet;
  toolChoice?: "auto" | "none" | "required";
  stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>;
  onToolEvent?: (event: StreamToolEvent) => void;
}

export interface StreamContinuationOptions {
  settings: AiSettings;
  context: string;
  onChunk: (chunk: string) => void;
  onReasoning?: (chunk: string) => void;
  abortSignal?: AbortSignal;
  settingsContext?: string;
  // 直前本文の登場人物の過去場面抜粋(文字列照合+全文検索インデックスのみで生成。LLM呼び出しなし)
  relatedScenes?: string;
  tools?: ToolSet;
  onToolEvent?: (event: StreamToolEvent) => void;
  onStage?: (stage: "plan" | "draft" | "review" | "revise") => void;
  // 判断系工程(構想・査読・選定・カード)で使う設定を解決する。
  // 呼び出し側(main.ts)が役割プロファイル・オーバーライドの解決を担う。
  getJudgmentSettings?: () => AiSettings;
  // 文体指紋(機械計測)。呼び出し側で現エピソード全文等から計測して渡す。
  styleFingerprint?: FictionPromptExtras["styleFingerprint"];
  // 場面ステートカード・話し方カードのキャッシュキーに使うエピソードID
  episodeId?: string;
  // 話し方カード(提案7)の対象人物名と、その根拠となる原稿抜粋(文字列照合+検索のみで生成。LLM呼び出しなし)
  characterVoiceInput?: { names: string[]; excerpts: string };
}

export interface StreamRewriteOptions {
  settings: AiSettings;
  selection: string;
  context: string;
  onChunk: (chunk: string) => void;
  onReasoning?: (chunk: string) => void;
  abortSignal?: AbortSignal;
  settingsContext?: string;
}

export interface StreamFeedbackOptions {
  settings: AiSettings;
  selection: string;
  onChunk: (chunk: string) => void;
  onReasoning?: (chunk: string) => void;
  abortSignal?: AbortSignal;
  settingsContext?: string;
}

async function verifyToolCallNeed(
  settings: AiSettings,
  userRequest: string,
  assistantResponse: string,
  availableToolNames: string[],
  abortSignal?: AbortSignal,
): Promise<boolean> {
  // 非クリティカルな検証呼び出しは長時間待たない。
  // debugFetch のリトライ（最長71秒）を打ち切り、ユーザー体験をブロックしない。
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  if (abortSignal) {
    if (abortSignal.aborted) {
      controller.abort();
    } else {
      abortSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }
  try {
    // generateObject は response_format: json_schema を自動付与するが、
    // OpenCode Go 上流（DeepSeek）が json_schema + strict を処理できず 400 になる。
    // そのため generateText で通常チャットを行い、レスポンスをクライアント側で Zod 検証する。
    const basePrompt = buildToolCallNeedPrompt(userRequest, assistantResponse, availableToolNames);
    const jsonPrompt = `${basePrompt}\n\nReturn ONLY a valid JSON object with this exact shape. No markdown, no code fence, no explanation:\n{"needsTools": boolean, "missingTools": string[], "reason": string}\nIf missingTools is unnecessary, omit it or use an empty array.`;
    const result = await generateText({
      model: createModel(settings),
      ...buildRetryOption(settings),
      system:
        "You audit assistant responses. Decide one thing: did the request require an actual tool call that the assistant failed to perform? Return ONLY a JSON object. IF uncertain → set needsTools=false.",
      prompt: jsonPrompt,
      maxOutputTokens: 1024,
      temperature: 0.1,
      abortSignal: controller.signal,
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text);
    } catch (error) {
      console.error("[litra:ai] tool-call need JSON parse failed:", error, "raw:", result.text.slice(0, 200));
      return false;
    }
    const validated = toolCallNeedSchema.safeParse(parsed);
    if (!validated.success) {
      console.error("[litra:ai] tool-call need schema validation failed:", validated.error);
      return false;
    }
    console.log("[litra:ai] tool-call need check:", validated.data);
    return validated.data.needsTools;
  } catch (error) {
    console.error("[litra:ai] tool-call need verification failed:", error);
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

function getLastUserMessageContent(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user") {
      return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    }
  }
  return "";
}

function normalizeSettings(settings: AiSettings): AiSettings {
  const normalized = { ...settings };

  normalized.apiKey = trimmedString(normalized.apiKey);
  normalized.baseUrl = trimmedString(normalized.baseUrl);
  normalized.model = trimmedString(normalized.model);

  if (!isFiniteNumber(normalized.temperature) || normalized.temperature < 0 || normalized.temperature > 2) {
    console.warn(`[litra:ai] invalid temperature ${normalized.temperature}, falling back to 0.7`);
    normalized.temperature = 0.7;
  }

  if (!isFiniteNumber(normalized.maxTokens) || normalized.maxTokens <= 0) {
    console.warn(`[litra:ai] invalid maxTokens ${normalized.maxTokens}, falling back to 8192`);
    normalized.maxTokens = 8192;
  } else {
    normalized.maxTokens = Math.floor(normalized.maxTokens);
  }

  if (!isFiniteNumber(normalized.maxContextTokens) || normalized.maxContextTokens <= 0) {
    console.warn(`[litra:ai] invalid maxContextTokens ${normalized.maxContextTokens}, falling back to 65536`);
    normalized.maxContextTokens = 65536;
  } else {
    normalized.maxContextTokens = Math.floor(normalized.maxContextTokens);
  }

  normalized.topP = normalizeOptionalRange(normalized.topP, 0, 1);
  normalized.topK = isFiniteNumber(normalized.topK) && normalized.topK >= 1 ? Math.floor(normalized.topK) : undefined;
  normalized.frequencyPenalty = normalizeOptionalRange(normalized.frequencyPenalty, -2, 2);
  normalized.presencePenalty = normalizeOptionalRange(normalized.presencePenalty, -2, 2);
  normalized.anthropicThinkingBudget =
    isFiniteNumber(normalized.anthropicThinkingBudget) && normalized.anthropicThinkingBudget > 0
      ? Math.floor(normalized.anthropicThinkingBudget)
      : undefined;
  if (normalized.anthropicThinkingEnabled && normalized.anthropicThinkingBudget === undefined) {
    normalized.anthropicThinkingBudget = DEFAULT_ANTHROPIC_THINKING_BUDGET;
  }

  return normalized;
}

export async function streamChat({
  settings,
  messages,
  onChunk,
  abortSignal,
  settingsContext,
  tools,
  toolChoice,
  stopWhen,
  onToolEvent,
  onReasoning,
}: StreamChatOptions): Promise<StreamRunResult> {
  try {
    const s = normalizeSettings(settings);
    const toolsEnabled = hasTools(tools);
    let assistantText = "";
    const wrappedOnChunk = (chunk: string) => {
      assistantText += chunk;
      onChunk(chunk);
    };
    const toolNames = toolsEnabled ? Object.keys(tools) : [];

    const result = streamText<ToolSet>({
      model: createModel(s),
      ...buildRetryOption(s),
      system: buildAssistantSystemPrompt({ settingsContext, toolsEnabled, toolNames }),
      messages,
      ...buildTemperatureOption(s, toolsEnabled),
      maxOutputTokens: s.maxTokens,
      abortSignal,
      tools,
      toolChoice: toolsEnabled ? toolChoice : undefined,
      stopWhen: toolsEnabled ? toolLoopStopConditions(stopWhen) : stopWhen,
      ...buildAdvancedOptions(s, toolsEnabled),
    });

    const runResult = await consumeStream(result, wrappedOnChunk, onToolEvent, onReasoning);

    // ツールが有効なのにツール呼び出しがなく、かつ通常終了した場合は検証する
    if (
      toolsEnabled &&
      s.provider !== "sakura" &&
      runResult.toolCallCount === 0 &&
      runResult.finishReason !== "tool-calls" &&
      !abortSignal?.aborted
    ) {
      const userRequest = getLastUserMessageContent(messages);
      const needsTools = await verifyToolCallNeed(s, userRequest, assistantText, toolNames, abortSignal);
      if (needsTools) {
        console.log("[litra:ai] retrying with tool-call requirement");
        const retryMessages: ModelMessage[] = [
          ...messages,
          { role: "assistant", content: assistantText },
          {
            role: "user",
            content:
              "まだ必要なツールを呼び出していないようです。先にツールを呼び出してから、必要であれば説明を続けてください。",
          },
        ];
        const retryResult = streamText<ToolSet>({
          model: createModel(s),
          ...buildRetryOption(s),
          system: buildAssistantSystemPrompt({ settingsContext, toolsEnabled: true, toolNames }),
          messages: retryMessages,
          ...buildTemperatureOption(s, toolsEnabled),
          maxOutputTokens: s.maxTokens,
          abortSignal,
          tools,
          toolChoice: s.provider === "opencode" ? undefined : "required",
          stopWhen: toolLoopStopConditions(isLoopFinished() as StopCondition<ToolSet>),
          ...buildAdvancedOptions(s, toolsEnabled),
        });
        return await consumeStream(retryResult, onChunk, onToolEvent, onReasoning);
      }
    }

    return runResult;
  } catch (error) {
    console.error("streamChat error:", error);
    throw error;
  }
}

/**
 * 続き生成の前に、非表示の構想ステップ(non-streaming)を1回実行する。
 * 弱いモデルほど安易・平坦な続きを選びがちなため、執筆前に展開案を
 * 検討・選択させ、その方針メモを執筆プロンプトへ注入する。
 * 構想ステップ自体が失敗しても続き生成全体を失敗させてはならないため、
 * 例外・空文字はここで吸収し、呼び出し側には undefined を返す(1段生成へフォールバック)。
 */
async function runContinuationPlanStep(
  settings: AiSettings,
  context: string,
  settingsContext: string | undefined,
  relatedScenes: string | undefined,
  abortSignal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const result = await generateText({
      model: createModel(settings),
      ...buildRetryOption(settings),
      prompt: buildContinuationPlanPrompt(context, settingsContext, relatedScenes),
      ...buildTemperatureOption(settings, false),
      // thinking 系モデルでは推論トークンもこの上限を消費するため、
      // 構想の深さを絞らないよう本体生成と同じ上限を使う。
      maxOutputTokens: settings.maxTokens,
      abortSignal,
      ...buildAdvancedOptions(settings, false),
    });

    const planText = result.text.trim();
    if (!planText) return undefined;
    console.log("[litra] continuation plan:", planText);
    return planText;
  } catch (error) {
    // ユーザーによる中断はフォールバックせず、そのまま中断として伝播させる。
    if (abortSignal?.aborted) throw error;
    console.warn("[litra] continuation plan step failed; falling back to single-stage", error);
    return undefined;
  }
}

/**
 * 続き生成のドラフトを査読するレビューステップ(non-streaming)。
 * 失敗してもドラフト採用にフォールバックするため、例外・空文字はここで
 * 吸収して undefined を返す(中断だけは伝播)。
 */
async function runContinuationReviewStep(
  settings: AiSettings,
  draft: string,
  context: string,
  settingsContext: string | undefined,
  plan: string | undefined,
  relatedScenes: string | undefined,
  abortSignal?: AbortSignal,
  extras?: FictionPromptExtras,
): Promise<string | undefined> {
  try {
    const result = await generateText({
      model: createModel(settings),
      ...buildRetryOption(settings),
      prompt: buildContinuationReviewPrompt(draft, context, settingsContext, plan, relatedScenes, extras),
      ...buildTemperatureOption(settings, false),
      // thinking 系モデルでは推論トークンもこの上限を消費するため、
      // 査読の深さを絞らないよう本体生成と同じ上限を使う。
      maxOutputTokens: settings.maxTokens,
      abortSignal,
      ...buildAdvancedOptions(settings, false),
    });

    const reviewText = result.text.trim();
    if (!reviewText) return undefined;
    console.log("[litra] continuation review:", reviewText);
    return reviewText;
  } catch (error) {
    if (abortSignal?.aborted) throw error;
    console.warn("[litra] continuation review step failed; using draft as-is", error);
    return undefined;
  }
}

// 軽量なハッシュ(暗号強度は不要。キャッシュキーの衝突を減らせれば十分)
function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return `${text.length}:${hash}`;
}

interface CachedCard {
  hash: string;
  card: string;
}

// エピソードID(無ければ固定キー)+直前本文末尾のハッシュをキーにキャッシュする。
// 本文が変わらない限り再生成せず、バックグラウンドモデル呼び出しを節約する。
const sceneStateCardCache = new Map<string, CachedCard>();
const characterVoiceCardCache = new Map<string, CachedCard>();

/**
 * 場面ステートカード(提案6)。バックグラウンドモデルで直前本文から場面の状態を整理する。
 * 失敗してもカード無しで続行するため、例外・空文字はここで吸収して undefined を返す(中断だけは伝播)。
 */
async function runSceneStateCardStep(
  settings: AiSettings,
  context: string,
  settingsContext: string | undefined,
  cacheKey: string,
  abortSignal?: AbortSignal,
): Promise<string | undefined> {
  const hash = hashText(context.slice(-2000));
  const cached = sceneStateCardCache.get(cacheKey);
  if (cached && cached.hash === hash) return cached.card;

  try {
    const result = await generateText({
      model: createModel(settings),
      ...buildRetryOption(settings),
      prompt: buildSceneStateCardPrompt(context, settingsContext),
      ...buildTemperatureOption(settings, false),
      maxOutputTokens: settings.maxTokens,
      abortSignal,
      ...buildAdvancedOptions(settings, false),
    });
    const card = result.text.trim();
    if (!card) return undefined;
    sceneStateCardCache.set(cacheKey, { hash, card });
    console.log("[litra] scene state card:", card);
    return card;
  } catch (error) {
    if (abortSignal?.aborted) throw error;
    console.warn("[litra] scene state card step failed; continuing without it", error);
    return undefined;
  }
}

/**
 * 話し方カード(提案7)。バックグラウンドモデルで対象人物の一人称・口調等を抽出する。
 * 失敗してもカード無しで続行するため、例外・空文字はここで吸収して undefined を返す(中断だけは伝播)。
 */
async function runCharacterVoiceCardsStep(
  settings: AiSettings,
  names: string[],
  excerpts: string,
  settingsContext: string | undefined,
  cacheKey: string,
  abortSignal?: AbortSignal,
): Promise<string | undefined> {
  const hash = hashText(`${names.join(",")}\n${excerpts}`);
  const cached = characterVoiceCardCache.get(cacheKey);
  if (cached && cached.hash === hash) return cached.card;

  try {
    const result = await generateText({
      model: createModel(settings),
      ...buildRetryOption(settings),
      prompt: buildCharacterVoiceCardsPrompt(names, excerpts, settingsContext),
      ...buildTemperatureOption(settings, false),
      maxOutputTokens: settings.maxTokens,
      abortSignal,
      ...buildAdvancedOptions(settings, false),
    });
    const card = result.text.trim();
    if (!card) return undefined;
    characterVoiceCardCache.set(cacheKey, { hash, card });
    console.log("[litra] character voice cards:", card);
    return card;
  } catch (error) {
    if (abortSignal?.aborted) throw error;
    console.warn("[litra] character voice cards step failed; continuing without it", error);
    return undefined;
  }
}

/**
 * 候補ドラフト2案の選定ステップ(non-streaming)。
 * 失敗・パース不能時は undefined を返し、呼び出し側で案1を採用させる(中断だけは伝播)。
 */
async function runDraftSelectionStep(
  settings: AiSettings,
  drafts: string[],
  context: string,
  settingsContext: string | undefined,
  plan: string | undefined,
  abortSignal?: AbortSignal,
  scaffold?: PromptScaffoldLevel,
): Promise<number | undefined> {
  try {
    const result = await generateText({
      model: createModel(settings),
      ...buildRetryOption(settings),
      prompt: buildDraftSelectionPrompt(drafts, context, settingsContext, plan, scaffold),
      ...buildTemperatureOption(settings, false),
      maxOutputTokens: settings.maxTokens,
      abortSignal,
      ...buildAdvancedOptions(settings, false),
    });

    const text = result.text.trim();
    if (!text) return undefined;
    console.log("[litra] draft selection:", text);
    return parseDraftSelection(text, drafts.length);
  } catch (error) {
    if (abortSignal?.aborted) throw error;
    console.warn("[litra] draft selection step failed; using first draft", error);
    return undefined;
  }
}

/**
 * 置換指示をドラフトへ適用する。各置換は draft.indexOf で一意性を確認し、
 * 見つからない・複数箇所に出現・既に適用した範囲と重複する場合は個別に捨てる。
 */
function applyTargetedReplacements(
  draft: string,
  replacements: Array<{ target: string; replacement: string }>,
): { text: string; appliedCount: number } {
  const applied: Array<{ start: number; end: number; replacement: string }> = [];

  for (const { target, replacement } of replacements) {
    if (!target) continue;
    const firstIndex = draft.indexOf(target);
    if (firstIndex === -1) continue; // 見つからない
    const secondIndex = draft.indexOf(target, firstIndex + 1);
    if (secondIndex !== -1) continue; // 2箇所以上に出現 → 一意でないので捨てる
    const start = firstIndex;
    const end = firstIndex + target.length;
    if (applied.some((a) => start < a.end && end > a.start)) continue; // 範囲の重複 → 捨てる
    applied.push({ start, end, replacement });
  }

  if (applied.length === 0) return { text: draft, appliedCount: 0 };

  applied.sort((a, b) => a.start - b.start);
  let result = "";
  let cursor = 0;
  for (const a of applied) {
    result += draft.slice(cursor, a.start);
    result += a.replacement;
    cursor = a.end;
  }
  result += draft.slice(cursor);
  return { text: result, appliedCount: applied.length };
}

/**
 * スパン限定修正(提案5)。査読の指摘外の文を物理的に保護したまま修正する代替モード。
 * パース不能・全置換が不採用(全滅)の場合は undefined を返し、呼び出し側で
 * 全文修正(buildContinuationRevisionPrompt)へフォールバックさせる(中断だけは伝播)。
 */
async function runTargetedRevisionStep(
  settings: AiSettings,
  draft: string,
  review: string,
  context: string,
  settingsContext: string | undefined,
  extras: FictionPromptExtras | undefined,
  abortSignal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const result = await generateText({
      model: createModel(settings),
      ...buildRetryOption(settings),
      prompt: buildTargetedRevisionPrompt(draft, review, context, settingsContext, extras),
      ...buildTemperatureOption(settings, false),
      maxOutputTokens: settings.maxTokens,
      abortSignal,
      ...buildAdvancedOptions(settings, false),
    });

    const text = result.text.trim();
    if (!text) return undefined;
    const replacements = parseTargetedRevision(text);
    if (replacements === undefined) return undefined; // 崩れた出力 → フォールバック
    if (replacements.length === 0) {
      console.log("[litra] targeted revision: no replacements needed");
      return draft; // 【置換なし】
    }

    const { text: revised, appliedCount } = applyTargetedReplacements(draft, replacements);
    if (appliedCount === 0) return undefined; // 全滅 → フォールバック
    console.log(`[litra] targeted revision applied ${appliedCount}/${replacements.length} replacements`);
    return revised;
  } catch (error) {
    if (abortSignal?.aborted) throw error;
    console.warn("[litra] targeted revision step failed; falling back to full revision", error);
    return undefined;
  }
}

export async function streamContinuation({
  settings,
  context,
  onChunk,
  abortSignal,
  settingsContext,
  relatedScenes,
  tools,
  onToolEvent,
  onReasoning,
  onStage,
  getJudgmentSettings,
  styleFingerprint,
  episodeId,
  characterVoiceInput,
}: StreamContinuationOptions): Promise<StreamRunResult> {
  try {
    const s = normalizeSettings(settings);
    const toolsEnabled = hasTools(tools);
    const toolNames = toolsEnabled ? Object.keys(tools) : [];
    // 執筆系の足場レベルを extras 経由でドラフト・修正系プロンプトへ伝える。
    let extras: FictionPromptExtras | undefined = s.promptScaffold
      ? { promptScaffold: s.promptScaffold }
      : undefined;
    if (styleFingerprint) extras = { ...extras, styleFingerprint };

    // 構想・レビューは出力が短く「判断」寄りの工程のため、判断系モデルに振る。
    // source の判定(本文/バックグラウンド/カスタム)は main.ts 側が担う。
    const judgmentSettings = getJudgmentSettings ? normalizeSettings(getJudgmentSettings()) : s;

    const cacheKeyBase = episodeId ?? "__no_episode__";

    if (s.continuationSceneStateEnabled) {
      const sceneState = await runSceneStateCardStep(judgmentSettings, context, settingsContext, cacheKeyBase, abortSignal);
      if (sceneState) extras = { ...extras, sceneState };
    }

    if (s.continuationCharacterVoiceEnabled && characterVoiceInput && characterVoiceInput.names.length > 0) {
      const characterVoiceCards = await runCharacterVoiceCardsStep(
        judgmentSettings,
        characterVoiceInput.names,
        characterVoiceInput.excerpts,
        settingsContext,
        cacheKeyBase,
        abortSignal,
      );
      if (characterVoiceCards) extras = { ...extras, characterVoiceCards };
    }

    if (s.twoStageContinuation) onStage?.("plan");
    const plan = s.twoStageContinuation
      ? await runContinuationPlanStep(judgmentSettings, context, settingsContext, relatedScenes, abortSignal)
      : undefined;

    onStage?.("draft");
    const reviewEnabled = s.continuationReviewEnabled === true;
    const bestOfTwo = s.continuationBestOfTwo === true;

    // 設定資料は system ではなく本文プロンプト側に注入する(弱いモデルの recency 対策)
    const runDraftGeneration = async (
      draftContext: string,
      draftExtras: FictionPromptExtras | undefined,
      onDraftChunk: (chunk: string) => void,
    ): Promise<{ text: string; run: StreamRunResult }> => {
      const draftResult = streamText<ToolSet>({
        model: createModel(s),
        ...buildRetryOption(s),
        system: buildAssistantSystemPrompt({ toolsEnabled, toolNames }),
        prompt: buildContinuationPrompt(draftContext, settingsContext, plan, relatedScenes, draftExtras),
        ...buildTemperatureOption(s, toolsEnabled),
        maxOutputTokens: s.maxTokens,
        abortSignal,
        tools,
        stopWhen: toolsEnabled ? toolLoopStopConditions() : undefined,
        ...buildAdvancedOptions(s, toolsEnabled),
      });
      let text = "";
      const run = await consumeStream(
        draftResult,
        (chunk) => {
          text += chunk;
          onDraftChunk(chunk);
        },
        onToolEvent,
        onReasoning,
      );
      return { text, run };
    };

    const noop = (_chunk: string): void => {};
    const mergeToolStats = (a: StreamRunResult, b: StreamRunResult): StreamRunResult => ({
      ...a,
      toolCallCount: a.toolCallCount + b.toolCallCount,
      toolResultCount: a.toolResultCount + b.toolResultCount,
      toolErrorCount: a.toolErrorCount + b.toolErrorCount,
    });

    let draftText: string;
    let draftRun: StreamRunResult;

    if (bestOfTwo) {
      // 候補2案は選定が決まるまでエディタへ流さず、両方バッファする。
      const candidateA = await runDraftGeneration(context, extras, noop);
      const candidateB = await runDraftGeneration(context, extras, noop);
      const candidates = [candidateA, candidateB];
      const selectedIndex = await runDraftSelectionStep(
        judgmentSettings,
        candidates.map((c) => c.text),
        context,
        settingsContext,
        plan,
        abortSignal,
        judgmentSettings.promptScaffold,
      );
      const chosen = candidates[selectedIndex ?? 0] ?? candidateA;
      draftText = chosen.text;
      draftRun = {
        ...chosen.run,
        toolCallCount: candidateA.run.toolCallCount + candidateB.run.toolCallCount,
        toolResultCount: candidateA.run.toolResultCount + candidateB.run.toolResultCount,
        toolErrorCount: candidateA.run.toolErrorCount + candidateB.run.toolErrorCount,
      };
      if (!reviewEnabled) {
        onChunk(draftText);
        return draftRun;
      }
    } else {
      // レビューON・ビート分割時はドラフトをエディタへ直接流さず、いったんバッファへ溜める
      // (レビューで修正が必要と判定された場合は破棄し、修正稿だけを流すため)。
      const emit = reviewEnabled ? noop : onChunk;
      const beats = s.continuationBeatSplitEnabled && plan ? parsePlanBeats(plan) : [];

      if (beats.length >= 2) {
        // ビート分割生成: 各ビートを順に生成し、前ビートの生成分を文脈に継ぎ足す。
        // 途中のビートで失敗した場合、それまでの分は emit 済みなので維持し、エラーは伝播する。
        let cumulativeContext = context;
        let combinedText = "";
        let combinedRun: StreamRunResult | undefined;
        for (let i = 0; i < beats.length; i++) {
          const beatExtras: FictionPromptExtras = {
            ...extras,
            beatDirective: { beat: beats[i], index: i + 1, total: beats.length },
          };
          const beatResult = await runDraftGeneration(cumulativeContext, beatExtras, emit);
          combinedText += beatResult.text;
          cumulativeContext = limitPromptText(`${cumulativeContext}${beatResult.text}`, BEAT_CONTEXT_CHAR_BUDGET, "tail");
          combinedRun = combinedRun ? mergeToolStats(combinedRun, beatResult.run) : beatResult.run;
        }
        draftText = combinedText;
        draftRun = combinedRun!;
      } else {
        const single = await runDraftGeneration(context, extras, emit);
        draftText = single.text;
        draftRun = single.run;
      }
      if (!reviewEnabled) return draftRun;
    }

    if (!draftText.trim()) return draftRun; // ドラフトが空なら何もしない(フォールバックする本文が無い)

    // 決定論的な機械検査(提案4)。LLM を使わず判断はコード側で完結させる。
    draftText = sanitizeDraftText(draftText);
    let checks = checkDraft(draftText, context);
    if (checks.hard.length > 0) {
      console.warn("[litra] draft check found hard violations; retrying draft once", checks.hard);
      const retry = await runDraftGeneration(context, { ...extras, mechanicalFindings: checks.hard }, noop);
      if (retry.text.trim()) {
        draftText = sanitizeDraftText(retry.text);
        draftRun = {
          ...retry.run,
          toolCallCount: retry.run.toolCallCount + draftRun.toolCallCount,
          toolResultCount: retry.run.toolResultCount + draftRun.toolResultCount,
          toolErrorCount: retry.run.toolErrorCount + draftRun.toolErrorCount,
        };
        // 無限リトライを避けるため2回目はチェックし直すだけで、違反が残っても軽違反として査読へ回す
        checks = checkDraft(draftText, context);
      }
    }
    const mechanicalFindings = [...checks.hard, ...checks.soft];

    onStage?.("review");
    let review = await runContinuationReviewStep(
      judgmentSettings,
      draftText,
      context,
      settingsContext,
      plan,
      relatedScenes,
      abortSignal,
      { ...extras, promptScaffold: judgmentSettings.promptScaffold },
    );
    if (mechanicalFindings.length > 0) {
      const mechanicalBlock = formatMechanicalFindingsForReview(mechanicalFindings);
      review = review ? `${review}\n\n${mechanicalBlock}` : mechanicalBlock;
    }
    const needsRevision = mechanicalFindings.length > 0 || (review !== undefined && reviewRequiresRevision(review));
    if (!review || !needsRevision) {
      onChunk(draftText); // レビュー失敗 or 問題なし → ドラフトをそのまま一括出力
      return draftRun;
    }

    onStage?.("revise");

    if (s.continuationTargetedRevision) {
      const targeted = await runTargetedRevisionStep(s, draftText, review, context, settingsContext, extras, abortSignal);
      if (targeted !== undefined) {
        onChunk(targeted);
        return draftRun;
      }
      // undefined → 崩れた出力 or 全滅。以下の全文修正へフォールバックする。
    }

    let emittedRevisionChunks = 0;
    try {
      const revisionResult = streamText<ToolSet>({
        model: createModel(s),
        ...buildRetryOption(s),
        system: buildAssistantSystemPrompt({ toolsEnabled: false }),
        prompt: buildContinuationRevisionPrompt(draftText, review, context, settingsContext, relatedScenes, extras),
        ...buildTemperatureOption(s, false),
        maxOutputTokens: s.maxTokens,
        abortSignal,
        ...buildAdvancedOptions(s, false),
      });
      const revisionRun = await consumeStream(
        revisionResult,
        (chunk) => {
          emittedRevisionChunks += 1;
          onChunk(chunk);
        },
        undefined,
        onReasoning,
      );
      // main.ts の finalizeToolRun がツール実行数を表示に使うため、
      // ドラフト段のツール集計を最終 run に引き継ぐ
      return {
        ...revisionRun,
        toolCallCount: revisionRun.toolCallCount + draftRun.toolCallCount,
        toolResultCount: revisionRun.toolResultCount + draftRun.toolResultCount,
        toolErrorCount: revisionRun.toolErrorCount + draftRun.toolErrorCount,
      };
    } catch (error) {
      if (abortSignal?.aborted) throw error;
      if (emittedRevisionChunks === 0) {
        // 1文字も流れる前の失敗はドラフト採用にフォールバック
        console.warn("[litra] continuation revision step failed; using draft as-is", error);
        onChunk(draftText);
        return draftRun;
      }
      throw error; // 途中まで流れた失敗は現行どおり伝播
    }
  } catch (error) {
    console.error("streamContinuation error:", error);
    throw error;
  }
}

export async function streamRewrite({
  settings,
  selection,
  context,
  onChunk,
  abortSignal,
  settingsContext,
  onReasoning,
}: StreamRewriteOptions): Promise<StreamRunResult> {
  try {
    const s = normalizeSettings(settings);
    const result = streamText<ToolSet>({
      model: createModel(s),
      ...buildRetryOption(s),
      system: buildAssistantSystemPrompt({ toolsEnabled: false }),
      prompt: buildRewritePrompt(selection, context, settingsContext, s.promptScaffold),
      ...buildTemperatureOption(s, false),
      maxOutputTokens: s.maxTokens,
      abortSignal,
      ...buildAdvancedOptions(s, false),
    });

    return await consumeStream(result, onChunk, undefined, onReasoning);
  } catch (error) {
    console.error("streamRewrite error:", error);
    throw error;
  }
}

export async function streamFeedback({
  settings,
  selection,
  onChunk,
  abortSignal,
  settingsContext,
  onReasoning,
}: StreamFeedbackOptions): Promise<StreamRunResult> {
  try {
    const s = normalizeSettings(settings);
    const result = streamText<ToolSet>({
      model: createModel(s),
      ...buildRetryOption(s),
      system: buildAssistantSystemPrompt({ toolsEnabled: false }),
      prompt: buildFeedbackPrompt(selection, settingsContext),
      ...buildTemperatureOption(s, false),
      maxOutputTokens: s.maxTokens,
      abortSignal,
      ...buildAdvancedOptions(s, false),
    });

    return await consumeStream(result, onChunk, undefined, onReasoning);
  } catch (error) {
    console.error("streamFeedback error:", error);
    throw error;
  }
}
