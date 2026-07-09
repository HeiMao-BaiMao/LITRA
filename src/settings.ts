import { load, Store } from "@tauri-apps/plugin-store";
import {
  loadProviderConfig,
  getProviderEntry,
  getProviderModelDefaults,
  isFixedModelSelection,
  type ProviderModelDefaults,
  resetProviderConfig,
} from "./providers/config.ts";
import { clearPanelRatios } from "./layout-store.ts";
import { clearWindowState } from "./window/bounds.ts";
import { apiKeySecretKey, secretDelete, secretGet, setOrDeleteSecret } from "./secrets.ts";

export type Provider = "openai" | "anthropic" | "deepseek" | "google" | "llamacpp" | "sakura" | "plamo" | "opencode";
export type OpenAIReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type DeepSeekReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type GoogleThinkingLevel = "minimal" | "low" | "medium" | "high";
export type ChatSubmitShortcut = "ctrlEnter" | "enter";

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
  backgroundProvider?: Provider;
  backgroundModel?: string;
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
  googleThinkingLevel?: GoogleThinkingLevel;
  twoStageContinuation?: boolean;
  continuationReviewEnabled?: boolean;
  continuationUseBackgroundModel?: boolean;
  continuationSceneStateEnabled?: boolean;
  continuationCharacterVoiceEnabled?: boolean;
  continuationBestOfTwo?: boolean;
  continuationTargetedRevision?: boolean;
  continuationBeatSplitEnabled?: boolean;
  chatSubmitShortcut: ChatSubmitShortcut;
}

const STORE_NAME = "litra-settings.json";
const LEGACY_STORE_NAME = "phenex-settings.json";

const DEFAULT_PROVIDER: Provider = "openai";

const ALL_PROVIDERS: Provider[] = ["openai", "anthropic", "deepseek", "google", "llamacpp", "sakura", "plamo", "opencode"];

const SETTINGS_STORE_KEYS = [
  "provider",
  "apiKey",
  "baseUrl",
  "model",
  "providerConfigs",
  "chatProvider",
  "chatModel",
  "backgroundProvider",
  "backgroundModel",
  "temperature",
  "maxTokens",
  "maxContextTokens",
  "topP",
  "topK",
  "frequencyPenalty",
  "presencePenalty",
  "reasoningEffort",
  "thinkingEnabled",
  "thinkingBudget",
  "openaiReasoningEffort",
  "deepseekReasoningEffort",
  "anthropicThinkingEnabled",
  "anthropicThinkingBudget",
  "googleThinkingLevel",
  "twoStageContinuation",
  "continuationReviewEnabled",
  "continuationUseBackgroundModel",
  "continuationSceneStateEnabled",
  "continuationCharacterVoiceEnabled",
  "continuationBestOfTwo",
  "continuationTargetedRevision",
  "continuationBeatSplitEnabled",
  "chatSubmitShortcut",
] as const;

let legacyStoreMigrationChecked = false;

async function getStore(): Promise<Store> {
  const store = await load(STORE_NAME, { defaults: {}, autoSave: true });
  await migrateLegacySettingsStore(store);
  return store;
}

