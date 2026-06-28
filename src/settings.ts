import { load, Store } from "@tauri-apps/plugin-store";
import {
  loadProviderConfig,
  getProviderEntry,
  getProviderModelDefaults,
  resetProviderConfig,
} from "./providers/config.ts";
import { clearPanelRatios } from "./layout-store.ts";
import { clearWindowState } from "./window/bounds.ts";

export type Provider = "openai" | "anthropic" | "deepseek" | "google" | "llamacpp" | "sakura" | "plamo" | "opencode";
export type OpenAIReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type DeepSeekReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ProviderSpecificSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface AiSettings {
  provider: Provider;
  apiKey: string;
  baseUrl: string;
  model: string;
  providerConfigs: Record<Provider, ProviderSpecificSettings>;
  chatProvider?: Provider;
  chatModel?: string;
  temperature: number;
  maxTokens: number;
  maxContextTokens: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  openaiReasoningEffort?: OpenAIReasoningEffort;
  deepseekReasoningEffort?: DeepSeekReasoningEffort;
  anthropicThinkingEnabled?: boolean;
  anthropicThinkingBudget?: number;
}

const STORE_NAME = "phenex-settings.json";

const DEFAULT_PROVIDER: Provider = "openai";

const ALL_PROVIDERS: Provider[] = ["openai", "anthropic", "deepseek", "google", "llamacpp", "sakura", "plamo", "opencode"];

async function getStore(): Promise<Store> {
  return load(STORE_NAME, { defaults: {}, autoSave: true });
}

export async function resetAllSettings(): Promise<void> {
  const store = await getStore();
  await store.clear();
  await store.save();
  await clearPanelRatios();
  await clearWindowState();
  await resetProviderConfig();
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  return undefined;
}

function isOpenAIReasoningEffort(value: unknown): value is OpenAIReasoningEffort {
  return (
    value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  );
}

function isDeepSeekReasoningEffort(value: unknown): value is DeepSeekReasoningEffort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

function isProvider(value: unknown): value is Provider {
  return (
    value === "openai" ||
    value === "anthropic" ||
    value === "deepseek" ||
    value === "google" ||
    value === "llamacpp" ||
    value === "sakura" ||
    value === "plamo" ||
    value === "opencode"
  );
}

function migrateLegacyModel(provider: Provider, model: string): string {
  if (provider === "deepseek" && model === "deepseek-chat") {
    console.warn('[phenex:settings] migrating legacy DeepSeek model "deepseek-chat" to "deepseek-v4-flash"');
    return "deepseek-v4-flash";
  }
  if (provider === "deepseek" && model === "deepseek-reasoner") {
    console.warn(
      '[phenex:settings] migrating legacy DeepSeek model "deepseek-reasoner" to "deepseek-v4-flash" with thinking enabled',
    );
    return "deepseek-v4-flash";
  }
  return model;
}

function normalizeProviderModel(provider: Provider, model: string, defaultModel: string, configuredModels: string[]): string {
  if (provider === "sakura" && configuredModels.length > 0 && !configuredModels.includes(model)) {
    return defaultModel;
  }
  return model;
}

