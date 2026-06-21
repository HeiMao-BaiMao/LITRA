import type { AiSettings } from "../settings.ts";

type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

export function buildProviderOptions(settings: AiSettings): Record<string, Record<string, JSONValue>> | undefined {
  switch (settings.provider) {
    case "openai": {
      if (!settings.openaiReasoningEffort) return undefined;
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
      const options: Record<string, JSONValue> = {};
      // DeepSeek v4 系は thinking が有効だと reasoning_content のみが返り、
      // 通常の content ストリームが空になる。デフォルトで無効にしておく。
      options.thinking = { type: settings.deepseekThinkingMode ?? "disabled" };
      if (settings.deepseekReasoningEffort) {
        options.reasoningEffort = settings.deepseekReasoningEffort;
      }
      return { deepseek: options };
    }
    default:
      return undefined;
  }
}
