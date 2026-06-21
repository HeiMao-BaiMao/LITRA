import { fetch } from "@tauri-apps/plugin-http";
import type { AiSettings, Provider } from "../settings.ts";

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

const PROVIDER_FETCHERS: Record<
  Provider,
  (settings: AiSettings) => Promise<ModelListResult>
> = {
  openai: fetchOpenAiCompatibleModels,
  anthropic: fetchAnthropicModels,
  deepseek: fetchOpenAiCompatibleModels,
};

export async function fetchAvailableModels(
  settings: AiSettings,
): Promise<ModelListResult> {
  if (!settings.apiKey) {
    return { models: [], error: "API キーが設定されていません。" };
  }

  const fetcher = PROVIDER_FETCHERS[settings.provider];
  return fetcher(settings);
}
