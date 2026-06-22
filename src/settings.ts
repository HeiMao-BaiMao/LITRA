import { load, Store } from "@tauri-apps/plugin-store";
import { loadProviderConfig, getProviderEntry, getProviderModelDefaults } from "./providers/config.ts";

export type Provider = "openai" | "anthropic" | "deepseek" | "google" | "llamacpp" | "sakura";
export type OpenAIReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type DeepSeekReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AiSettings {
  provider: Provider;
  apiKey: string;
  baseUrl: string;
  model: string;
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

async function getStore(): Promise<Store> {
  return load(STORE_NAME, { defaults: {}, autoSave: true });
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
    value === "sakura"
  );
}

export async function loadSettings(): Promise<AiSettings> {
  const store = await getStore();
  const storedProvider = await store.get("provider");
  const provider = isProvider(storedProvider) ? storedProvider : DEFAULT_PROVIDER;

  const config = await loadProviderConfig();
  const entry = getProviderEntry(config, provider);

  const legacyReasoningEffort = await store.get<string>("reasoningEffort");
  const legacyThinkingEnabled = await store.get<boolean>("thinkingEnabled");
  const legacyThinkingBudget = await store.get<number>("thinkingBudget");

  let model = ((await store.get<string>("model")) ?? "").trim();
  if (!model) {
    model = entry?.defaultModel ?? "";
  }
  // DeepSeek の旧モデル名を v4 系に移行する。
  // legacy: deepseek-chat    -> v4-flash + thinking disabled
  // legacy: deepseek-reasoner -> v4-flash + thinking enabled
  if (provider === "deepseek" && model === "deepseek-chat") {
    console.warn('[phenex:settings] migrating legacy DeepSeek model "deepseek-chat" to "deepseek-v4-flash"');
    model = "deepseek-v4-flash";
  } else if (provider === "deepseek" && model === "deepseek-reasoner") {
    console.warn('[phenex:settings] migrating legacy DeepSeek model "deepseek-reasoner" to "deepseek-v4-flash" with thinking enabled');
    model = "deepseek-v4-flash";
  }

  const modelDefaults = getProviderModelDefaults(entry, model);

  const base: AiSettings = {
    provider,
    apiKey: ((await store.get<string>("apiKey")) ?? "").trim(),
    baseUrl: ((await store.get<string>("baseUrl")) ?? "").trim() || (entry?.defaultBaseUrl ?? ""),
    model,
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

export async function saveSettings(settings: AiSettings): Promise<void> {
  const store = await getStore();
  await store.set("provider", settings.provider);
  await store.set("apiKey", settings.apiKey);
  await store.set("baseUrl", settings.baseUrl);
  await store.set("model", settings.model);
  await store.set("temperature", settings.temperature);
  await store.set("maxTokens", settings.maxTokens);
  await store.set("maxContextTokens", settings.maxContextTokens);
  await store.set("topP", settings.topP);
  await store.set("topK", settings.topK);
  await store.set("frequencyPenalty", settings.frequencyPenalty);
  await store.set("presencePenalty", settings.presencePenalty);
  await store.set("openaiReasoningEffort", settings.openaiReasoningEffort);
  await store.set("deepseekReasoningEffort", settings.deepseekReasoningEffort);
  await store.set("anthropicThinkingEnabled", settings.anthropicThinkingEnabled);
  await store.set("anthropicThinkingBudget", settings.anthropicThinkingBudget);
  await store.save();
}
