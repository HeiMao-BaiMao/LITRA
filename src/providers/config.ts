import {
  BaseDirectory,
  exists,
  mkdir,
  readTextFile,
  remove,
  writeTextFile,
} from "@tauri-apps/plugin-fs";

export type SdkType = "openai" | "anthropic" | "google";

/// Rust AI コアが扱う wire protocol。プロバイダー名やモデル名から推測せず、
/// providers.json の接続定義で明示する。
export type ProviderApiType =
  | "openai-responses"
  | "openai-chat"
  | "anthropic-messages"
  | "google-generate-content";

/// 1プロバイダー内で利用できる接続先。モデルは `connection` でこの id を参照する。
export interface ProviderConnection {
  id: string;
  apiType: ProviderApiType;
  baseUrl: string;
}

/// モデル選択方式。
/// - "fixed": `models` 一覧からの固定選択（取得ボタンは無効化される）
/// - "fetch": 自由入力＋プロバイダー API からのモデル一覧取得
export type ModelSelectionMode = "fixed" | "fetch";

/// アプリ更新時の既定モデル定義とのマージ方針。
/// - "merge": 既定の models にユーザー定義を id 単位で上書きマージ（新モデルが自動追加される）
/// - "replace": ユーザー定義の models をそのまま使う（既定からの追加・復元をしない）
export type ModelsPolicy = "merge" | "replace";

/// 執筆系・判断系プロンプトの足場（規則ブロック）の詳細度。
/// prompts.ts の PromptScaffoldLevel と構造的に同一だが、config.ts は
/// プロンプト実装に依存させないためこちらで独立に定義する。
export type PromptScaffold = "full" | "light";

/// 推論/思考の種類。
/// - "openai": OpenAI / Codex Responses API の reasoningEffort
/// - "anthropic-adaptive": Anthropic adaptive thinking（常時有効、effort のみ）
/// - "anthropic-budget": Anthropic budget thinking（ON/OFF + budget）
/// - "deepseek": DeepSeek thinking（ON/OFF + effort）
/// - "google": Google Gemini thinkingLevel
export type ReasoningKind =
  | "openai"
  | "anthropic-adaptive"
  | "anthropic-budget"
  | "deepseek"
  | "google";

/// モデルが持つ推論/思考能力の記述メタデータ。
/// プロトコルごとに表示すべき UI コントロールと送信すべきオプションを決定する。
export interface ReasoningCapability {
  kind: ReasoningKind;
  /// 対応する effort 値の一覧（未指定の場合はその kind の既定値を使う）。
  supportedEfforts?: string[];
  /// thinking を無効化できるか（anthropic-budget / deepseek 向け）。
  canDisable?: boolean;
  /// 予算トークン指定に対応するか。
  supportsBudget?: boolean;
  /// 適応的思考の表示モード（anthropic-adaptive のみ）。
  display?: "summarized" | "detailed";
  /// 最小予算。
  minBudget?: number;
  /// 最大予算。
  maxBudget?: number;
  /// 既定の effort 値。
  defaultEffort?: string;
}

export interface ProviderModelDefaults {
  id: string;
  /// ProviderEntry.connections 内の接続 ID。省略時は defaultConnection を使う。
  connection?: string;
  label?: string;
  temperature?: number;
  maxTokens?: number;
  maxContextTokens?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  openaiReasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  deepseekReasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  anthropicThinkingEnabled?: boolean;
  anthropicThinkingBudget?: number;
  anthropicThinkingEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  /// Gemini 3 系のみ対応。Gemini 3 系は temperature/topP/topK の代わりにこちらで
  /// 思考の深さを指定する（両方は指定不可）。Gemma 系には存在しない概念のため未指定のままにする。
  googleThinkingLevel?: "minimal" | "low" | "medium" | "high";
  /// モデルの推論/思考能力に関するメタデータ。表示すべき UI コントロールと
  /// 送信すべきプロトコルオプションの決定に使う（プロバイダ単位ではなくモデル単位）。
  reasoningCapability?: ReasoningCapability;
  /// 執筆系工程（ドラフト・修正・リライト）向けの上書きプロファイル。
  writing?: ModelRoleProfile;
  /// 判断系工程（構想・査読・選定・カード生成・講評）向けの上書きプロファイル。
  judgment?: ModelRoleProfile;
}

/// モデル既定値のうち、役割（執筆系/判断系）ごとに上書きしたい値だけを持つ
/// 部分プロファイル。id を持たない点以外は ProviderModelDefaults の
/// パラメータ系フィールドと同じ形。
export interface ModelRoleProfile {
  temperature?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  openaiReasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  deepseekReasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  deepseekThinkingEnabled?: boolean;
  anthropicThinkingEnabled?: boolean;
  anthropicThinkingBudget?: number;
  anthropicThinkingEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  googleThinkingLevel?: "minimal" | "low" | "medium" | "high";
  promptScaffold?: PromptScaffold;
}

