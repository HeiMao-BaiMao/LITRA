import { streamText, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import { createModel } from "./provider.ts";
import { buildProviderOptions } from "./provider-options.ts";
import {
  buildContinuationPrompt,
  buildFeedbackPrompt,
  buildRewritePrompt,
  systemPrompt,
} from "./prompts.ts";
import type { AiSettings } from "../settings.ts";

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

interface ToolResultLike {
  toolName: string;
  input: unknown;
  output: unknown;
}

async function consumeStream(
  result: {
    textStream: AsyncIterable<string>;
    toolResults: PromiseLike<ToolResultLike[]>;
  },
  onChunk: (chunk: string) => void,
  onToolResult?: (toolName: string, input: unknown, output: unknown) => void,
): Promise<void> {
  let chunkCount = 0;
  const textConsumer = (async () => {
    for await (const chunk of result.textStream) {
      chunkCount++;
      if (chunkCount <= 3 || chunkCount % 10 === 0) {
        console.log(`[phenex:ai] text chunk #${chunkCount}:`, chunk.slice(0, 80));
      }
      onChunk(chunk);
    }
    console.log(`[phenex:ai] text stream finished. total chunks: ${chunkCount}`);
  })();

  const toolConsumer = (async () => {
    const results = await result.toolResults;
    console.log(`[phenex:ai] tool results count: ${results.length}`);
    if (onToolResult) {
      for (const item of results) {
        console.log(`[phenex:ai] tool call: ${item.toolName}`, item.input);
        onToolResult(item.toolName, item.input, item.output);
      }
    }
  })();

  await Promise.all([textConsumer, toolConsumer]);
}

export interface StreamChatOptions {
  settings: AiSettings;
  messages: ModelMessage[];
  onChunk: (chunk: string) => void;
  abortSignal?: AbortSignal;
  settingsContext?: string;
  tools?: ToolSet;
  onToolResult?: (toolName: string, input: unknown, output: unknown) => void;
}

export interface StreamContinuationOptions {
  settings: AiSettings;
  context: string;
  onChunk: (chunk: string) => void;
  abortSignal?: AbortSignal;
  settingsContext?: string;
  tools?: ToolSet;
  onToolResult?: (toolName: string, input: unknown, output: unknown) => void;
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
  if (typeof normalized.maxTokens !== "number" || Number.isNaN(normalized.maxTokens) || normalized.maxTokens <= 0) {
    console.warn(`[phenex:ai] invalid maxTokens ${normalized.maxTokens}, falling back to 8192`);
    normalized.maxTokens = 8192;
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
  onToolResult,
}: StreamChatOptions): Promise<void> {
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
      stopWhen: tools ? stepCountIs(5) : undefined,
      ...buildAdvancedOptions(s),
    });

    await consumeStream(result, onChunk, onToolResult);
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
  onToolResult,
}: StreamContinuationOptions): Promise<void> {
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
      stopWhen: tools ? stepCountIs(5) : undefined,
      ...buildAdvancedOptions(s),
    });

    await consumeStream(result, onChunk, onToolResult);
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
}: StreamRewriteOptions): Promise<void> {
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

    await consumeStream(result, onChunk);
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
}: StreamFeedbackOptions): Promise<void> {
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

    await consumeStream(result, onChunk);
  } catch (error) {
    console.error("streamFeedback error:", error);
    throw error;
  }
}
