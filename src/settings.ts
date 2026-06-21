import { load, Store } from "@tauri-apps/plugin-store";

export interface AiSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

const STORE_NAME = "phenex-settings.json";

const DEFAULT_SETTINGS: AiSettings = {
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  temperature: 0.7,
  maxTokens: 1000,
};

async function getStore(): Promise<Store> {
  return load(STORE_NAME, { defaults: {}, autoSave: true });
}

export async function loadSettings(): Promise<AiSettings> {
  const store = await getStore();
  return {
    apiKey: (await store.get<string>("apiKey")) ?? DEFAULT_SETTINGS.apiKey,
    baseUrl: (await store.get<string>("baseUrl")) ?? DEFAULT_SETTINGS.baseUrl,
    model: (await store.get<string>("model")) ?? DEFAULT_SETTINGS.model,
    temperature:
      (await store.get<number>("temperature")) ?? DEFAULT_SETTINGS.temperature,
    maxTokens:
      (await store.get<number>("maxTokens")) ?? DEFAULT_SETTINGS.maxTokens,
  };
}

export async function saveSettings(settings: AiSettings): Promise<void> {
  const store = await getStore();
  await store.set("apiKey", settings.apiKey);
  await store.set("baseUrl", settings.baseUrl);
  await store.set("model", settings.model);
  await store.set("temperature", settings.temperature);
  await store.set("maxTokens", settings.maxTokens);
  await store.save();
}