export interface ProviderEntry {
  id: string;
  name: string;
  sdkType: SdkType;
  defaultBaseUrl: string;
  defaultModel: string;
  /// 省略時は後方互換のため sdkType から接続を合成する。
  defaultConnection?: string;
  /// 同じプロバイダーで複数の wire protocol / base URL を利用できる。
  connections?: ProviderConnection[];
  requiresApiKey?: boolean;
  /// 省略時は "fetch"
  modelSelection?: ModelSelectionMode;
  /// 省略時は "merge"
  modelsPolicy?: ModelsPolicy;
  models?: ProviderModelDefaults[];
}

export interface ProviderConfig {
  providers: ProviderEntry[];
}

const CONFIG_FILE = "providers.json";
const BASE_DIR = BaseDirectory.AppConfig;

import defaultProviders from "./default-providers.json" with { type: "json" };

const DEFAULT_CONFIG: ProviderConfig = defaultProviders as ProviderConfig;
let cachedConfig: ProviderConfig = DEFAULT_CONFIG;

/** 同期APIしか持たない移行期間中の呼び出し層向け。loadProviderConfig 後はユーザー設定を返す。 */
export function getCachedProviderConfig(): ProviderConfig {
  return cachedConfig;
}

async function initializeDefaultConfig(): Promise<void> {
  await mkdir("", { baseDir: BASE_DIR, recursive: true });
  const text = JSON.stringify(DEFAULT_CONFIG, null, 2);
  await writeTextFile(CONFIG_FILE, text, { baseDir: BASE_DIR });
}

function mergeDefaultModels(
  existingModels: ProviderModelDefaults[] | undefined,
  defaultModels: ProviderModelDefaults[] | undefined,
): ProviderModelDefaults[] | undefined {
  if (!existingModels && !defaultModels) return undefined;

  const mergedById = new Map<string, ProviderModelDefaults>();
  for (const model of defaultModels ?? []) {
    mergedById.set(model.id, model);
  }
  for (const model of existingModels ?? []) {
    mergedById.set(model.id, {
      ...(mergedById.get(model.id) ?? {}),
      ...model,
    });
  }

  return Array.from(mergedById.values());
}

function mergeDefaultConnections(
  existingConnections: ProviderConnection[] | undefined,
  defaultConnections: ProviderConnection[] | undefined,
): ProviderConnection[] | undefined {
  if (!existingConnections && !defaultConnections) return undefined;
  const mergedById = new Map<string, ProviderConnection>();
  for (const connection of defaultConnections ?? []) mergedById.set(connection.id, connection);
  for (const connection of existingConnections ?? []) {
    mergedById.set(connection.id, {
      ...(mergedById.get(connection.id) ?? {}),
      ...connection,
    });
  }
  return Array.from(mergedById.values());
}

function mergeDefaultProviders(config: ProviderConfig): ProviderConfig {
  const existingById = new Map(config.providers.map((p) => [p.id, p]));
  const merged: ProviderEntry[] = [];

  for (const defaultProvider of DEFAULT_CONFIG.providers) {
    const existing = existingById.get(defaultProvider.id);
    if (existing) {
      // ユーザーが providers.json で編集した値を優先する。
      // 既定値はユーザー側に無いフィールドの補完と、新モデルの追加にのみ使う。
      merged.push({
        ...defaultProvider,
        ...existing,
        defaultBaseUrl: existing.defaultBaseUrl || defaultProvider.defaultBaseUrl,
        defaultModel: existing.defaultModel || defaultProvider.defaultModel,
        defaultConnection: existing.defaultConnection || defaultProvider.defaultConnection,
        connections: mergeDefaultConnections(existing.connections, defaultProvider.connections),
        requiresApiKey: existing.requiresApiKey ?? defaultProvider.requiresApiKey,
        models:
          (existing.modelsPolicy ?? "merge") === "replace"
            ? existing.models
            : mergeDefaultModels(existing.models, defaultProvider.models),
      });
      existingById.delete(defaultProvider.id);
    } else {
      merged.push(defaultProvider);
    }
  }

  merged.push(...existingById.values());

  return { providers: merged };
}

export async function resetProviderConfig(): Promise<void> {
  const fileExists = await exists(CONFIG_FILE, { baseDir: BASE_DIR });
  if (fileExists) {
    await remove(CONFIG_FILE, { baseDir: BASE_DIR });
  }
}

