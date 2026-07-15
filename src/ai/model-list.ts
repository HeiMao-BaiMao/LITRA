import { invoke } from "@tauri-apps/api/core";
import type { AiSettings } from "../settings.ts";
import {
  getProviderEntry,
  getProviderModelIds,
  isFixedModelSelection,
  loadProviderConfig,
  providerRequiresApiKey,
} from "../providers/config.ts";
import { cacheCopilotModels, type CopilotModelCacheEntry } from "../providers/copilot-auth.ts";

export interface ModelListResult {
  models: string[];
  error?: string;
}

export interface FixedModel {
  id: string;
  label: string;
}

interface RustModelInfo {
  id: string;
  endpoint?: "chat" | "responses" | "messages";
  reasoningEffort?: string[];
  adaptiveThinking?: boolean;
  minThinkingBudget?: number;
  maxThinkingBudget?: number;
}

function mergeModels(fetched: string[], configured: string[]): string[] {
  return Array.from(new Set([...fetched, ...configured])).sort();
}

export async function fetchAvailableModels(settings: AiSettings): Promise<ModelListResult> {
  const config = await loadProviderConfig();
  const entry = getProviderEntry(config, settings.provider);
  if (!entry) return { models: [], error: "未知のプロバイダーです。" };

  const configuredModels = getProviderModelIds(entry);
  if (isFixedModelSelection(entry)) return { models: configuredModels };
  if (providerRequiresApiKey(entry) && !settings.apiKey) {
    return { models: [], error: "API キーが設定されていません。" };
  }

  try {
    const fetched = await invoke<RustModelInfo[]>("ai_list_models", {
      request: {
        provider: settings.provider,
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
      },
    });
    if (settings.provider === "github-copilot") {
      const cache: Record<string, CopilotModelCacheEntry> = {};
      for (const model of fetched) {
        cache[model.id] = {
          id: model.id,
          endpoint: model.endpoint ?? "chat",
          reasoningEffort: model.reasoningEffort,
          adaptiveThinking: model.adaptiveThinking,
          minThinkingBudget: model.minThinkingBudget,
          maxThinkingBudget: model.maxThinkingBudget,
        };
      }
      cacheCopilotModels(cache);
    }
    return { models: mergeModels(fetched.map((model) => model.id), configuredModels) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/\b(?:401|403)\b/.test(message) && configuredModels.length > 0) {
      return { models: configuredModels };
    }
    return { models: [], error: message };
  }
}
