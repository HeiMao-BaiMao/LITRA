import type { AiSettings } from "../settings.ts";

type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

export function buildProviderOptions(
  settings: AiSettings,
  toolsEnabled = false,
): Record<string, Record<string, JSONValue>> | undefined {
  switch (settings.provider) {
    case "openai": {
      if (!settings.openaiReasoningEffort) return undefined;
      // PLaMo は /v1/responses に対応していないため、reasoningEffort を渡すと 404 になる。
      // 他の OpenAI 互換サービスは responses に対応している可能性があるので、PLaMo だけ除外する。
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
      if (!settings.anthropicThinkingEnabled || settings.anthropicThinkingBudget == null) return undefined;
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
        // DeepSeek の thinking モードはツール呼び出しに対応していない。
        return {
          deepseek: { thinking: { type: "disabled" } },
        };
      }
      const options: Record<string, JSONValue> = {
        // DeepSeek V4 系は thinking がデフォルトで有効。温度・top_p・ペナルティ類は
        // thinking モードで無視されるため、通常時はここで有効にしておく。
        thinking: { type: "enabled" },
      };
      if (settings.deepseekReasoningEffort) {
        options.reasoningEffort = settings.deepseekReasoningEffort;
      }
      return { deepseek: options };
    }
    case "sakura":
      return {
        openai: {
          // Sakura AI Engine の Responses API は OpenAI 互換だが、
          // 本家 OpenAI の永続化状態や並列 tool call に依存しない形へ寄せる。
          store: false,
          parallelToolCalls: false,
          strictJsonSchema: false,
          reasoningSummary: "detailed",
        },
      };
    default:
      return undefined;
  }
}

/**
 * debugFetch が独自のリトライ（カスタムバックオフ）を行うプロバイダでは
 * AI SDK の標準リトライを無効化し、二重リトライによる過剰な待ち時間を防ぐ。
 * それ以外のプロバイダでは AI SDK のデフォルトリトライ（2回）を維持する。
 */
export function buildRetryOption(settings: AiSettings): { maxRetries?: number } {
  if (settings.provider === "opencode" || settings.provider === "sakura") {
    return { maxRetries: 0 };
  }
  return {};
}

/**
 * AI 呼び出しのエラーメッセージをユーザー向けに整形する。
 * 一時的な上流エラーやレートリミットの場合は再試行を促すヒントを追加する。
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