export async function loadProviderConfig(): Promise<ProviderConfig> {
  const fileExists = await exists(CONFIG_FILE, { baseDir: BASE_DIR });
  if (!fileExists) {
    await initializeDefaultConfig();
  }

  const text = await readTextFile(CONFIG_FILE, { baseDir: BASE_DIR });
  const parsed: unknown = JSON.parse(text);

  if (!isProviderConfig(parsed)) {
    throw new Error("providers.json の形式が不正です。");
  }

  const merged = mergeDefaultProviders(parsed);
  cachedConfig = merged;
  if (JSON.stringify(merged) !== JSON.stringify(parsed)) {
    await writeTextFile(CONFIG_FILE, JSON.stringify(merged, null, 2), { baseDir: BASE_DIR });
  }

  return merged;
}

export function getProviderEntry(
  config: ProviderConfig,
  providerId: string,
): ProviderEntry | undefined {
  return config.providers.find((provider) => provider.id === providerId);
}

export function getProviderModelDefaults(
  provider: ProviderEntry | undefined,
  modelId: string,
): ProviderModelDefaults | undefined {
  return provider?.models?.find((model) => model.id === modelId);
}

export interface ResolvedProviderConnection {
  id: string;
  apiType: ProviderApiType;
  baseUrl: string;
}

/** モデルに対応する接続を providers.json から解決する。 */
export function resolveProviderConnection(
  provider: ProviderEntry | undefined,
  modelId: string,
  configuredBaseUrl?: string,
): ResolvedProviderConnection | undefined {
  if (!provider) return undefined;
  const model = getProviderModelDefaults(provider, modelId);
  const connectionId = model?.connection ?? provider.defaultConnection;
  const configured = connectionId
    ? provider.connections?.find((connection) => connection.id === connectionId)
    : provider.connections?.[0];
  if (configured) {
    const override = configuredBaseUrl?.trim();
    const baseUrl = override && override !== provider.defaultBaseUrl
      ? override
      : configured.baseUrl;
    return {
      ...configured,
      baseUrl,
    };
  }

  // 旧 providers.json / ユーザー追加プロバイダーの後方互換。
  const apiType: ProviderApiType =
    provider.sdkType === "anthropic"
      ? "anthropic-messages"
      : provider.sdkType === "google"
        ? "google-generate-content"
        : "openai-chat";
  return {
    id: "legacy-default",
    apiType,
    baseUrl: configuredBaseUrl?.trim() || provider.defaultBaseUrl,
  };
}

export function getProviderModelIds(provider: ProviderEntry | undefined): string[] {
  return provider?.models?.map((model) => model.id) ?? [];
}

export function providerRequiresApiKey(provider: ProviderEntry | undefined): boolean {
  return provider?.requiresApiKey ?? true;
}

/// プロバイダーが固定モデル選択方式かどうか。
/// `modelSelection: "fixed"` かつ models が 1 件以上定義されている場合のみ true
/// （models が空だと選択肢が無くなり操作不能になるため、その場合は fetch 扱い）。
export function isFixedModelSelection(provider: ProviderEntry | undefined): boolean {
  return provider?.modelSelection === "fixed" && (provider.models?.length ?? 0) > 0;
}

function isModelRoleProfile(value: unknown): value is ModelRoleProfile {
  if (typeof value !== "object" || value === null) return false;
  const profile = value as Partial<ModelRoleProfile>;
  return (
    (profile.temperature === undefined || typeof profile.temperature === "number") &&
    (profile.topP === undefined || typeof profile.topP === "number") &&
    (profile.topK === undefined || typeof profile.topK === "number") &&
    (profile.frequencyPenalty === undefined || typeof profile.frequencyPenalty === "number") &&
    (profile.presencePenalty === undefined || typeof profile.presencePenalty === "number") &&
    (profile.openaiReasoningEffort === undefined ||
      profile.openaiReasoningEffort === "none" ||
      profile.openaiReasoningEffort === "minimal" ||
      profile.openaiReasoningEffort === "low" ||
      profile.openaiReasoningEffort === "medium" ||
      profile.openaiReasoningEffort === "high" ||
      profile.openaiReasoningEffort === "xhigh") &&
    (profile.deepseekReasoningEffort === undefined ||
      profile.deepseekReasoningEffort === "low" ||
      profile.deepseekReasoningEffort === "medium" ||
      profile.deepseekReasoningEffort === "high" ||
      profile.deepseekReasoningEffort === "xhigh" ||
      profile.deepseekReasoningEffort === "max") &&
    (profile.deepseekThinkingEnabled === undefined || typeof profile.deepseekThinkingEnabled === "boolean") &&
    (profile.anthropicThinkingEnabled === undefined || typeof profile.anthropicThinkingEnabled === "boolean") &&
    (profile.anthropicThinkingBudget === undefined || typeof profile.anthropicThinkingBudget === "number") &&
    (profile.anthropicThinkingEffort === undefined ||
      profile.anthropicThinkingEffort === "low" ||
      profile.anthropicThinkingEffort === "medium" ||
      profile.anthropicThinkingEffort === "high" ||
      profile.anthropicThinkingEffort === "xhigh" ||
      profile.anthropicThinkingEffort === "max") &&
    (profile.googleThinkingLevel === undefined ||
      profile.googleThinkingLevel === "minimal" ||
      profile.googleThinkingLevel === "low" ||
      profile.googleThinkingLevel === "medium" ||
      profile.googleThinkingLevel === "high") &&
    (profile.promptScaffold === undefined || profile.promptScaffold === "full" || profile.promptScaffold === "light")
  );
}

