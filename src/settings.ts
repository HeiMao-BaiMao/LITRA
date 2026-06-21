import { load, Store } from "@tauri-apps/plugin-store";
import { loadProviderConfig, getProviderEntry } from "./providers/config.ts";

export type Provider = "openai" | "anthropic" | "deepseek";

export interface AiSettings {
  provider: Provider;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

const STORE_NAME = "phenex-settings.json";

const DEFAULT_PROVIDER: Provider = "openai";

async function getStore(): Promise<Store> {
  return load(STORE_NAME, { defaults: {}, autoSave: true });
}

export async function loadSettings(): Promise<AiSettings> {
  const store = await getStore();
  const provider =
    (await store.get<Provider>("provider")) ?? DEFAULT_PROVIDER;

  const config = await loadProviderConfig();
  const entry = getProviderEntry(config, provider);

  return {
    provider,
    apiKey: (await store.get<string>("apiKey")) ?? "",
    baseUrl:
      (await store.get<string>("baseUrl")) ?? entry?.defaultBaseUrl ?? "",
    model: (await store.get<string>("model")) ?? entry?.defaultModel ?? "",
    temperature: (await store.get<number>("temperature")) ?? 0.7,
    maxTokens: (await store.get<number>("maxTokens")) ?? 1000,
  };
}

export async function saveSettings(settings: AiSettings): Promise<void> {
  const store = await getStore();
  await store.set("provider", settings.provider);
  await store.set("apiKey", settings.apiKey);
  await store.set("baseUrl", settings.baseUrl);
  await store.set("model", settings.model);
  await store.set("temperature", settings.temperature);
  await store.set("maxTokens", settings.maxTokens);
  await store.save();
}