export async function loadSettings(): Promise<AiSettings> {
  const store = await getStore();
  const storedProvider = await store.get("provider");
  const provider = isProvider(storedProvider) ? storedProvider : DEFAULT_PROVIDER;

  const config = await loadProviderConfig();

  const legacyReasoningEffort = await store.get<string>("reasoningEffort");
  const legacyThinkingEnabled = await store.get<boolean>("thinkingEnabled");
  const legacyThinkingBudget = await store.get<number>("thinkingBudget");

  const legacyApiKey = ((await store.get<string>("apiKey")) ?? "").trim();
  const legacyBaseUrl = ((await store.get<string>("baseUrl")) ?? "").trim();
  const legacyModel = ((await store.get<string>("model")) ?? "").trim();

  const storedProviderConfigs = await store.get<unknown>("providerConfigs");
  const previousConfigs: Partial<Record<Provider, Partial<ProviderSpecificSettings>>> =
    typeof storedProviderConfigs === "object" && storedProviderConfigs !== null
      ? (storedProviderConfigs as Partial<Record<Provider, Partial<ProviderSpecificSettings>>>)
      : {};

  const providerConfigs = {} as Record<Provider, ProviderSpecificSettings>;

  for (const p of ALL_PROVIDERS) {
    const entry = getProviderEntry(config, p);
    const previous = previousConfigs[p] ?? {};

    let model = (previous.model ?? "").trim();
    let apiKey = (previous.apiKey ?? "").trim();
    let baseUrl = (previous.baseUrl ?? "").trim();

    if (p === provider) {
      if (!model) model = legacyModel;
      if (!apiKey) apiKey = legacyApiKey;
      if (!baseUrl) baseUrl = legacyBaseUrl;
    }

    const defaultModel = entry?.defaultModel ?? "";
    const configuredModels = entry?.models?.map((entryModel) => entryModel.id) ?? [];
    if (!model) model = defaultModel;
    if (!baseUrl) baseUrl = entry?.defaultBaseUrl ?? "";

    model = migrateLegacyModel(p, model);
    model = normalizeProviderModel(p, model, defaultModel, configuredModels);

    providerConfigs[p] = { apiKey, baseUrl, model };
  }

  const activeConfig = providerConfigs[provider];
  const model = activeConfig.model;
  const modelDefaults = getProviderModelDefaults(getProviderEntry(config, provider), model);

  const chatProvider = await store.get("chatProvider");
  const chatModel = await store.get<string>("chatModel");

  const base: AiSettings = {
    provider,
    apiKey: activeConfig.apiKey,
    baseUrl: activeConfig.baseUrl,
    model,
    providerConfigs,
    chatProvider: isProvider(chatProvider) ? chatProvider : undefined,
    chatModel: chatModel ?? undefined,
    temperature: optionalNumber(await store.get("temperature")) ?? modelDefaults?.temperature ?? 0.7,
    maxTokens: optionalNumber(await store.get("maxTokens")) ?? modelDefaults?.maxTokens ?? 8192,
    maxContextTokens: optionalNumber(await store.get("maxContextTokens")) ?? modelDefaults?.maxContextTokens ?? 65536,
    topP: optionalNumber(await store.get("topP")) ?? modelDefaults?.topP,
    topK: optionalNumber(await store.get("topK")) ?? modelDefaults?.topK,
    frequencyPenalty: optionalNumber(await store.get("frequencyPenalty")) ?? modelDefaults?.frequencyPenalty,
    presencePenalty: optionalNumber(await store.get("presencePenalty")) ?? modelDefaults?.presencePenalty,
  };

  // 旧共有フィールドからプロバイダー別フィールドへ移行
  if (provider === "openai") {
    base.openaiReasoningEffort =
      (isOpenAIReasoningEffort(await store.get("openaiReasoningEffort"))
        ? (await store.get("openaiReasoningEffort") as OpenAIReasoningEffort)
        : undefined) ??
      (isOpenAIReasoningEffort(legacyReasoningEffort) ? legacyReasoningEffort : undefined) ??
      (isOpenAIReasoningEffort(modelDefaults?.openaiReasoningEffort) ? modelDefaults.openaiReasoningEffort : undefined);
  } else if (provider === "deepseek") {
    base.deepseekReasoningEffort =
      (isDeepSeekReasoningEffort(await store.get("deepseekReasoningEffort"))
        ? (await store.get("deepseekReasoningEffort") as DeepSeekReasoningEffort)
        : undefined) ??
      (isDeepSeekReasoningEffort(legacyReasoningEffort) ? legacyReasoningEffort : undefined) ??
      (isDeepSeekReasoningEffort(modelDefaults?.deepseekReasoningEffort) ? modelDefaults.deepseekReasoningEffort : undefined);
  } else if (provider === "anthropic") {
    base.anthropicThinkingEnabled =
      optionalBoolean(await store.get("anthropicThinkingEnabled")) ??
      legacyThinkingEnabled ??
      modelDefaults?.anthropicThinkingEnabled ??
      undefined;
    base.anthropicThinkingBudget =
      optionalNumber(await store.get("anthropicThinkingBudget")) ??
      legacyThinkingBudget ??
      modelDefaults?.anthropicThinkingBudget ??
      undefined;
  }

  return base;
}

async function setIfDefined<T>(
  store: Store,
  key: string,
  value: T | undefined,
): Promise<void> {
  if (value !== undefined) {
    await store.set(key, value);
  }
}

export async function saveSettings(settings: AiSettings): Promise<void> {
  const store = await getStore();
  await store.set("provider", settings.provider);
  await store.set("apiKey", settings.apiKey);
  await store.set("baseUrl", settings.baseUrl);
  await store.set("model", settings.model);
  await store.set("providerConfigs", settings.providerConfigs);
  await store.set("chatProvider", settings.chatProvider ?? null);
  await store.set("chatModel", settings.chatModel ?? null);
  await store.set("temperature", settings.temperature);
  await store.set("maxTokens", settings.maxTokens);
  await store.set("maxContextTokens", settings.maxContextTokens);
  await setIfDefined(store, "topP", settings.topP);
  await setIfDefined(store, "topK", settings.topK);
  await setIfDefined(store, "frequencyPenalty", settings.frequencyPenalty);
  await setIfDefined(store, "presencePenalty", settings.presencePenalty);
  await setIfDefined(store, "openaiReasoningEffort", settings.openaiReasoningEffort);
  await setIfDefined(store, "deepseekReasoningEffort", settings.deepseekReasoningEffort);
  await setIfDefined(store, "anthropicThinkingEnabled", settings.anthropicThinkingEnabled);
  await setIfDefined(store, "anthropicThinkingBudget", settings.anthropicThinkingBudget);
  await store.save();
}

export function getProviderSpecificSettings(
  settings: AiSettings,
  provider: Provider,
): ProviderSpecificSettings {
  return settings.providerConfigs[provider] ?? { apiKey: "", baseUrl: "", model: "" };
}

export function resolveChatSettings(settings: AiSettings): AiSettings {
  const provider = settings.chatProvider ?? settings.provider;
  const specific = getProviderSpecificSettings(settings, provider);
  return {
    ...settings,
    provider,
    apiKey: specific.apiKey,
    baseUrl: specific.baseUrl,
    model: settings.chatModel ?? specific.model,
  };
}

export function getActiveProvider(settings: AiSettings): Provider {
  return settings.chatProvider ?? settings.provider;
}
