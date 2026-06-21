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
      if (settings.deepseekThinkingMode) {
        options.thinking = { type: settings.deepseekThinkingMode };
      }
      if (settings.deepseekReasoningEffort) {
        options.reasoningEffort = settings.deepseekReasoningEffort;
      }
      if (Object.keys(options).length === 0) return undefined;
      return { deepseek: options };
    }
    default:
      return undefined;
  }
}
