import { load, Store } from "@tauri-apps/plugin-store";
import { loadProviderConfig, getProviderEntry } from "./providers/config.ts";

export type Provider = "openai" | "anthropic" | "deepseek" | "google";
export type OpenAIReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type DeepSeekReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type DeepSeekThinkingMode = "adaptive" | "enabled" | "disabled";

export interface AiSettings {
  provider: Provider;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  openaiReasoningEffort?: OpenAIReasoningEffort;
  deepseekThinkingMode?: DeepSeekThinkingMode;
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

function isDeepSeekThinkingMode(value: unknown): value is DeepSeekThinkingMode {
  return value === "adaptive" || value === "enabled" || value === "disabled";
}

export async function loadSettings(): Promise<AiSettings> {
  const store = await getStore();
  const provider = (await store.get<Provider>("provider")) ?? DEFAULT_PROVIDER;

  const config = await loadProviderConfig();
  const entry = getProviderEntry(config, provider);

  const legacyReasoningEffort = await store.get<string>("reasoningEffort");
  const legacyThinkingEnabled = await store.get<boolean>("thinkingEnabled");
  const legacyThinkingBudget = await store.get<number>("thinkingBudget");

  const base: AiSettings = {
    provider,
    apiKey: (await store.get<string>("apiKey")) ?? "",
    baseUrl: (await store.get<string>("baseUrl")) ?? entry?.defaultBaseUrl ?? "",
    model: (await store.get<string>("model")) ?? entry?.defaultModel ?? "",
    temperature: (await store.get<number>("temperature")) ?? 0.7,
    maxTokens: (await store.get<number>("maxTokens")) ?? 8192,
    topP: optionalNumber(await store.get("topP")),
    topK: optionalNumber(await store.get("topK")),
    frequencyPenalty: optionalNumber(await store.get("frequencyPenalty")),
    presencePenalty: optionalNumber(await store.get("presencePenalty")),
  };

  // 旧共有フィールドからプロバイダー別フィールドへ移行
  if (provider === "openai") {
    base.openaiReasoningEffort =
      (isOpenAIReasoningEffort(await store.get("openaiReasoningEffort"))
        ? (await store.get("openaiReasoningEffort") as OpenAIReasoningEffort)
        : undefined) ??
      (isOpenAIReasoningEffort(legacyReasoningEffort) ? legacyReasoningEffort : undefined);
  } else if (provider === "deepseek") {
    base.deepseekThinkingMode = isDeepSeekThinkingMode(await store.get("deepseekThinkingMode"))
      ? (await store.get("deepseekThinkingMode") as DeepSeekThinkingMode)
      : undefined;
    base.deepseekReasoningEffort =
      (isDeepSeekReasoningEffort(await store.get("deepseekReasoningEffort"))
        ? (await store.get("deepseekReasoningEffort") as DeepSeekReasoningEffort)
        : undefined) ??
      (isDeepSeekReasoningEffort(legacyReasoningEffort) ? legacyReasoningEffort : undefined);
  } else if (provider === "anthropic") {
    base.anthropicThinkingEnabled =
      optionalBoolean(await store.get("anthropicThinkingEnabled")) ?? legacyThinkingEnabled ?? undefined;
    base.anthropicThinkingBudget =
      optionalNumber(await store.get("anthropicThinkingBudget")) ?? legacyThinkingBudget ?? undefined;
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
  await store.set("topP", settings.topP);
  await store.set("topK", settings.topK);
  await store.set("frequencyPenalty", settings.frequencyPenalty);
  await store.set("presencePenalty", settings.presencePenalty);
  await store.set("openaiReasoningEffort", settings.openaiReasoningEffort);
  await store.set("deepseekThinkingMode", settings.deepseekThinkingMode);
  await store.set("deepseekReasoningEffort", settings.deepseekReasoningEffort);
  await store.set("anthropicThinkingEnabled", settings.anthropicThinkingEnabled);
  await store.set("anthropicThinkingBudget", settings.anthropicThinkingBudget);
  await store.save();
}
