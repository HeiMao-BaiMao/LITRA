import { Channel, invoke } from "@tauri-apps/api/core";
import type { AiSettings } from "../settings.ts";
import {
  getProviderEntry,
  loadProviderConfig,
  resolveProviderConnection,
  type ResolvedProviderConnection,
} from "../providers/config.ts";
import { getCopilotModelEndpoint } from "../providers/copilot-auth.ts";

export type RustAiStreamEvent =
  | { type: "started"; request_id: string }
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "tool_input_start"; tool_call_id: string; tool_name: string }
  | { type: "tool_input_delta"; tool_call_id: string; delta: string }
  | { type: "tool_call"; tool_call_id: string; tool_name: string; input: unknown }
  | {
      type: "usage";
      input_tokens?: number;
      output_tokens?: number;
      cached_input_tokens?: number;
    }
  | { type: "finished"; finish_reason?: string }
  | { type: "cancelled" }
  | { type: "error"; message: string; status?: number };

export interface RustTextStreamOptions {
  system: string;
  prompt: string;
  messages?: RustChatMessage[];
  tools?: RustToolDefinition[];
  toolChoice?: "auto" | "none" | "required";
  maxOutputTokens: number;
  abortSignal?: AbortSignal;
  onChunk: (chunk: string) => void;
  onReasoning?: (chunk: string) => void;
  onToolInputStart?: (call: { toolCallId: string; toolName: string }) => void;
}

export interface RustChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: unknown;
}

export interface RustTextStreamResult {
  textChunkCount: number;
  textCharCount: number;
  reasoningChunkCount: number;
  reasoningCharCount: number;
  finishReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  };
  toolCalls: RustToolCall[];
}

export interface RustToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface RustToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export function supportsRustTextProvider(settings: AiSettings): boolean {
  return (
    settings.provider === "openai" ||
    settings.provider === "anthropic" ||
    settings.provider === "google" ||
    settings.provider === "deepseek" ||
    settings.provider === "llamacpp" ||
    settings.provider === "sakura" ||
    settings.provider === "codex" ||
    settings.provider === "github-copilot"
  );
}

export async function streamRustText(
  settings: AiSettings,
  options: RustTextStreamOptions,
): Promise<RustTextStreamResult> {
  const providerConfig = await loadProviderConfig();
  const copilotEndpoint = settings.provider === "github-copilot"
    ? getCopilotModelEndpoint(settings.model)
    : undefined;
  const configuredBaseUrl = copilotEndpoint === "messages" && settings.baseUrl
    ? `${settings.baseUrl.replace(/\/$/, "")}/v1`.replace(/\/v1\/v1$/, "/v1")
    : settings.baseUrl;
  const connection = resolveProviderConnection(
    getProviderEntry(providerConfig, settings.provider),
    settings.model,
    configuredBaseUrl,
    copilotEndpoint,
  );
  if (!connection) {
    throw new Error(`AI接続定義が見つかりません: ${settings.provider}/${settings.model}`);
  }
  const requestId = `ai_${crypto.randomUUID().replace(/-/g, "")}`;
  let textChunkCount = 0;
  let textCharCount = 0;
  let reasoningChunkCount = 0;
  let reasoningCharCount = 0;
  let finishReason: string | undefined;
  let usage: RustTextStreamResult["usage"];
  let eventError: Error | undefined;
  let cancelled = false;
  const toolCalls: RustToolCall[] = [];

  const channel = new Channel<RustAiStreamEvent>((event) => {
    switch (event.type) {
      case "text_delta":
        textChunkCount++;
        textCharCount += event.delta.length;
        options.onChunk(event.delta);
        break;
      case "reasoning_delta":
        reasoningChunkCount++;
        reasoningCharCount += event.delta.length;
        options.onReasoning?.(event.delta);
        break;
      case "usage":
        usage = {
          inputTokens: event.input_tokens,
          outputTokens: event.output_tokens,
          cachedInputTokens: event.cached_input_tokens,
        };
        break;
      case "finished":
        finishReason = event.finish_reason ?? finishReason;
        break;
      case "cancelled":
        cancelled = true;
        break;
      case "error":
        eventError = new Error(event.message);
        break;
      case "started":
        break;
      case "tool_input_start":
        options.onToolInputStart?.({
          toolCallId: event.tool_call_id,
          toolName: event.tool_name,
        });
        break;
      case "tool_input_delta":
        break;
      case "tool_call":
        toolCalls.push({
          toolCallId: event.tool_call_id,
          toolName: event.tool_name,
          input: event.input,
        });
        break;
    }
  });

  const abort = (): void => {
    cancelled = true;
    void invoke("ai_cancel", { requestId });
  };
  if (options.abortSignal?.aborted) {
    throw new DOMException("AI生成がキャンセルされました。", "AbortError");
  }
  options.abortSignal?.addEventListener("abort", abort, { once: true });

  try {
    await invoke<void>("ai_stream_text", {
      request: buildRustTextRequest(requestId, settings, connection, options),
      onEvent: channel,
    });
  } catch (error) {
    throw eventError ?? error;
  } finally {
    options.abortSignal?.removeEventListener("abort", abort);
  }

  if (eventError) throw eventError;
  if (cancelled || options.abortSignal?.aborted) {
    throw new DOMException("AI生成がキャンセルされました。", "AbortError");
  }

  return {
    textChunkCount,
    textCharCount,
    reasoningChunkCount,
    reasoningCharCount,
    finishReason,
    usage,
    toolCalls,
  };
}

