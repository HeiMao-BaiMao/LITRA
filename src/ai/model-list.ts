import { fetch } from "@tauri-apps/plugin-http";
import type { AiSettings } from "../settings.ts";
import { loadProviderConfig, getProviderEntry } from "../providers/config.ts";

export interface ModelListResult {
  models: string[];
  error?: string;
}

async function fetchOpenAiCompatibleModels(
  settings: AiSettings,
): Promise<ModelListResult> {
  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({
      apiKey: settings.apiKey,
      baseURL: settings.baseUrl,
      fetch,
      dangerouslyAllowBrowser: true,
    });

    const response = await client.models.list();
    const models = response.data
      .map((model) => model.id)
      .filter((id): id is string => typeof id === "string")
      .sort();

    return { models };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { models: [], error: message };
  }
}

async function fetchAnthropicModels(
  settings: AiSettings,
): Promise<ModelListResult> {
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({
      apiKey: settings.apiKey,
      baseURL: settings.baseUrl,
      fetch,
      dangerouslyAllowBrowser: true,
    });

    const response = await client.models.list();
    const models = response.data
      .map((model) => model.id)
      .filter((id): id is string => typeof id === "string")
      .sort();

    return { models };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { models: [], error: message };
  }
}

export async function fetchAvailableModels(
  settings: AiSettings,
): Promise<ModelListResult> {
  if (!settings.apiKey) {
    return { models: [], error: "API キーが設定されていません。" };
  }

  const config = await loadProviderConfig();
  const entry = getProviderEntry(config, settings.provider);

  if (!entry) {
    return { models: [], error: "未知のプロバイダーです。" };
  }

  switch (entry.sdkType) {
    case "openai":
      return fetchOpenAiCompatibleModels(settings);
    case "anthropic":
      return fetchAnthropicModels(settings);
  }
}
