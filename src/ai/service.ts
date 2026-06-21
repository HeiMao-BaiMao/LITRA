import { streamText, type ModelMessage, type ToolSet } from "ai";
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
  const textConsumer = (async () => {
    for await (const chunk of result.textStream) {
      onChunk(chunk);
    }
  })();

  const toolConsumer = (async () => {
    const results = await result.toolResults;
    if (onToolResult) {
      for (const item of results) {
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
    const result = streamText({
      model: createModel(settings),
      system: buildSystem(systemPrompt, settingsContext),
      messages,
      temperature: settings.temperature,
      maxOutputTokens: settings.maxTokens,
      abortSignal,
      tools,
      ...buildAdvancedOptions(settings),
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
    const result = streamText({
      model: createModel(settings),
      system: buildSystem(systemPrompt, settingsContext),
      prompt: buildContinuationPrompt(context),
      temperature: settings.temperature,
      maxOutputTokens: settings.maxTokens,
      abortSignal,
      tools,
      ...buildAdvancedOptions(settings),
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
    const result = streamText({
      model: createModel(settings),
      system: buildSystem(systemPrompt, settingsContext),
      prompt: buildRewritePrompt(selection, context),
      temperature: settings.temperature,
      maxOutputTokens: settings.maxTokens,
      abortSignal,
      ...buildAdvancedOptions(settings),
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
    const result = streamText({
      model: createModel(settings),
      system: buildSystem(systemPrompt, settingsContext),
      prompt: buildFeedbackPrompt(selection),
      temperature: settings.temperature,
      maxOutputTokens: settings.maxTokens,
      abortSignal,
      ...buildAdvancedOptions(settings),
    });

    await consumeStream(result, onChunk);
  } catch (error) {
    console.error("streamFeedback error:", error);
    throw error;
  }
}