function isProviderModelDefaults(value: unknown): value is ProviderModelDefaults {
  if (typeof value !== "object" || value === null) return false;
  const model = value as Partial<ProviderModelDefaults>;
  return (
    typeof model.id === "string" &&
    (model.connection === undefined || typeof model.connection === "string") &&
    (model.label === undefined || typeof model.label === "string") &&
    (model.temperature === undefined || typeof model.temperature === "number") &&
    (model.maxTokens === undefined || typeof model.maxTokens === "number") &&
    (model.maxContextTokens === undefined || typeof model.maxContextTokens === "number") &&
    (model.topP === undefined || typeof model.topP === "number") &&
    (model.topK === undefined || typeof model.topK === "number") &&
    (model.frequencyPenalty === undefined || typeof model.frequencyPenalty === "number") &&
    (model.presencePenalty === undefined || typeof model.presencePenalty === "number") &&
    (model.openaiReasoningEffort === undefined ||
      model.openaiReasoningEffort === "none" ||
      model.openaiReasoningEffort === "minimal" ||
      model.openaiReasoningEffort === "low" ||
      model.openaiReasoningEffort === "medium" ||
      model.openaiReasoningEffort === "high" ||
      model.openaiReasoningEffort === "xhigh") &&
    (model.deepseekReasoningEffort === undefined ||
      model.deepseekReasoningEffort === "low" ||
      model.deepseekReasoningEffort === "medium" ||
      model.deepseekReasoningEffort === "high" ||
      model.deepseekReasoningEffort === "xhigh" ||
      model.deepseekReasoningEffort === "max") &&
    (model.anthropicThinkingEnabled === undefined || typeof model.anthropicThinkingEnabled === "boolean") &&
    (model.anthropicThinkingBudget === undefined || typeof model.anthropicThinkingBudget === "number") &&
    (model.googleThinkingLevel === undefined ||
      model.googleThinkingLevel === "minimal" ||
      model.googleThinkingLevel === "low" ||
      model.googleThinkingLevel === "medium" ||
      model.googleThinkingLevel === "high") &&
    (model.reasoningCapability === undefined || true) &&
    (model.writing === undefined || isModelRoleProfile(model.writing)) &&
    (model.judgment === undefined || isModelRoleProfile(model.judgment))
  );
}

function isProviderConfig(value: unknown): value is ProviderConfig {
  if (typeof value !== "object" || value === null) return false;
  const config = value as Partial<ProviderConfig>;
  if (!Array.isArray(config.providers)) return false;

  return config.providers.every((provider) => {
    const p = provider as Partial<ProviderEntry>;
    return (
      typeof p.id === "string" &&
      typeof p.name === "string" &&
      (p.sdkType === "openai" || p.sdkType === "anthropic" || p.sdkType === "google") &&
      typeof p.defaultBaseUrl === "string" &&
      typeof p.defaultModel === "string" &&
      (p.defaultConnection === undefined || typeof p.defaultConnection === "string") &&
      (p.connections === undefined ||
        (Array.isArray(p.connections) && p.connections.every(isProviderConnection))) &&
      (p.requiresApiKey === undefined || typeof p.requiresApiKey === "boolean") &&
      (p.modelSelection === undefined || p.modelSelection === "fixed" || p.modelSelection === "fetch") &&
      (p.modelsPolicy === undefined || p.modelsPolicy === "merge" || p.modelsPolicy === "replace") &&
      (p.models === undefined || (Array.isArray(p.models) && p.models.every(isProviderModelDefaults)))
    );
  });
}

function isProviderConnection(value: unknown): value is ProviderConnection {
  if (typeof value !== "object" || value === null) return false;
  const connection = value as Partial<ProviderConnection>;
  return (
    typeof connection.id === "string" &&
    typeof connection.baseUrl === "string" &&
    (connection.apiType === "openai-responses" ||
      connection.apiType === "openai-chat" ||
      connection.apiType === "anthropic-messages" ||
      connection.apiType === "google-generate-content")
  );
}