function buildRustTextRequest(
  requestId: string,
  settings: AiSettings,
  connection: ResolvedProviderConnection,
  options: RustTextStreamOptions,
) {
  const deepSeekThinking =
    settings.provider === "deepseek" ? settings.deepseekThinkingEnabled !== false : undefined;
  const anthropicThinking =
    settings.provider === "anthropic" ? settings.anthropicThinkingEnabled : undefined;
  const capability = settings.reasoningCapability;
  const anthropicThinkingType =
    settings.provider !== "anthropic"
      ? undefined
      : capability?.kind === "anthropic-adaptive"
        ? capability.canDisable && anthropicThinking !== false
          ? "adaptive"
          : undefined
        : capability?.kind === "anthropic-budget"
          ? anthropicThinking === false
            ? "disabled"
            : settings.anthropicThinkingBudget != null
              ? "enabled"
              : undefined
          : undefined;
  const ignoreSampling =
    deepSeekThinking === true ||
    settings.provider === "opencode" ||
    (settings.provider === "google" && /^gemini-3(?:\.|-|$)/.test(settings.model)) ||
    settings.provider === "anthropic";

  return {
    requestId,
    provider: settings.provider,
    apiType: connection.apiType,
    apiKey: settings.apiKey,
    baseUrl: connection.baseUrl,
    model: settings.model,
    system: options.system,
    messages: options.messages,
    tools: options.tools,
    toolChoice: options.toolChoice,
    prompt: options.prompt,
    maxOutputTokens: options.maxOutputTokens,
    temperature: ignoreSampling ? undefined : settings.temperature,
    topP: ignoreSampling ? undefined : settings.topP,
    topK: ignoreSampling ? undefined : settings.topK,
    frequencyPenalty: settings.frequencyPenalty,
    presencePenalty: settings.presencePenalty,
    reasoningEffort:
      settings.provider === "deepseek"
        ? settings.deepseekReasoningEffort
        : settings.openaiReasoningEffort,
    thinkingEnabled: deepSeekThinking ?? anthropicThinking,
    anthropicThinkingType,
    anthropicThinkingEffort: settings.anthropicThinkingEffort,
    thinkingBudget:
      settings.provider === "anthropic" ? settings.anthropicThinkingBudget : undefined,
    thinkingLevel: settings.provider === "google" ? settings.googleThinkingLevel : undefined,
  };
}
