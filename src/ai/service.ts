import { streamText, type ModelMessage } from "ai";
import { createModel } from "./provider.ts";
import {
  buildContinuationPrompt,
  buildFeedbackPrompt,
  buildRewritePrompt,
  systemPrompt,
} from "./prompts.ts";
import type { AiSettings } from "../settings.ts";

export interface StreamChatOptions {
  settings: AiSettings;
  messages: ModelMessage[];
  onChunk: (chunk: string) => void;
  abortSignal?: AbortSignal;
}

export interface StreamContinuationOptions {
  settings: AiSettings;
  context: string;
  onChunk: (chunk: string) => void;
  abortSignal?: AbortSignal;
}

export interface StreamRewriteOptions {
  settings: AiSettings;
  selection: string;
  context: string;
  onChunk: (chunk: string) => void;
  abortSignal?: AbortSignal;
}

export interface StreamFeedbackOptions {
  settings: AiSettings;
  selection: string;
  onChunk: (chunk: string) => void;
  abortSignal?: AbortSignal;
}

export async function streamChat({
  settings,
  messages,
  onChunk,
  abortSignal,
}: StreamChatOptions): Promise<void> {
  try {
    const result = streamText({
      model: createModel(settings),
      system: systemPrompt,
      messages,
      temperature: settings.temperature,
      maxOutputTokens: settings.maxTokens,
      abortSignal,
    });

    for await (const chunk of result.textStream) {
      onChunk(chunk);
    }
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
}: StreamContinuationOptions): Promise<void> {
  try {
    const result = streamText({
      model: createModel(settings),
      system: systemPrompt,
      prompt: buildContinuationPrompt(context),
      temperature: settings.temperature,
      maxOutputTokens: settings.maxTokens,
      abortSignal,
    });

    for await (const chunk of result.textStream) {
      onChunk(chunk);
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
}: StreamRewriteOptions): Promise<void> {
  try {
    const result = streamText({
      model: createModel(settings),
      system: systemPrompt,
      prompt: buildRewritePrompt(selection, context),
      temperature: settings.temperature,
      maxOutputTokens: settings.maxTokens,
      abortSignal,
    });

    for await (const chunk of result.textStream) {
      onChunk(chunk);
    }
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
}: StreamFeedbackOptions): Promise<void> {
  try {
    const result = streamText({
      model: createModel(settings),
      system: systemPrompt,
      prompt: buildFeedbackPrompt(selection),
      temperature: settings.temperature,
      maxOutputTokens: settings.maxTokens,
      abortSignal,
    });

    for await (const chunk of result.textStream) {
      onChunk(chunk);
    }
  } catch (error) {
    console.error("streamFeedback error:", error);
    throw error;
  }
}
