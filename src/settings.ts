import { load, Store } from "@tauri-apps/plugin-store";

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

const PROVIDER_DEFAULTS: Record<
  Provider,
  Pick<AiSettings, "baseUrl" | "model">
> = {
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-3-5-sonnet-20241022",
  },
  deepseek: { baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
};

async function getStore(): Promise<Store> {
  return load(STORE_NAME, { defaults: {}, autoSave: true });
}

export async function loadSettings(): Promise<AiSettings> {
  const store = await getStore();
  const provider =
    (await store.get<Provider>("provider")) ?? DEFAULT_PROVIDER;
  const defaults = PROVIDER_DEFAULTS[provider];

  return {
    provider,
    apiKey: (await store.get<string>("apiKey")) ?? "",
    baseUrl: (await store.get<string>("baseUrl")) ?? defaults.baseUrl,
    model: (await store.get<string>("model")) ?? defaults.model,
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
