import type { AiSettings } from "../settings.ts";
import { getModelCapability } from "./capability.ts";
import type { ProviderModelDefaults } from "../providers/config.ts";

type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

/**
 * Gemini 3 系（gemini-3 / gemini-3.1 / gemini-3.5 ...）かどうかを判定する。
 */
export function isGemini3Model(model: string): boolean {
  return /^gemini-3(\.|-|$)/.test(model);
}

/**
 * モデルの capability を考慮してプロバイダーオプションを構築する。
 * 選択されたモデルの reasoningCapability メタデータを参照し、
 * サポートされているオプションのみをプロトコルに送出する。
 * 非対応のフィールド（例: adaptive-only モデルへの budget）は送らない。
 *
 * @param settings 現在の AI 設定
 * @param toolsEnabled ツール呼び出しが有効か
 * @param defaults 選択されたモデルの ProviderModelDefaults（reasoningCapability を含む）
 */
export function buildProviderOptions(
  settings: AiSettings,
  toolsEnabled = false,
  defaults?: ProviderModelDefaults,
): Record<string, Record<string, JSONValue>> | undefined {
  const provider = settings.provider;
  const modelId = settings.model;

  // Use ephemeral reasoningCapability from settings if available, otherwise resolve from defaults
  const cap = settings.reasoningCapability ?? getModelCapability(provider, modelId, defaults);

  switch (provider) {
    case "openai": {
      if (!settings.openaiReasoningEffort) return undefined;
      const baseUrl = typeof settings.baseUrl === "string" ? settings.baseUrl.trim() : "";
      if (baseUrl.includes("api.platform.preferredai.jp")) return undefined;
      return {
        openai: {
          reasoningEffort: settings.openaiReasoningEffort,
          reasoningSummary: "detailed",
        },
      };
    }
    case "anthropic": {
      if (!cap || cap.kind === "anthropic-adaptive") {
        // Adaptive-only: thinking is always on, send effort, never budget
        // Never emit invented display:"detailed"; only emit display when metadata says "summarized"
        if (!settings.anthropicThinkingEffort) return undefined;
        const thinking: Record<string, JSONValue> = { type: "adaptive" };
        if (cap?.display === "summarized") {
          thinking.display = "summarized";
        }
        return {
          anthropic: {
            thinking,
            effort: settings.anthropicThinkingEffort,
          },
        };
      }
      // Budget thinking supports explicit disable. Only enabled mode needs a budget.
      if (settings.anthropicThinkingEnabled === false) {
        return { anthropic: { thinking: { type: "disabled" } } };
      }
      if (settings.anthropicThinkingBudget == null) return undefined;
      return {
        anthropic: {
          thinking: {
            type: "enabled",
            budgetTokens: settings.anthropicThinkingBudget,
          },
        },
      };
    }
    case "deepseek": {
      if (toolsEnabled) {
        return { deepseek: { thinking: { type: "disabled" } } };
      }
      if (settings.deepseekThinkingEnabled === false) {
        return { deepseek: { thinking: { type: "disabled" } } };
      }
      const options: Record<string, JSONValue> = {
        thinking: { type: "enabled" },
      };
      if (settings.deepseekReasoningEffort) {
        options.reasoningEffort = settings.deepseekReasoningEffort;
      }
      return { deepseek: options };
    }
    case "codex": {
      if (!settings.openaiReasoningEffort) return undefined;
      return {
        openai: {
          reasoningEffort: settings.openaiReasoningEffort,
          reasoningSummary: "detailed",
        },
      };
    }
    case "github-copilot": {
      // Use the same effective capability that drove the UI/model routing. The
      // runtime places the authenticated Copilot cache override on settings.
      if (cap?.kind === "anthropic-adaptive") {
        if (!settings.anthropicThinkingEffort) return undefined;
        const thinking: Record<string, JSONValue> = { type: "adaptive" };
        if (cap.display === "summarized") thinking.display = "summarized";
        return { anthropic: { thinking, effort: settings.anthropicThinkingEffort } };
      }
      if (cap?.kind === "anthropic-budget") {
        if (settings.anthropicThinkingEnabled === false) {
          return { anthropic: { thinking: { type: "disabled" } } };
        }
        if (settings.anthropicThinkingBudget == null) return undefined;
        return { anthropic: { thinking: { type: "enabled", budgetTokens: settings.anthropicThinkingBudget } } };
      }
      if (cap?.kind === "openai") {
        if (!settings.openaiReasoningEffort) return undefined;
        return {
          openai: {
            reasoningEffort: settings.openaiReasoningEffort,
            reasoningSummary: "auto",
            include: ["reasoning.encrypted_content"],
          },
        };
      }
      return undefined;
    }
    case "sakura":
      return {
        openai: {
          store: false,
          parallelToolCalls: false,
          strictJsonSchema: false,
          reasoningSummary: "detailed",
        },
      };
    case "google": {
      if (!isGemini3Model(settings.model)) return undefined;
      return {
        google: {
          thinkingConfig: {
            includeThoughts: true,
            ...(settings.googleThinkingLevel ? { thinkingLevel: settings.googleThinkingLevel } : {}),
          },
        },
      };
    }
    default:
      return undefined;
  }
}

/**
 * debugFetch が独自のリトライ（カスタムバックオフ）を行うプロバイダでは
 * AI SDK の標準リトライを無効化し、二重リトライによる過剰な待ち時間を防ぐ。
 */
export function buildRetryOption(settings: AiSettings): { maxRetries?: number } {
  if (
    settings.provider === "opencode" ||
    settings.provider === "sakura" ||
    settings.provider === "codex" ||
    settings.provider === "github-copilot"
  ) {
    return { maxRetries: 0 };
  }
  return {};
}

/**
 * AI 呼び出しのエラーメッセージをユーザー向けに整形する。
 */
export function formatAiErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (
    /upstream request failed|upstream error|upstream unavailable|overloaded|temporarily unavailable|service unavailable|rate[- ]?limit|too many requests|throttl/i.test(
      raw,
    )
  ) {
    return `${raw}\n\n時間をおいて再度送信してください。`;
  }
  return raw;
}
