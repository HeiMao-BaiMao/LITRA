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
      const baseUrl = settings.baseUrl.trim();
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
