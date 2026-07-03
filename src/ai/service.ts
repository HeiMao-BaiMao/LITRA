import { generateObject, isLoopFinished, stepCountIs, streamText, type ModelMessage, type StopCondition, type TextStreamPart, type ToolSet } from "ai";
import { createModel } from "./provider.ts";
import { buildProviderOptions } from "./provider-options.ts";
import {
  buildAssistantSystemPrompt,
  buildContinuationPrompt,
  buildFeedbackPrompt,
  buildRewritePrompt,
  buildToolCallNeedPrompt,
  toolCallNeedSchema,
} from "./prompts.ts";
import type { AiSettings } from "../settings.ts";

const DEFAULT_ANTHROPIC_THINKING_BUDGET = 8000;
const TOOL_LOOP_MAX_STEPS = 16;
const DUPLICATE_TOOL_CALL_INPUT_LIMIT = 4;

function isDeepSeekThinkingEnabled(settings: AiSettings, toolsEnabled: boolean): boolean {
  // DeepSeek の thinking モードはツール呼び出しと両立しない。
  // ツールを使う場合は thinking を無効にし、サンプリングパラメータを有効にする。
  return settings.provider === "deepseek" && !toolsEnabled;
}

function buildTemperatureOption(settings: AiSettings, toolsEnabled = false) {
  // DeepSeek の thinking モードでは temperature は無視される。
  return isDeepSeekThinkingEnabled(settings, toolsEnabled) ? {} : { temperature: settings.temperature };
}

function buildAdvancedOptions(settings: AiSettings, toolsEnabled = false) {
  const providerOptions = buildProviderOptions(settings, toolsEnabled);
  const ignoreSampling = isDeepSeekThinkingEnabled(settings, toolsEnabled);
  const ignorePenalty = settings.provider === "sakura";
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
  tools?: ToolSet;
  onToolEvent?: (event: StreamToolEvent) => void;
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
): Promise<boolean> {
  try {
    const result = await generateObject({
      model: createModel(settings),
      schema: toolCallNeedSchema,
      system:
        "You audit assistant responses. Decide one thing: did the request require an actual tool call that the assistant failed to perform? Return ONLY a JSON object that follows the schema exactly. IF uncertain → set needsTools=false.",
      prompt: buildToolCallNeedPrompt(userRequest, assistantResponse, availableToolNames),
      maxOutputTokens: 1024,
      temperature: 0.1,
    });
    console.log("[litra:ai] tool-call need check:", result.object);
    return result.object.needsTools;
  } catch (error) {
    console.error("[litra:ai] tool-call need verification failed:", error);
    return false;
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
      const needsTools = await verifyToolCallNeed(s, userRequest, assistantText, toolNames);
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
          system: buildAssistantSystemPrompt({ settingsContext, toolsEnabled: true, toolNames }),
          messages: retryMessages,
          ...buildTemperatureOption(s, toolsEnabled),
          maxOutputTokens: s.maxTokens,
          abortSignal,
          tools,
          toolChoice: "required",
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

export async function streamContinuation({
  settings,
  context,
  onChunk,
  abortSignal,
  settingsContext,
  tools,
  onToolEvent,
  onReasoning,
}: StreamContinuationOptions): Promise<StreamRunResult> {
  try {
    const s = normalizeSettings(settings);
    const toolsEnabled = hasTools(tools);
    const toolNames = toolsEnabled ? Object.keys(tools) : [];

    // 設定資料は system ではなく本文プロンプト側に注入する(弱いモデルの recency 対策)
    const result = streamText<ToolSet>({
      model: createModel(s),
      system: buildAssistantSystemPrompt({ toolsEnabled, toolNames }),
      prompt: buildContinuationPrompt(context, settingsContext),
      ...buildTemperatureOption(s, toolsEnabled),
      maxOutputTokens: s.maxTokens,
      abortSignal,
      tools,
      stopWhen: toolsEnabled ? toolLoopStopConditions() : undefined,
      ...buildAdvancedOptions(s, toolsEnabled),
    });

    return await consumeStream(result, onChunk, onToolEvent, onReasoning);
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
      system: buildAssistantSystemPrompt({ toolsEnabled: false }),
      prompt: buildRewritePrompt(selection, context, settingsContext),
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
