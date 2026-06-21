import { isLoopFinished, streamText, type ModelMessage, type TextStreamPart, type ToolSet } from "ai";
import { createModel } from "./provider.ts";
import { buildProviderOptions } from "./provider-options.ts";
import {
  buildContinuationPrompt,
  buildFeedbackPrompt,
  buildRewritePrompt,
  systemPrompt,
} from "./prompts.ts";
import type { AiSettings } from "../settings.ts";

const DEFAULT_ANTHROPIC_THINKING_BUDGET = 8000;
function buildSystem(basePrompt: string, settingsContext?: string): string {
  if (!settingsContext) return basePrompt;
  return `${basePrompt}\n\n以下は本作の設定資料です。本文やフィードバックに矛盾がないよう参照してください。\n\n${settingsContext}`;
}

function buildAdvancedOptions(settings: AiSettings) {
  const providerOptions = buildProviderOptions(settings);
  return {
    ...(settings.topP !== undefined && { topP: settings.topP }),
    ...(settings.topK !== undefined && { topK: settings.topK }),
    ...(settings.frequencyPenalty !== undefined && {
      frequencyPenalty: settings.frequencyPenalty,
    }),
    ...(settings.presencePenalty !== undefined && {
      presencePenalty: settings.presencePenalty,
    }),
    ...(providerOptions && { providerOptions }),
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
  toolCallCount: number;
  toolResultCount: number;
  toolErrorCount: number;
  finishReason?: string;
  stoppedAfterToolResult: boolean;
  stoppedAfterToolActivity: boolean;
  pendingToolCallIds: string[];
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

async function consumeStream(
  result: {
    fullStream: AsyncIterable<TextStreamPart<ToolSet>>;
  },
  onChunk: (chunk: string) => void,
  onToolEvent?: (event: StreamToolEvent) => void,
): Promise<StreamRunResult> {
  let chunkCount = 0;
  let charCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let toolErrorCount = 0;
  let finishReason: string | undefined;
  let lastSignificantPart: "text" | "tool-input" | "tool-call" | "tool-result" | "tool-error" | undefined;
  const pendingToolCallIds = new Set<string>();

  for await (const part of result.fullStream) {
    switch (part.type) {
      case "text-delta": {
        const chunk = part.text;
        if (!chunk) break;
        chunkCount++;
        charCount += chunk.length;
        lastSignificantPart = "text";
        if (chunkCount <= 3 || chunkCount % 10 === 0) {
          console.log(`[phenex:ai] text chunk #${chunkCount}:`, chunk.slice(0, 80));
        }
        onChunk(chunk);
        break;
      }
      case "tool-input-start": {
        lastSignificantPart = "tool-input";
        pendingToolCallIds.add(part.id);
        console.log(`[phenex:ai] tool input start: ${part.toolName}`);
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
        console.log(`[phenex:ai] tool call: ${part.toolName}`, part.input);
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
        console.log(`[phenex:ai] tool result: ${part.toolName}`, part.input);
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
        console.error(`[phenex:ai] tool error: ${part.toolName}`, part.error);
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
      case "error": {
        throw part.error;
      }
    }
  }

  console.log(`[phenex:ai] stream finished. text chunks: ${chunkCount}, tool results: ${toolResultCount}, finish: ${finishReason ?? "unknown"}`);
  return {
    textChunkCount: chunkCount,
    textCharCount: charCount,
    toolCallCount,
    toolResultCount,
    toolErrorCount,
    finishReason,
    stoppedAfterToolResult: lastSignificantPart === "tool-result" || lastSignificantPart === "tool-error",
    stoppedAfterToolActivity:
      lastSignificantPart === "tool-input" ||
      lastSignificantPart === "tool-call" ||
      lastSignificantPart === "tool-result" ||
      lastSignificantPart === "tool-error",
    pendingToolCallIds: [...pendingToolCallIds],
  };
}

export interface StreamChatOptions {
  settings: AiSettings;
  messages: ModelMessage[];
  onChunk: (chunk: string) => void;
  abortSignal?: AbortSignal;
  settingsContext?: string;
  tools?: ToolSet;
  onToolEvent?: (event: StreamToolEvent) => void;
}

export interface StreamContinuationOptions {
  settings: AiSettings;
  context: string;
  onChunk: (chunk: string) => void;
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
  abortSignal?: AbortSignal;
  settingsContext?: string;
}

export interface StreamFeedbackOptions {
  settings: AiSettings;
  selection: string;
  onChunk: (chunk: string) => void;
  abortSignal?: AbortSignal;
  settingsContext?: string;
}

function normalizeSettings(settings: AiSettings): AiSettings {
  const normalized = { ...settings };

  normalized.apiKey = normalized.apiKey.trim();
  normalized.baseUrl = normalized.baseUrl.trim();
  normalized.model = normalized.model.trim();

  if (!isFiniteNumber(normalized.temperature) || normalized.temperature < 0 || normalized.temperature > 2) {
    console.warn(`[phenex:ai] invalid temperature ${normalized.temperature}, falling back to 0.7`);
    normalized.temperature = 0.7;
  }

  if (!isFiniteNumber(normalized.maxTokens) || normalized.maxTokens <= 0) {
    console.warn(`[phenex:ai] invalid maxTokens ${normalized.maxTokens}, falling back to 8192`);
    normalized.maxTokens = 8192;
  } else {
    normalized.maxTokens = Math.floor(normalized.maxTokens);
  }

  if (!isFiniteNumber(normalized.maxContextTokens) || normalized.maxContextTokens <= 0) {
    console.warn(`[phenex:ai] invalid maxContextTokens ${normalized.maxContextTokens}, falling back to 65536`);
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
  onToolEvent,
}: StreamChatOptions): Promise<StreamRunResult> {
  try {
    const s = normalizeSettings(settings);
    const result = streamText({
      model: createModel(s),
      system: buildSystem(systemPrompt, settingsContext),
      messages,
      temperature: s.temperature,
      maxOutputTokens: s.maxTokens,
      abortSignal,
      tools,
      stopWhen: tools ? isLoopFinished() : undefined,
      ...buildAdvancedOptions(s),
    });

    return await consumeStream(result, onChunk, onToolEvent);
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
}: StreamContinuationOptions): Promise<StreamRunResult> {
  try {
    const s = normalizeSettings(settings);
    const result = streamText({
      model: createModel(s),
      system: buildSystem(systemPrompt, settingsContext),
      prompt: buildContinuationPrompt(context),
      temperature: s.temperature,
      maxOutputTokens: s.maxTokens,
      abortSignal,
      tools,
      stopWhen: tools ? isLoopFinished() : undefined,
      ...buildAdvancedOptions(s),
    });

    return await consumeStream(result, onChunk, onToolEvent);
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
}: StreamRewriteOptions): Promise<StreamRunResult> {
  try {
    const s = normalizeSettings(settings);
    const result = streamText({
      model: createModel(s),
      system: buildSystem(systemPrompt, settingsContext),
      prompt: buildRewritePrompt(selection, context),
      temperature: s.temperature,
      maxOutputTokens: s.maxTokens,
      abortSignal,
      ...buildAdvancedOptions(s),
    });

    return await consumeStream(result, onChunk);
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
}: StreamFeedbackOptions): Promise<StreamRunResult> {
  try {
    const s = normalizeSettings(settings);
    const result = streamText({
      model: createModel(s),
      system: buildSystem(systemPrompt, settingsContext),
      prompt: buildFeedbackPrompt(selection),
      temperature: s.temperature,
      maxOutputTokens: s.maxTokens,
      abortSignal,
      ...buildAdvancedOptions(s),
    });

    return await consumeStream(result, onChunk);
  } catch (error) {
    console.error("streamFeedback error:", error);
    throw error;
  }
}
