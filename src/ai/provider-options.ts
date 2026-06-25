import type { AiSettings } from "../settings.ts";

type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

export function buildProviderOptions(
  settings: AiSettings,
  toolsEnabled = false,
): Record<string, Record<string, JSONValue>> | undefined {
  switch (settings.provider) {
    case "openai": {
      if (!settings.openaiReasoningEffort) return undefined;
      // OpenAI 互換エンドポイント（PLaMo 等）では /v1/responses がないため、
      // カスタム baseUrl を使う場合は reasoningEffort を送らず通常の chat completions を使う。
      const baseUrl = settings.baseUrl.trim();
      const isOfficialOpenAI = !baseUrl || baseUrl === "https://api.openai.com/v1";
      if (!isOfficialOpenAI) return undefined;
      return {
        openai: {
          reasoningEffort: settings.openaiReasoningEffort,
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
    default:
      return undefined;
  }
}