export async function resetAllSettings(): Promise<void> {
  const store = await getStore();
  await store.clear();
  await store.save();
  await clearPanelRatios();
  await clearWindowState();
  await resetProviderConfig();
  for (const p of ALL_PROVIDERS) {
    await secretDelete(apiKeySecretKey(p)).catch(() => {});
  }
  await secretDelete("webdav:password").catch(() => {});
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function trimmedString(value: unknown): string {
  return optionalString(value)?.trim() ?? "";
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

function isGoogleThinkingLevel(value: unknown): value is GoogleThinkingLevel {
  return value === "minimal" || value === "low" || value === "medium" || value === "high";
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

function isChatSubmitShortcut(value: unknown): value is ChatSubmitShortcut {
  return value === "ctrlEnter" || value === "enter";
}

function isProviderConfigRecord(value: unknown): value is Partial<Record<Provider, Partial<ProviderSpecificSettings>>> {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return ALL_PROVIDERS.some((provider) => {
    const config = record[provider];
    if (typeof config !== "object" || config === null) return false;
    const fields = config as Record<string, unknown>;
    return ["apiKey", "baseUrl", "model"].some((key) => typeof fields[key] === "string");
  });
}

async function storeHasAny(store: Store, keys: readonly string[]): Promise<boolean> {
  for (const key of keys) {
    if ((await store.get(key)) !== undefined) return true;
  }
  return false;
}

async function legacySettingsStoreLooksValid(store: Store): Promise<boolean> {
  if (isProvider(await store.get("provider"))) return true;
  if (isProviderConfigRecord(await store.get("providerConfigs"))) return true;
  return false;
}

async function migrateLegacySettingsStore(store: Store): Promise<void> {
  if (legacyStoreMigrationChecked) return;
  legacyStoreMigrationChecked = true;
  if (await storeHasAny(store, SETTINGS_STORE_KEYS)) return;

  const legacyStore = await load(LEGACY_STORE_NAME, { defaults: {}, autoSave: false });
  if (!(await legacySettingsStoreLooksValid(legacyStore))) return;

  for (const key of SETTINGS_STORE_KEYS) {
    const value = await legacyStore.get(key);
    if (value !== undefined) {
      await store.set(key, value);
    }
  }
  await store.save();
}

function migrateLegacyModel(provider: Provider, model: string): string {
  if (provider === "deepseek" && model === "deepseek-chat") {
    console.warn('[litra:settings] migrating legacy DeepSeek model "deepseek-chat" to "deepseek-v4-flash"');
    return "deepseek-v4-flash";
  }
  if (provider === "deepseek" && model === "deepseek-reasoner") {
    console.warn(
      '[litra:settings] migrating legacy DeepSeek model "deepseek-reasoner" to "deepseek-v4-flash" with thinking enabled',
    );
    return "deepseek-v4-flash";
  }
  return model;
}

/// 固定モデル選択方式のプロバイダーで、保存済みモデルが一覧に無い場合は
/// 既定モデルへ正規化する（providers.json の modelSelection: "fixed" に連動）。
function normalizeProviderModel(
  isFixedSelection: boolean,
  model: string,
  defaultModel: string,
  configuredModels: string[],
): string {
  if (isFixedSelection && configuredModels.length > 0 && !configuredModels.includes(model)) {
    return defaultModel;
  }
  return model;
}

/**
 * OpenCode Go は利用枠が強く効くため output はモデル既定で上限を守る。
 * context は保存済み設定が小さい場合でも、モデルの公称上限まで引き上げる。
 */
function applyProviderCapacityCap(
  provider: Provider,
  settings: Pick<AiSettings, "maxTokens" | "maxContextTokens">,
  defaults: ProviderModelDefaults | undefined,
): void {
  if (provider !== "opencode" || !defaults) return;
  if (defaults.maxTokens !== undefined) {
    settings.maxTokens = Math.min(settings.maxTokens, defaults.maxTokens);
  }
  if (defaults.maxContextTokens !== undefined) {
    settings.maxContextTokens = defaults.maxContextTokens;
  }
}

export async function loadSettings(): Promise<AiSettings> {
  const store = await getStore();
  const storedProvider = await store.get("provider");
  const provider = isProvider(storedProvider) ? storedProvider : DEFAULT_PROVIDER;

  const config = await loadProviderConfig();

  const legacyReasoningEffort = await store.get<string>("reasoningEffort");
  const legacyThinkingEnabled = await store.get<boolean>("thinkingEnabled");
  const legacyThinkingBudget = await store.get<number>("thinkingBudget");

  const legacyApiKey = trimmedString(await store.get("apiKey"));
  const legacyBaseUrl = trimmedString(await store.get("baseUrl"));
  const legacyModel = trimmedString(await store.get("model"));

  const storedProviderConfigs = await store.get<unknown>("providerConfigs");
  const previousConfigs: Partial<Record<Provider, Partial<ProviderSpecificSettings>>> =
    typeof storedProviderConfigs === "object" && storedProviderConfigs !== null
      ? (storedProviderConfigs as Partial<Record<Provider, Partial<ProviderSpecificSettings>>>)
      : {};

  const providerConfigs = {} as Record<Provider, ProviderSpecificSettings>;
  let needsScrub = false;

  for (const p of ALL_PROVIDERS) {
    const entry = getProviderEntry(config, p);
    const previous = previousConfigs[p] ?? {};

    let model = trimmedString(previous.model);
    let baseUrl = trimmedString(previous.baseUrl);

    const legacyPlainApiKey = trimmedString(previous.apiKey) || (p === provider ? legacyApiKey : "");
    const keyringApiKey = trimmedString(await secretGet(apiKeySecretKey(p)));

    let apiKey: string;
    if (keyringApiKey) {
      apiKey = keyringApiKey;
    } else if (legacyPlainApiKey) {
      // 移行: JSON ストアに残っていた平文 apiKey を keyring へ移す
      await setOrDeleteSecret(apiKeySecretKey(p), legacyPlainApiKey);
      apiKey = legacyPlainApiKey;
      needsScrub = true;
    } else {
      apiKey = "";
    }

    if (p === provider) {
      if (!model) model = legacyModel;
      if (!baseUrl) baseUrl = legacyBaseUrl;
    }

    const defaultModel = entry?.defaultModel ?? "";
    const configuredModels = entry?.models?.map((entryModel) => entryModel.id) ?? [];
    if (!model) model = defaultModel;
    if (!baseUrl) baseUrl = entry?.defaultBaseUrl ?? "";

    model = migrateLegacyModel(p, model);
    model = normalizeProviderModel(isFixedModelSelection(entry), model, defaultModel, configuredModels);

    providerConfigs[p] = { apiKey, baseUrl, model };
  }

  if (needsScrub || legacyApiKey) {
    const scrubbed = {} as Record<Provider, ProviderSpecificSettings>;
    for (const p of ALL_PROVIDERS) {
      scrubbed[p] = { ...providerConfigs[p], apiKey: "" };
    }
    await store.set("providerConfigs", scrubbed);
    await store.set("apiKey", ""); // 旧共有フィールドの平文も消す
    await store.save();
  }

  const activeConfig = providerConfigs[provider];
  const model = activeConfig.model;
  const modelDefaults = getProviderModelDefaults(getProviderEntry(config, provider), model);

  const chatProvider = await store.get("chatProvider");
  const chatModel = trimmedString(await store.get("chatModel"));

  const backgroundProviderRaw = await store.get("backgroundProvider");
  const backgroundProvider = isProvider(backgroundProviderRaw) ? backgroundProviderRaw : undefined;
  const backgroundModel = trimmedString(await store.get("backgroundModel"));

  const base: AiSettings = {
    provider,
    apiKey: activeConfig.apiKey,
    baseUrl: activeConfig.baseUrl,
    model,
    providerConfigs,
    chatProvider: isProvider(chatProvider) ? chatProvider : undefined,
    chatModel: chatModel || undefined,
    backgroundProvider,
    backgroundModel: backgroundModel || undefined,
    temperature: optionalNumber(await store.get("temperature")) ?? modelDefaults?.temperature ?? 0.7,
    maxTokens: optionalNumber(await store.get("maxTokens")) ?? modelDefaults?.maxTokens ?? 8192,
    maxContextTokens: optionalNumber(await store.get("maxContextTokens")) ?? modelDefaults?.maxContextTokens ?? 65536,
    topP: optionalNumber(await store.get("topP")) ?? modelDefaults?.topP,
    topK: optionalNumber(await store.get("topK")) ?? modelDefaults?.topK,
    frequencyPenalty: optionalNumber(await store.get("frequencyPenalty")) ?? modelDefaults?.frequencyPenalty,
    presencePenalty: optionalNumber(await store.get("presencePenalty")) ?? modelDefaults?.presencePenalty,
    twoStageContinuation: optionalBoolean(await store.get("twoStageContinuation")),
    continuationReviewEnabled: optionalBoolean(await store.get("continuationReviewEnabled")),
    continuationUseBackgroundModel: optionalBoolean(await store.get("continuationUseBackgroundModel")),
    continuationSceneStateEnabled: optionalBoolean(await store.get("continuationSceneStateEnabled")),
    continuationCharacterVoiceEnabled: optionalBoolean(await store.get("continuationCharacterVoiceEnabled")),
    continuationBestOfTwo: optionalBoolean(await store.get("continuationBestOfTwo")),
    continuationTargetedRevision: optionalBoolean(await store.get("continuationTargetedRevision")),
    continuationBeatSplitEnabled: optionalBoolean(await store.get("continuationBeatSplitEnabled")),
    chatSubmitShortcut: isChatSubmitShortcut(await store.get("chatSubmitShortcut"))
      ? (await store.get("chatSubmitShortcut") as ChatSubmitShortcut)
      : "ctrlEnter",
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
  } else if (provider === "google") {
    base.googleThinkingLevel =
      (isGoogleThinkingLevel(await store.get("googleThinkingLevel"))
        ? (await store.get("googleThinkingLevel") as GoogleThinkingLevel)
        : undefined) ??
      (isGoogleThinkingLevel(modelDefaults?.googleThinkingLevel) ? modelDefaults.googleThinkingLevel : undefined);
  }

  applyProviderCapacityCap(provider, base, modelDefaults);

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
  await store.set("apiKey", ""); // 平文はもう保存しない（後方互換フィールドは常に空）
  await store.set("baseUrl", settings.baseUrl);
  await store.set("model", settings.model);

  const scrubbedProviderConfigs = {} as Record<Provider, ProviderSpecificSettings>;
  for (const p of ALL_PROVIDERS) {
    const specific = settings.providerConfigs[p];
    await setOrDeleteSecret(apiKeySecretKey(p), specific?.apiKey);
    scrubbedProviderConfigs[p] = { ...specific, apiKey: "" };
  }
  await store.set("providerConfigs", scrubbedProviderConfigs);

  await store.set("chatProvider", settings.chatProvider ?? null);
  await store.set("chatModel", settings.chatModel ?? null);
  await store.set("backgroundProvider", settings.backgroundProvider ?? null);
  await store.set("backgroundModel", settings.backgroundModel ?? null);
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
  await setIfDefined(store, "googleThinkingLevel", settings.googleThinkingLevel);
  await setIfDefined(store, "twoStageContinuation", settings.twoStageContinuation);
  await setIfDefined(store, "continuationReviewEnabled", settings.continuationReviewEnabled);
  await setIfDefined(store, "continuationUseBackgroundModel", settings.continuationUseBackgroundModel);
  await setIfDefined(store, "continuationSceneStateEnabled", settings.continuationSceneStateEnabled);
  await setIfDefined(store, "continuationCharacterVoiceEnabled", settings.continuationCharacterVoiceEnabled);
  await setIfDefined(store, "continuationBestOfTwo", settings.continuationBestOfTwo);
  await setIfDefined(store, "continuationTargetedRevision", settings.continuationTargetedRevision);
  await setIfDefined(store, "continuationBeatSplitEnabled", settings.continuationBeatSplitEnabled);
  await store.set("chatSubmitShortcut", settings.chatSubmitShortcut);
  await store.save();
}

export function getProviderSpecificSettings(
  settings: AiSettings,
  provider: Provider,
): ProviderSpecificSettings {
  const specific = settings.providerConfigs?.[provider];
  return {
    apiKey: trimmedString(specific?.apiKey),
    baseUrl: trimmedString(specific?.baseUrl),
    model: trimmedString(specific?.model),
  };
}

export function resolveChatSettings(settings: AiSettings): AiSettings {
  const provider = settings.chatProvider ?? settings.provider;
  const specific = getProviderSpecificSettings(settings, provider);
  const chatModel = trimmedString(settings.chatModel);
  return {
    ...settings,
    provider,
    apiKey: specific.apiKey,
    baseUrl: specific.baseUrl,
    model: chatModel || specific.model,
  };
}

/**
 * 要約や整合性チェックなどバックグラウンドタスク用の設定を解決する。
 * フォールバック順序: backgroundProvider ?? chatProvider ?? provider
 * モデル: backgroundModel ?? chatModel ?? specific.model
 */
export function resolveBackgroundSettings(settings: AiSettings): AiSettings {
  const provider = settings.backgroundProvider ?? settings.chatProvider ?? settings.provider;
  const specific = getProviderSpecificSettings(settings, provider);
  const backgroundModel = trimmedString(settings.backgroundModel);
  const fallbackModel = trimmedString(settings.chatModel);
  return {
    ...settings,
    provider,
    apiKey: specific.apiKey,
    baseUrl: specific.baseUrl,
    model: backgroundModel || fallbackModel || specific.model,
  };
}

export function getActiveProvider(settings: AiSettings): Provider {
  return settings.chatProvider ?? settings.provider;
}
