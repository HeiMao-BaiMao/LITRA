import { getElements } from "./layout.ts";
import type {
  AiSettings,
  AnthropicThinkingEffort,
  DeepSeekReasoningEffort,
  GoogleThinkingLevel,
  JudgmentModelSource,
  WritingModelSource,
  OpenAIReasoningEffort,
  Provider,
  ProviderSpecificSettings,
  RoleParamOverrides,
} from "../settings.ts";
import { getProviderEntry } from "../providers/config.ts";
import {
  getProviderModelDefaults,
  getProviderModelIds,
  isFixedModelSelection,
  type ProviderConfig,
  type ProviderEntry,
  type ProviderModelDefaults,
} from "../providers/config.ts";
import {
  getEffectiveCapability,
  getControlType,
  getSupportedEfforts,
  isThinkingAlwaysOn,
} from "../ai/capability.ts";
import {
  resolveChatRunSettings,
  resolveBackgroundRunSettings,
  resolveWritingRunSettings,
  resolveJudgmentRunSettings,
} from "../ai/role-settings.ts";
import { isGemini3Model } from "../ai/provider-options.ts";
import { type FixedModel } from "../ai/model-list.ts";
import {
  loadWebDavSyncConfig,
  type WebDavSyncConfig,
} from "../sync/webdav.ts";
import { loadExaApiKey } from "../websearch-settings.ts";
import {
  loginWithBrowserCode as codexBrowserLogin,
  readCodexCredential,
  deleteCodexCredential,
} from "../providers/codex-auth.ts";
import {
  loginWithDeviceCode as copilotLogin,
  readCopilotCredential,
  deleteCopilotCredential,
  getCopilotModelCacheEntry,
} from "../providers/copilot-auth.ts";

let modalProviderConfigs: Record<Provider, ProviderSpecificSettings> | null = null;
let modalProviderConfig: ProviderConfig | null = null;
let modalCurrentProvider: Provider = "openai";

/** OAuth ログイン中の AbortController（キャンセル用） */
let oauthAbortController: AbortController | null = null;

/** OAuth プロバイダーかどうか */
function isOAuthProvider(provider: Provider): boolean {
  return provider === "codex" || provider === "github-copilot";
}

interface ThirdPartyLicenseEntry {
  ecosystem: string;
  name: string;
  version: string;
  license: string;
  source?: string;
  homepage?: string;
}

interface ThirdPartyLicensePayload {
  appName: string;
  appVersion: string;
  entries: ThirdPartyLicenseEntry[];
}

const ALL_PROVIDERS: Provider[] = ["openai", "anthropic", "deepseek", "google", "llamacpp", "sakura", "plamo", "opencode", "codex", "github-copilot"];

/// providers.json の `modelSelection: "fixed"` なプロバイダーの固定選択肢を返す。
/// 固定方式でない（または設定未読込・models 空の）場合は undefined。
function getFixedModelOptions(provider: Provider): FixedModel[] | undefined {
  if (!modalProviderConfig) return undefined;
  const entry = getProviderEntry(modalProviderConfig, provider);
  if (!isFixedModelSelection(entry)) return undefined;
  return (entry?.models ?? []).map((model) => ({
    id: model.id,
    label: model.label ?? model.id,
  }));
}

function isFixedModelProvider(provider: Provider): boolean {
  return getFixedModelOptions(provider) !== undefined;
}

function captureProviderConfig(provider: Provider): void {
  if (!modalProviderConfigs) return;
  const {
    settingApiKey,
    settingBaseUrl,
    settingModel,
    settingModelSelect,
  } = getElements();
  const model = isFixedModelProvider(provider) ? settingModelSelect.value.trim() : settingModel.value.trim();
  modalProviderConfigs[provider] = {
    apiKey: settingApiKey.value.trim(),
    baseUrl: settingBaseUrl.value.trim(),
    model,
  };
}

function applyProviderConfig(provider: Provider): void {
  if (!modalProviderConfigs || !modalProviderConfig) return;
  const {
    settingApiKey,
    settingBaseUrl,
    settingModel,
    settingModelSelect,
  } = getElements();
  const entry = getProviderEntry(modalProviderConfig, provider);
  const config = modalProviderConfigs[provider] ?? {
    apiKey: "",
    baseUrl: entry?.defaultBaseUrl ?? "",
    model: entry?.defaultModel ?? "",
  };

  settingApiKey.value = config.apiKey;
  settingBaseUrl.value = config.baseUrl || (entry?.defaultBaseUrl ?? "");
  settingModel.value = config.model || (entry?.defaultModel ?? "");
  settingModelSelect.value = config.model || (entry?.defaultModel ?? "");
}

export function renderProviderOptions(config: ProviderConfig): void {
  const { settingProvider } = getElements();
  const currentValue = settingProvider.value;

  settingProvider.innerHTML = "";
  for (const provider of config.providers) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.name;
    settingProvider.appendChild(option);
  }

  if (currentValue) {
    settingProvider.value = currentValue;
  }
}

export function renderBackgroundProviderOptions(config: ProviderConfig): void {
  const { settingBackgroundProvider } = getElements();
  settingBackgroundProvider.innerHTML = "";
  const emptyOption = document.createElement("option");
  emptyOption.value = "";
  emptyOption.textContent = "チャット欄に同期";
  settingBackgroundProvider.appendChild(emptyOption);
  for (const provider of config.providers) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.name;
    settingBackgroundProvider.appendChild(option);
  }
}

function renderBackgroundModelOptions(
  config: ProviderConfig | null,
  provider: Provider | "",
  currentModel?: string,
): void {
  const { settingBackgroundModel } = getElements();
  settingBackgroundModel.innerHTML = "";
  const emptyOption = document.createElement("option");
  emptyOption.value = "";
  emptyOption.textContent = "チャット欄に同期";
  settingBackgroundModel.appendChild(emptyOption);

  if (provider !== "" && config) {
    const entry = getProviderEntry(config, provider);
    for (const model of entry?.models ?? []) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.label ?? model.id;
      settingBackgroundModel.appendChild(option);
    }
  }

  if (currentModel && Array.from(settingBackgroundModel.options).some((opt) => opt.value === currentModel)) {
    settingBackgroundModel.value = currentModel;
  } else {
    settingBackgroundModel.value = "";
  }
}

function renderJudgmentProviderOptions(config: ProviderConfig): void {
  const { settingJudgmentProvider } = getElements();
  settingJudgmentProvider.innerHTML = "";
  const emptyOption = document.createElement("option");
  emptyOption.value = "";
  emptyOption.textContent = "本文モデルと同じ";
  settingJudgmentProvider.appendChild(emptyOption);
  for (const provider of config.providers) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.name;
    settingJudgmentProvider.appendChild(option);
  }
}

function renderWritingProviderOptions(config: ProviderConfig): void {
  const { settingWritingProvider } = getElements();
  settingWritingProvider.innerHTML = "";
  for (const provider of config.providers) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.name;
    settingWritingProvider.appendChild(option);
  }
}

function renderWritingModelOptions(
  config: ProviderConfig | null,
  provider: Provider | "",
  currentModel?: string,
): void {
  const { settingWritingModel } = getElements();
  settingWritingModel.innerHTML = "";
  const emptyOption = document.createElement("option");
  emptyOption.value = "";
  emptyOption.textContent = "そのプロバイダーで設定済みのモデル";
  settingWritingModel.appendChild(emptyOption);
  if (provider !== "" && config) {
    const entry = getProviderEntry(config, provider);
    for (const model of entry?.models ?? []) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.label ?? model.id;
      settingWritingModel.appendChild(option);
    }
  }
  settingWritingModel.value = currentModel && Array.from(settingWritingModel.options).some((opt) => opt.value === currentModel)
    ? currentModel
    : "";
}

function renderJudgmentModelOptions(
  config: ProviderConfig | null,
  provider: Provider | "",
  currentModel?: string,
): void {
  const { settingJudgmentModel } = getElements();
  settingJudgmentModel.innerHTML = "";
  const emptyOption = document.createElement("option");
  emptyOption.value = "";
  emptyOption.textContent = "プロバイダ既定";
  settingJudgmentModel.appendChild(emptyOption);

  if (provider !== "" && config) {
    const entry = getProviderEntry(config, provider);
    for (const model of entry?.models ?? []) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.label ?? model.id;
      settingJudgmentModel.appendChild(option);
    }
  }

  if (currentModel && Array.from(settingJudgmentModel.options).some((opt) => opt.value === currentModel)) {
    settingJudgmentModel.value = currentModel;
  } else {
    settingJudgmentModel.value = "";
  }
}

// 判断系のプロバイダ・モデル行は source が「個別指定」のときだけ表示する。
// 行は settingJudgmentProvider を包む label 要素(index.html の chat-provider-row)。
function updateJudgmentCustomRowVisibility(source: string): void {
  const { settingJudgmentProvider } = getElements();
  settingJudgmentProvider.parentElement?.classList.toggle("hidden", source !== "custom");
}

function updateWritingCustomRowVisibility(source: string): void {
  const { settingWritingProvider } = getElements();
  settingWritingProvider.parentElement?.classList.toggle("hidden", source !== "custom");
}

function optionalNumberInput(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function parseOptionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseOpenAIReasoningEffort(value: string): OpenAIReasoningEffort | undefined {
  if (
    value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  return undefined;
}

function parseDeepSeekReasoningEffort(value: string): DeepSeekReasoningEffort | undefined {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max") {
    return value;
  }
  return undefined;
}

function parseAnthropicThinkingEffort(value: string): AnthropicThinkingEffort | undefined {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max") {
    return value;
  }
  return undefined;
}

function parseGoogleThinkingLevel(value: string): GoogleThinkingLevel | undefined {
  if (value === "minimal" || value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return undefined;
}

function parseJudgmentModelSource(value: string): JudgmentModelSource {
  if (value === "background" || value === "custom") return value;
  return "main";
}

function parseWritingModelSource(value: string): WritingModelSource {
  return value === "background" || value === "custom" ? value : "main";
}

// 役割別オーバーライドの deepseekThinkingEnabled を UI のセレクト値へ変換する。
// true→"on", false→"off", undefined→""(自動)
function deepseekThinkingToSelectValue(value: boolean | undefined): string {
  if (value === true) return "on";
  if (value === false) return "off";
  return "";
}

// 役割別パラメータの入力群から RoleParamOverrides を組み立てる。
// 空欄・""(自動)のキーは含めず、数値は NaN・範囲外を捨てる。
// 有効なキーが1つも無ければ undefined を返す(ストアに保存しない)。
function readRoleOverrides(
  temperatureInput: HTMLInputElement,
  topPInput: HTMLInputElement,
  scaffoldSelect: HTMLSelectElement,
  deepseekThinkingSelect: HTMLSelectElement,
): RoleParamOverrides | undefined {
  const overrides: RoleParamOverrides = {};

  const temperature = parseOptionalNumber(temperatureInput.value);
  if (temperature !== undefined && temperature >= 0 && temperature <= 2) {
    overrides.temperature = temperature;
  }
  const topP = parseOptionalNumber(topPInput.value);
  if (topP !== undefined && topP >= 0 && topP <= 1) {
    overrides.topP = topP;
  }
  const scaffold = scaffoldSelect.value;
  if (scaffold === "full" || scaffold === "light") {
    overrides.promptScaffold = scaffold;
  }
  const thinking = deepseekThinkingSelect.value;
  if (thinking === "on") {
    overrides.deepseekThinkingEnabled = true;
  } else if (thinking === "off") {
    overrides.deepseekThinkingEnabled = false;
  }

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

/// <select> の <option> を supportedEfforts にフィルターする。
/// 「未指定」(value="") の option は常に保持する。
/// 現在選択中の値が supportedEfforts に含まれない場合は空文字（未指定）にリセットする。
function filterEffortOptions(select: HTMLSelectElement | null, supportedEfforts: string[]): void {
  if (!select) return;
  const currentValue = select.value;
  // Rebuild instead of destructively filtering: a later model may support tiers
  // removed for the previous model.
  select.replaceChildren();
  const automatic = document.createElement("option");
  automatic.value = "";
  automatic.textContent = "未指定";
  select.appendChild(automatic);
  for (const effort of supportedEfforts) {
    const option = document.createElement("option");
    option.value = effort;
    option.textContent = effort;
    select.appendChild(option);
  }
  select.value = supportedEfforts.includes(currentValue) ? currentValue : "";
}

/// 選択されたモデルの reasoningCapability に基づいて、詳細設定内の
/// 集中思考/推論コントロール群を表示/非表示にする。
/// プロバイダー単位ではなくモデル単位で制御する。
/// モーダル外から（handleFetchModels 等）からも呼ばれるため export する。
export function updateAdvancedVisibility(provider: Provider, modelId?: string): void {
  const { advancedSettings } = getElements();
  const openaiGroup = advancedSettings.querySelector<HTMLElement>(".provider-field-openai");
  const deepseekGroup = advancedSettings.querySelector<HTMLElement>(".provider-field-deepseek");
  const anthropicGroup = advancedSettings.querySelector<HTMLElement>(".provider-field-anthropic");
  const googleGroup = advancedSettings.querySelector<HTMLElement>(".provider-field-google");
  const anthropicAdaptiveGroup = advancedSettings.querySelector<HTMLElement>(".provider-field-anthropic-adaptive");

  // モデルが未指定の場合は現在の providerConfigs から取得
  const resolvedModelId = modelId || (modalProviderConfigs?.[provider]?.model ?? "");

  // ProviderModelDefaults を検索して capability 解決に渡す（blocker 1）
  const entry = modalProviderConfig ? getProviderEntry(modalProviderConfig, provider) : undefined;
  const defaults = entry ? getProviderModelDefaults(entry, resolvedModelId) : undefined;

  // getEffectiveCapability で Copilot キャッシュ→curated→fallback の優先順位で解決（blocker 1, 2）
  const cap = getEffectiveCapability(provider, resolvedModelId, defaults, getCopilotModelCacheEntry);
  const controlType = getControlType(cap);
  const alwaysOn = isThinkingAlwaysOn(cap);

  // 全 reasoning グループをいったん hidden にする
  if (openaiGroup) openaiGroup.classList.add("hidden");
  if (deepseekGroup) deepseekGroup.classList.add("hidden");
  if (anthropicGroup) anthropicGroup.classList.add("hidden");
  if (googleGroup) googleGroup.classList.add("hidden");
  if (anthropicAdaptiveGroup) anthropicAdaptiveGroup.classList.add("hidden");

  // blocker 6: まず常に ON/OFF と budget 行を復帰（hidden 解除）してから、必要に応じて隠す
  const thinkingEnabledRow = advancedSettings.querySelector<HTMLElement>(".anthropic-thinking-enabled-row");
  const thinkingBudgetRow = advancedSettings.querySelector<HTMLElement>(".anthropic-thinking-budget-row");
  if (thinkingEnabledRow) thinkingEnabledRow.classList.remove("hidden");
  if (thinkingBudgetRow) thinkingBudgetRow.classList.remove("hidden");

  switch (controlType) {
    case "openai-reasoning-effort":
      if (openaiGroup) openaiGroup.classList.remove("hidden");
      // blocker 3: filter effort options
      filterEffortOptions(
        advancedSettings.querySelector<HTMLSelectElement>("#setting-openai-reasoning-effort"),
        getSupportedEfforts(cap),
      );
      break;
    case "anthropic-adaptive":
      if (anthropicAdaptiveGroup) anthropicAdaptiveGroup.classList.remove("hidden");
      // blocker 3: filter effort options
      filterEffortOptions(
        advancedSettings.querySelector<HTMLSelectElement>("#setting-anthropic-thinking-effort"),
        getSupportedEfforts(cap),
      );
      // 2-7: Opus 4.8 のように canDisable な adaptive モデルは、budget kind 用の
      // thinking ON/OFF チェックボックスを流用して表示する（最小実装）。
      // budget 入力欄（トークン数）は budget kind 専用のため、ここでは隠したままにする。
      if (cap?.canDisable === true) {
        if (anthropicGroup) anthropicGroup.classList.remove("hidden");
        if (thinkingBudgetRow) thinkingBudgetRow.classList.add("hidden");
      }
      break;
    case "anthropic-budget":
      if (anthropicGroup) anthropicGroup.classList.remove("hidden");
      break;
    case "deepseek":
      if (deepseekGroup) deepseekGroup.classList.remove("hidden");
      // blocker 3: filter effort options for DeepSeek
      filterEffortOptions(
        advancedSettings.querySelector<HTMLSelectElement>("#setting-deepseek-reasoning-effort"),
        getSupportedEfforts(cap),
      );
      break;
    case "google-thinking-level":
      if (googleGroup) googleGroup.classList.remove("hidden");
      // blocker 3: filter effort options for Google
      filterEffortOptions(
        advancedSettings.querySelector<HTMLSelectElement>("#setting-google-thinking-level"),
        getSupportedEfforts(cap),
      );
      break;
    default:
      break;
  }

  // blocker 6: 適応的思考モデルの場合のみ thinking ON/OFF と budget を非表示
  if (alwaysOn) {
    if (thinkingEnabledRow) thinkingEnabledRow.classList.add("hidden");
    if (thinkingBudgetRow) thinkingBudgetRow.classList.add("hidden");
  }
}

/** OAuth プロバイダーの場合、API キー行を隠して OAuth コントロールを表示する。 */
function updateOAuthControls(provider: Provider): void {
  const {
    settingApiKeyRow,
    settingOAuthRow,
    settingOAuthStatus,
    btnOAuthLogin,
    btnOAuthLogout,
    btnOAuthCancel,
  } = getElements();

  const isOAuth = isOAuthProvider(provider);
  settingApiKeyRow.classList.toggle("hidden", isOAuth);
  settingOAuthRow.classList.toggle("hidden", !isOAuth);

  if (isOAuth) {
    // ボタン類を既定状態に戻す（ログインボタンのみ表示）
    btnOAuthLogin.classList.remove("hidden");
    btnOAuthLogout.classList.add("hidden");
    btnOAuthCancel.classList.add("hidden");
    settingOAuthStatus.textContent = "未ログイン";

    // 現在のログイン状態を確認して表示を更新
    void refreshOAuthStatus(provider);
  }
}

/** OAuth プロバイダーのログイン状態をキーリングから読み取って UI を更新する。 */
async function refreshOAuthStatus(provider: Provider): Promise<void> {
  const {
    settingOAuthStatus,
    settingOAuthUserCode,
    btnOAuthLogin,
    btnOAuthLogout,
  } = getElements();

  settingOAuthUserCode.classList.add("hidden");

  let loggedIn = false;
  if (provider === "codex") {
    const cred = await readCodexCredential();
    loggedIn = cred !== undefined;
  } else if (provider === "github-copilot") {
    const cred = await readCopilotCredential();
    loggedIn = cred !== undefined;
  }

  if (loggedIn) {
    settingOAuthStatus.textContent = "ログイン済み";
    btnOAuthLogin.classList.add("hidden");
    btnOAuthLogout.classList.remove("hidden");
  } else {
    settingOAuthStatus.textContent = "未ログイン";
    btnOAuthLogin.classList.remove("hidden");
    btnOAuthLogout.classList.add("hidden");
  }
}

/** OAuth ログインフローを開始する。 */
async function startOAuthLogin(provider: Provider): Promise<void> {
  const {
    settingOAuthStatus,
    settingOAuthUserCode,
    btnOAuthLogin,
    btnOAuthLogout,
    btnOAuthCancel,
  } = getElements();

  if (oauthAbortController) {
    oauthAbortController.abort();
  }
  oauthAbortController = new AbortController();

  // UI をポーリング状態に切り替え
  btnOAuthLogin.classList.add("hidden");
  btnOAuthLogout.classList.add("hidden");
  btnOAuthCancel.classList.remove("hidden");
  settingOAuthStatus.textContent = "認証中…";
  settingOAuthUserCode.classList.add("hidden");

  // ユーザーコード表示用コールバック
  const onUserCode = (code: string, verificationUri: string) => {
    settingOAuthUserCode.textContent = `コード: ${code} を ${verificationUri} で入力してください`;
    settingOAuthUserCode.classList.remove("hidden");
    settingOAuthStatus.textContent = "ブラウザでコードを入力して認証を完了してください…";
  };

  try {
    if (provider === "codex") {
      settingOAuthStatus.textContent = "ブラウザで認証を完了してください…";
      await codexBrowserLogin(oauthAbortController.signal);
    } else if (provider === "github-copilot") {
      settingOAuthStatus.textContent = "ブラウザで認証を完了してください…";
      await copilotLogin(oauthAbortController.signal, undefined, onUserCode);
    }

    // ログイン成功
    settingOAuthUserCode.classList.add("hidden");
    settingOAuthStatus.textContent = "ログイン済み";
    btnOAuthLogin.classList.add("hidden");
    btnOAuthLogout.classList.remove("hidden");
    btnOAuthCancel.classList.add("hidden");

    // ログイン後にモデルキャッシュが無効化されているため UI を再描画
    updateAdvancedVisibility(provider);
  } catch (err) {
    if (oauthAbortController?.signal.aborted) {
      settingOAuthStatus.textContent = "キャンセルされました";
    } else {
      const message = err instanceof Error ? err.message : String(err);
      settingOAuthStatus.textContent = `エラー: ${message}`;
    }
    settingOAuthUserCode.classList.add("hidden");
    btnOAuthLogin.classList.remove("hidden");
    btnOAuthLogout.classList.add("hidden");
    btnOAuthCancel.classList.add("hidden");
  } finally {
    oauthAbortController = null;
  }
}

/** OAuth ログアウト処理 */
async function logoutOAuth(provider: Provider): Promise<void> {
  const { settingOAuthStatus, btnOAuthLogin, btnOAuthLogout } = getElements();

  if (provider === "codex") {
    await deleteCodexCredential();
  } else if (provider === "github-copilot") {
    await deleteCopilotCredential();
  }

  settingOAuthStatus.textContent = "未ログイン";
  btnOAuthLogin.classList.remove("hidden");
  btnOAuthLogout.classList.add("hidden");

  // ログアウト後にモデルキャッシュが無効化されているため UI を再描画
  updateAdvancedVisibility(provider);
}

function populateFixedModelSelect(provider: Provider, currentModel: string): void {
  const { settingModelSelect } = getElements();
  const fixedModels = getFixedModelOptions(provider);
  settingModelSelect.innerHTML = "";
  if (!fixedModels) return;

  for (const { id, label } of fixedModels) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = label;
    settingModelSelect.appendChild(option);
  }
  settingModelSelect.value = fixedModels.some((m) => m.id === currentModel)
    ? currentModel
    : fixedModels[0]?.id ?? "";
}

function updateModelInputMode(provider: Provider): void {
  const { settingModel, settingModelSelect } = getElements();
  const isFixed = isFixedModelProvider(provider);

  settingModel.classList.toggle("hidden", isFixed);
  settingModelSelect.classList.toggle("hidden", !isFixed);
}

function updateModelFetchState(provider: Provider): void {
  const { btnFetchModels } = getElements();
  const isFixed = isFixedModelProvider(provider);

  btnFetchModels.disabled = isFixed;
  btnFetchModels.textContent = isFixed ? "モデルは固定" : "取得";
}

// sampling 系（temperature / topP / topK）の disabled と hidden を制御する。
// hide=true のときは disabled + hidden、hide=false のときは disabled のみ（値は見える）。
function setSamplingParamsEnabled(enabled: boolean, hide: boolean): void {
  const { settingTemperature, settingTopP, settingTopK } = getElements();
  const inputs = [settingTemperature, settingTopP, settingTopK];
  for (const input of inputs) {
    input.disabled = !enabled;
    input.parentElement?.classList.toggle("hidden", !enabled && hide);
  }
}

// penalty 系（frequencyPenalty / presencePenalty）の disabled と hidden を制御する。
// hide=true のときは disabled + hidden、hide=false のときは disabled のみ（値は見える）。
function setPenaltyParamsEnabled(enabled: boolean, hide: boolean): void {
  const { settingFrequencyPenalty, settingPresencePenalty } = getElements();
  const inputs = [settingFrequencyPenalty, settingPresencePenalty];
  for (const input of inputs) {
    input.disabled = !enabled;
    input.parentElement?.classList.toggle("hidden", !enabled && hide);
  }
}

// maxTokens / maxContextTokens の disabled を制御する。
// 値は見えるまま（hidden にはしない）。
function setCapacityControlsEnabled(enabled: boolean): void {
  const { settingMaxTokens, settingMaxContextTokens } = getElements();
  settingMaxTokens.disabled = !enabled;
  settingMaxContextTokens.disabled = !enabled;
}

function updateSamplingControlsVisibility(provider: Provider): void {
  // service.ts の buildTemperatureOption / buildAdvancedOptions に対応させる。
  // - deepseek: thinking 有効時は sampling / penalty とも disabled + hidden
  //   （thinking モードでは API に送られない）。thinking 無効時（チェックボックス OFF）は
  //   temperature/topP/topK/penalty を受け付けるため、すべて enabled にする。
  // - opencode: sampling / penalty とも disabled のみ（API に送られない。値は見える）。
  // - sakura:   penalty のみ disabled（sampling は送られる。値は見える）。
  // - 上記以外: すべて enabled。
  if (provider === "deepseek") {
    if (getElements().settingDeepseekThinking.checked) {
      setSamplingParamsEnabled(false, true);
      setPenaltyParamsEnabled(false, true);
    } else {
      setSamplingParamsEnabled(true, false);
      setPenaltyParamsEnabled(true, false);
    }
  } else if (provider === "opencode") {
    setSamplingParamsEnabled(false, false);
    setPenaltyParamsEnabled(false, false);
  } else if (provider === "sakura") {
    setSamplingParamsEnabled(true, false);
    setPenaltyParamsEnabled(false, false);
  } else {
    setSamplingParamsEnabled(true, false);
    setPenaltyParamsEnabled(true, false);
  }
}

function updateCapacityControlsVisibility(provider: Provider): void {
  // OpenCode Go では maxTokens / maxContextTokens は settings.ts の applyProviderCapacityCap で
  // 保存時にクランプ / 上書きされるため UI でも disabled にする。
  // hidden にはしない（現在のクランプ結果の値は見える）。
  setCapacityControlsEnabled(provider !== "opencode");
}

// モデル定義に存在しない（undefined）パラメータを disabled にする。
// プロバイダ単位で既に disabled にしているフィールドは触らない（追加適用のみ）。
// disabled のみで hidden にはしない（入力値は見える）。
function applyModelBasedDisabling(provider: Provider, defaults: ProviderModelDefaults | undefined): void {
  if (!defaults) return;

  const {
    settingTemperature,
    settingTopP,
    settingTopK,
    settingFrequencyPenalty,
    settingPresencePenalty,
    settingMaxTokens,
    settingMaxContextTokens,
    settingGoogleThinkingLevel,
  } = getElements();

  // sampling 系: プロバイダ単位で enabled の場合のみモデル単位で判定する
  // - deepseek: プロバイダ単位で disabled+hidden → スキップ
  // - opencode: プロバイダ単位で disabled → スキップ
  // - その他: モデル defaults で undefined のフィールドを disabled にする
  if (provider !== "deepseek" && provider !== "opencode") {
    if (defaults.temperature === undefined) settingTemperature.disabled = true;
    if (defaults.topP === undefined) settingTopP.disabled = true;
    if (defaults.topK === undefined) settingTopK.disabled = true;
  }

  // penalty 系: プロバイダ単位で enabled の場合のみモデル単位で判定する
  // - deepseek: プロバイダ単位で disabled+hidden → スキップ
  // - opencode: プロバイダ単位で disabled → スキップ
  // - sakura:  プロバイダ単位で disabled → スキップ
  // - その他: モデル defaults で undefined のフィールドを disabled にする
  if (provider !== "deepseek" && provider !== "opencode" && provider !== "sakura") {
    if (defaults.frequencyPenalty === undefined) settingFrequencyPenalty.disabled = true;
    if (defaults.presencePenalty === undefined) settingPresencePenalty.disabled = true;
  }

  // capacity 系: プロバイダ単位で enabled の場合のみモデル単位で判定する
  // - opencode: プロバイダ単位で disabled → スキップ
  // - その他: モデル defaults で undefined のフィールドを disabled にする
  if (provider !== "opencode") {
    if (defaults.maxTokens === undefined) settingMaxTokens.disabled = true;
    if (defaults.maxContextTokens === undefined) settingMaxContextTokens.disabled = true;
  }

  // Google thinking level: Gemini 3 系のモデルにのみ存在する概念。
  // Gemma 系（defaults に googleThinkingLevel が無い）では disabled にする。
  // provider 単位の baseline が無い項目のため、ここで enabled/disabled を都度確定する。
  if (provider === "google") {
    settingGoogleThinkingLevel.disabled = defaults.googleThinkingLevel === undefined;
  }
}

function populateConfiguredModelList(entry: ProviderEntry | undefined): void {
  populateModelList(getProviderModelIds(entry));
}

async function renderWebDavSettings(): Promise<void> {
  const {
    settingWebdavEnabled,
    settingWebdavUrl,
    settingWebdavUsername,
    settingWebdavPassword,
    settingWebdavFolder,
  } = getElements();
  const config = await loadWebDavSyncConfig();
  settingWebdavEnabled.checked = config.enabled;
  settingWebdavUrl.value = config.baseUrl;
  settingWebdavUsername.value = config.username ?? "";
  settingWebdavPassword.value = config.password ?? "";
  settingWebdavFolder.value = config.remoteFolder ?? "";
  updateWebDavControlsState();
}

async function renderExaSettings(): Promise<void> {
  const { settingExaApiKey } = getElements();
  settingExaApiKey.value = await loadExaApiKey();
}

function updateWebDavControlsState(): void {
  const {
    settingWebdavEnabled,
    settingWebdavUrl,
    settingWebdavUsername,
    settingWebdavPassword,
    settingWebdavFolder,
  } = getElements();
  const disabled = !settingWebdavEnabled.checked;
  for (const input of [
    settingWebdavUrl,
    settingWebdavUsername,
    settingWebdavPassword,
    settingWebdavFolder,
  ]) {
    input.disabled = disabled;
  }
}

function applyModelDefaults(entry: ProviderEntry | undefined, modelId: string, provider: Provider): void {
  const defaults = getProviderModelDefaults(entry, modelId);
  if (!defaults) return;

  const {
    settingTemperature,
    settingMaxTokens,
    settingMaxContextTokens,
    settingTopP,
    settingTopK,
    settingFrequencyPenalty,
    settingPresencePenalty,
    settingOpenaiReasoningEffort,
    settingDeepseekReasoningEffort,
    settingAnthropicThinkingEnabled,
    settingAnthropicThinkingBudget,
    settingAnthropicThinkingEffort,
    settingGoogleThinkingLevel,
  } = getElements();

  if (defaults.temperature !== undefined) settingTemperature.value = String(defaults.temperature);
  if (defaults.maxTokens !== undefined) settingMaxTokens.value = String(defaults.maxTokens);
  if (defaults.maxContextTokens !== undefined) settingMaxContextTokens.value = String(defaults.maxContextTokens);
  settingTopP.value = optionalNumberInput(defaults.topP);
  settingTopK.value = optionalNumberInput(defaults.topK);
  settingFrequencyPenalty.value = optionalNumberInput(defaults.frequencyPenalty);
  settingPresencePenalty.value = optionalNumberInput(defaults.presencePenalty);
  settingOpenaiReasoningEffort.value = defaults.openaiReasoningEffort ?? "";
  settingDeepseekReasoningEffort.value = defaults.deepseekReasoningEffort ?? "";
  settingAnthropicThinkingEnabled.checked = defaults.anthropicThinkingEnabled ?? false;
  settingAnthropicThinkingBudget.value = optionalNumberInput(defaults.anthropicThinkingBudget);
  settingAnthropicThinkingEffort.value = defaults.reasoningCapability?.defaultEffort ?? "";
  settingGoogleThinkingLevel.value = defaults.googleThinkingLevel ?? "";

  // モデル定義に存在しないパラメータを disabled にする（プロバイダ単位で enabled のもののみ）。
  applyModelBasedDisabling(provider, defaults);
}

export function renderSettings(settings: AiSettings, config: ProviderConfig): void {
  modalProviderConfig = config;
  modalProviderConfigs = { ...settings.providerConfigs } as Record<Provider, ProviderSpecificSettings>;
  for (const p of ALL_PROVIDERS) {
    if (!modalProviderConfigs[p]) {
      const entry = getProviderEntry(config, p);
      modalProviderConfigs[p] = {
        apiKey: "",
        baseUrl: entry?.defaultBaseUrl ?? "",
        model: entry?.defaultModel ?? "",
      };
    }
  }

  const {
    settingProvider,
    settingTemperature,
    settingMaxTokens,
    settingMaxContextTokens,
    settingChatSubmitShortcut,
    settingTopP,
    settingTopK,
    settingFrequencyPenalty,
    settingPresencePenalty,
    settingOpenaiReasoningEffort,
    settingDeepseekReasoningEffort,
    settingDeepseekThinking,
    settingAnthropicThinkingEnabled,
    settingAnthropicThinkingBudget,
    settingAnthropicThinkingEffort,
    settingGoogleThinkingLevel,
    settingTwoStageContinuation,
    settingContinuationReview,
    settingWritingSource,
    settingJudgmentSource,
    settingWritingTemperature,
    settingWritingTopP,
    settingWritingScaffold,
    settingWritingDeepseekThinking,
    settingJudgmentTemperature,
    settingJudgmentTopP,
    settingJudgmentScaffold,
    settingJudgmentDeepseekThinking,
    settingContinuationSceneState,
    settingContinuationCharacterVoice,
    settingContinuationBestOfTwo,
    settingContinuationTargetedRevision,
    settingContinuationBeatSplit,
  } = getElements();

  settingProvider.value = settings.provider;
  modalCurrentProvider = settings.provider;
  settingTemperature.value = String(settings.temperature);
  settingMaxTokens.value = String(settings.maxTokens);
  settingMaxContextTokens.value = String(settings.maxContextTokens);
  settingChatSubmitShortcut.value = settings.chatSubmitShortcut;
  settingTopP.value = optionalNumberInput(settings.topP);
  settingTopK.value = optionalNumberInput(settings.topK);
  settingFrequencyPenalty.value = optionalNumberInput(settings.frequencyPenalty);
  settingPresencePenalty.value = optionalNumberInput(settings.presencePenalty);
  settingOpenaiReasoningEffort.value = settings.openaiReasoningEffort ?? "";
  settingDeepseekReasoningEffort.value = settings.deepseekReasoningEffort ?? "";
  // undefined は「既定=有効」を意味する(settings.ts の deepseekThinkingEnabled 参照)
  settingDeepseekThinking.checked = settings.deepseekThinkingEnabled !== false;
  settingAnthropicThinkingEnabled.checked = settings.anthropicThinkingEnabled ?? false;
  settingAnthropicThinkingBudget.value = optionalNumberInput(settings.anthropicThinkingBudget);
  settingAnthropicThinkingEffort.value = settings.anthropicThinkingEffort ?? "";
  settingGoogleThinkingLevel.value = settings.googleThinkingLevel ?? "";
  settingTwoStageContinuation.checked = settings.twoStageContinuation ?? false;
  settingContinuationReview.checked = settings.continuationReviewEnabled ?? false;

  const writingSource: WritingModelSource = settings.writingModelSource ?? "main";
  settingWritingSource.value = writingSource;
  updateWritingCustomRowVisibility(writingSource);

  // 判断系モデルの選択元。source 未保存の旧設定は continuationUseBackgroundModel から
  // 後方互換で初期表示を導出する(resolveJudgmentSettings と同じ規則)。
  const judgmentSource: JudgmentModelSource =
    settings.judgmentModelSource ?? (settings.continuationUseBackgroundModel ? "background" : "main");
  settingJudgmentSource.value = judgmentSource;
  updateJudgmentCustomRowVisibility(judgmentSource);

  // 役割別パラメータ(執筆系/判断系)。undefined は空欄・""(自動)として表示する。
  settingWritingTemperature.value = optionalNumberInput(settings.writingOverrides?.temperature);
  settingWritingTopP.value = optionalNumberInput(settings.writingOverrides?.topP);
  settingWritingScaffold.value = settings.writingOverrides?.promptScaffold ?? "";
  settingWritingDeepseekThinking.value = deepseekThinkingToSelectValue(settings.writingOverrides?.deepseekThinkingEnabled);
  settingJudgmentTemperature.value = optionalNumberInput(settings.judgmentOverrides?.temperature);
  settingJudgmentTopP.value = optionalNumberInput(settings.judgmentOverrides?.topP);
  settingJudgmentScaffold.value = settings.judgmentOverrides?.promptScaffold ?? "";
  settingJudgmentDeepseekThinking.value = deepseekThinkingToSelectValue(settings.judgmentOverrides?.deepseekThinkingEnabled);

  settingContinuationSceneState.checked = settings.continuationSceneStateEnabled ?? false;
  settingContinuationCharacterVoice.checked = settings.continuationCharacterVoiceEnabled ?? false;
  settingContinuationBestOfTwo.checked = settings.continuationBestOfTwo ?? false;
  settingContinuationTargetedRevision.checked = settings.continuationTargetedRevision ?? false;
  settingContinuationBeatSplit.checked = settings.continuationBeatSplitEnabled ?? false;

  applyProviderConfig(settings.provider);
  // model-aware: pass the current model ID for capability-based control visibility
  updateAdvancedVisibility(settings.provider, modalProviderConfigs[settings.provider].model);
  updateOAuthControls(settings.provider);
  updateModelFetchState(settings.provider);
  updateModelInputMode(settings.provider);
  updateSamplingControlsVisibility(settings.provider);
  updateCapacityControlsVisibility(settings.provider);
  // 初期描画時にも、保存されたモデルに対応する defaults でモデル単位の disabled を適用する。
  // 値は settings から既に流し込み済み（上書きしない）なので、disabled のみ反映する。
  {
    const initialEntry = getProviderEntry(config, settings.provider);
    const initialModelId = modalProviderConfigs[settings.provider].model;
    applyModelBasedDisabling(settings.provider, getProviderModelDefaults(initialEntry, initialModelId));
  }
  populateFixedModelSelect(settings.provider, modalProviderConfigs[settings.provider].model);
  populateConfiguredModelList(getProviderEntry(config, settings.provider));

  renderBackgroundProviderOptions(config);
  renderBackgroundModelOptions(config, settings.backgroundProvider ?? "", settings.backgroundModel);

  renderWritingProviderOptions(config);
  getElements().settingWritingProvider.value = settings.writingProvider ?? settings.provider;
  renderWritingModelOptions(config, settings.writingProvider ?? settings.provider, settings.writingModel);

  renderJudgmentProviderOptions(config);
  getElements().settingJudgmentProvider.value = settings.judgmentProvider ?? "";
  renderJudgmentModelOptions(config, settings.judgmentProvider ?? "", settings.judgmentModel);

  // 初回描画。以後はフォームの change/input 委譲リスナー(bindSettingsActions)が更新する
  renderModelResolutionPreview();

  void renderWebDavSettings();
  void renderExaSettings();
}

export function readWebDavSyncConfigFromModal(): WebDavSyncConfig {
  const {
    settingWebdavEnabled,
    settingWebdavUrl,
    settingWebdavUsername,
    settingWebdavPassword,
    settingWebdavFolder,
  } = getElements();
  return {
    enabled: settingWebdavEnabled.checked,
    baseUrl: settingWebdavUrl.value.trim(),
    username: settingWebdavUsername.value.trim(),
    password: settingWebdavPassword.value,
    remoteFolder: settingWebdavFolder.value.trim(),
  };
}

export function readExaApiKeyFromModal(): string {
  return getElements().settingExaApiKey.value.trim();
}

export function readSettingsFromModal(): AiSettings {
  const {
    settingProvider,
    settingBackgroundProvider,
    settingBackgroundModel,
    settingTemperature,
    settingMaxTokens,
    settingMaxContextTokens,
    settingChatSubmitShortcut,
    settingTopP,
    settingTopK,
    settingFrequencyPenalty,
    settingPresencePenalty,
    settingOpenaiReasoningEffort,
    settingDeepseekReasoningEffort,
    settingDeepseekThinking,
    settingAnthropicThinkingEnabled,
    settingAnthropicThinkingBudget,
    settingAnthropicThinkingEffort,
    settingGoogleThinkingLevel,
    settingTwoStageContinuation,
    settingContinuationReview,
    settingWritingSource,
    settingWritingProvider,
    settingWritingModel,
    settingJudgmentSource,
    settingJudgmentProvider,
    settingJudgmentModel,
    settingWritingTemperature,
    settingWritingTopP,
    settingWritingScaffold,
    settingWritingDeepseekThinking,
    settingJudgmentTemperature,
    settingJudgmentTopP,
    settingJudgmentScaffold,
    settingJudgmentDeepseekThinking,
    settingContinuationSceneState,
    settingContinuationCharacterVoice,
    settingContinuationBestOfTwo,
    settingContinuationTargetedRevision,
    settingContinuationBeatSplit,
  } = getElements();

  const provider = settingProvider.value as Provider;
  captureProviderConfig(provider);

  if (!modalProviderConfigs) {
    throw new Error("settings modal has not been rendered");
  }

  const activeConfig = modalProviderConfigs[provider];

  const backgroundProviderValue = settingBackgroundProvider.value;
  const backgroundModelValue = settingBackgroundModel.value.trim();

  const writingSource = parseWritingModelSource(settingWritingSource.value);
  const writingProviderValue = settingWritingProvider.value;
  const writingModelValue = settingWritingModel.value.trim();

  // 判断系モデル。provider/model は「個別指定」のときだけ保存する。
  const judgmentSource = parseJudgmentModelSource(settingJudgmentSource.value);
  const judgmentProviderValue = settingJudgmentProvider.value;
  const judgmentModelValue = settingJudgmentModel.value.trim();

  return {
    provider,
    apiKey: activeConfig.apiKey,
    baseUrl: activeConfig.baseUrl,
    model: activeConfig.model,
    providerConfigs: modalProviderConfigs,
    backgroundProvider: backgroundProviderValue === "" ? undefined : (backgroundProviderValue as Provider),
    backgroundModel: backgroundModelValue === "" ? undefined : backgroundModelValue,
    writingModelSource: writingSource,
    writingProvider:
      writingSource === "custom" && writingProviderValue !== "" ? (writingProviderValue as Provider) : undefined,
    writingModel: writingSource === "custom" && writingModelValue !== "" ? writingModelValue : undefined,
    judgmentModelSource: judgmentSource,
    judgmentProvider:
      judgmentSource === "custom" && judgmentProviderValue !== "" ? (judgmentProviderValue as Provider) : undefined,
    judgmentModel: judgmentSource === "custom" && judgmentModelValue !== "" ? judgmentModelValue : undefined,
    writingOverrides: readRoleOverrides(
      settingWritingTemperature,
      settingWritingTopP,
      settingWritingScaffold,
      settingWritingDeepseekThinking,
    ),
    judgmentOverrides: readRoleOverrides(
      settingJudgmentTemperature,
      settingJudgmentTopP,
      settingJudgmentScaffold,
      settingJudgmentDeepseekThinking,
    ),
    temperature: Number(settingTemperature.value),
    maxTokens: Number(settingMaxTokens.value),
    maxContextTokens: Number(settingMaxContextTokens.value),
    chatSubmitShortcut: settingChatSubmitShortcut.value === "enter" ? "enter" : "ctrlEnter",
    topP: parseOptionalNumber(settingTopP.value),
    topK: parseOptionalNumber(settingTopK.value),
    frequencyPenalty: parseOptionalNumber(settingFrequencyPenalty.value),
    presencePenalty: parseOptionalNumber(settingPresencePenalty.value),
    openaiReasoningEffort: parseOpenAIReasoningEffort(settingOpenaiReasoningEffort.value),
    deepseekReasoningEffort: parseDeepSeekReasoningEffort(settingDeepseekReasoningEffort.value),
    // checked は既定(=有効)として undefined で保存し、明示的な OFF だけ false を残す
    deepseekThinkingEnabled: settingDeepseekThinking.checked ? undefined : false,
    anthropicThinkingEnabled: settingAnthropicThinkingEnabled.checked,
    anthropicThinkingBudget: parseOptionalNumber(settingAnthropicThinkingBudget.value),
    anthropicThinkingEffort: parseAnthropicThinkingEffort(settingAnthropicThinkingEffort.value),
    googleThinkingLevel: parseGoogleThinkingLevel(settingGoogleThinkingLevel.value),
    twoStageContinuation: settingTwoStageContinuation.checked,
    continuationReviewEnabled: settingContinuationReview.checked,
    // 旧バージョンでこの設定を開いた場合の後方互換用に、source から旧フラグも導出して保存する
    continuationUseBackgroundModel: judgmentSource === "background",
    continuationSceneStateEnabled: settingContinuationSceneState.checked,
    continuationCharacterVoiceEnabled: settingContinuationCharacterVoice.checked,
    continuationBestOfTwo: settingContinuationBestOfTwo.checked,
    continuationTargetedRevision: settingContinuationTargetedRevision.checked,
    continuationBeatSplitEnabled: settingContinuationBeatSplit.checked,
  };
}

/* ============================================================
 * モデル解決プレビュー — 保存前のフォーム内容から、各工程で実際に
 * どのモデル・パラメータが使われるかをミニテーブルで表示する。
 * ============================================================ */

/// モデル列: プロバイダ表示名 + モデルラベル(providers.json に無いモデルは ID をそのまま)
export function describePreviewModel(config: ProviderConfig, resolved: AiSettings): string {
  const entry = getProviderEntry(config, resolved.provider);
  const modelLabel = getProviderModelDefaults(entry, resolved.model)?.label ?? resolved.model;
  return `${entry?.name ?? resolved.provider} / ${modelLabel}`;
}

export function describePreviewEndpoint(config: ProviderConfig, resolved: AiSettings): string {
  const entry = getProviderEntry(config, resolved.provider);
  return resolved.baseUrl?.trim() || entry?.defaultBaseUrl || "SDK既定";
}

/// 温度列: 実際に API へ送られない構成では理由付きの「—」を出す
/// (service.ts の buildTemperatureOption と対応)
export function describePreviewTemperature(resolved: AiSettings): string {
  if (resolved.provider === "deepseek" && resolved.deepseekThinkingEnabled !== false) {
    return "—（thinkingでは無視）";
  }
  if (resolved.provider === "opencode") {
    return "—（送信されない）";
  }
  if (resolved.provider === "google" && isGemini3Model(resolved.model)) {
    return "—（既定1.0固定）";
  }
  return String(resolved.temperature);
}

/// 思考列: プロバイダ/capability 別に thinking・reasoning の要約を出す
export function describePreviewThinking(resolved: AiSettings): string {
  const kind = resolved.reasoningCapability?.kind;
  if (kind === "deepseek" || (kind === undefined && resolved.provider === "deepseek")) {
    if (resolved.deepseekThinkingEnabled === false) return "thinking OFF";
    return resolved.deepseekReasoningEffort
      ? `thinking ON（${resolved.deepseekReasoningEffort}）`
      : "thinking ON";
  }
  if (kind === "anthropic-adaptive") {
    // 2-7: Opus 4.8 のように canDisable な adaptive モデルは OFF 表示もあり得る
    // (Fable 5 は canDisable でないため常に ON 表示のまま)。
    if (resolved.reasoningCapability?.canDisable === true && !resolved.anthropicThinkingEnabled) {
      return "thinking OFF";
    }
    return resolved.anthropicThinkingEffort
      ? `thinking ON（${resolved.anthropicThinkingEffort}）`
      : "thinking ON";
  }
  if (kind === "anthropic-budget" || (kind === undefined && resolved.provider === "anthropic")) {
    if (!resolved.anthropicThinkingEnabled) return "thinking OFF";
    return resolved.anthropicThinkingBudget !== undefined
      ? `thinking ON（予算 ${resolved.anthropicThinkingBudget}）`
      : "thinking ON";
  }
  if (kind === "openai" || (kind === undefined && resolved.provider === "openai")) {
    return resolved.openaiReasoningEffort ?? "—";
  }
  if (kind === "google" || (kind === undefined && resolved.provider === "google" && isGemini3Model(resolved.model))) {
    return resolved.googleThinkingLevel ?? "既定";
  }
  return "—";
}

export interface ModelResolutionPreviewRow {
  role: string;
  resolved: AiSettings;
  /// 足場列を表示する行(執筆系・判断系のみ)
  showScaffold: boolean;
}

/**
 * フォームの現在値から各工程の解決結果を計算する純関数(テスト可能)。
 * @returns 各行のデータ。config が未ロードの場合は undefined。
 */
export function computeModelResolutionPreviewRows(
  config: ProviderConfig | undefined | null,
  settings: AiSettings,
): ModelResolutionPreviewRow[] | undefined {
  if (!config) return undefined;
  return [
    { role: "チャット", resolved: resolveChatRunSettings(config, settings), showScaffold: false },
    { role: "執筆系（continuePassage・ドラフト・修正・リライト）", resolved: resolveWritingRunSettings(config, settings), showScaffold: true },
    { role: "判断系（構想・査読・選定・カード・講評）", resolved: resolveJudgmentRunSettings(config, settings), showScaffold: true },
    { role: "バックグラウンド（要約・整合性チェック）", resolved: resolveBackgroundRunSettings(config, settings), showScaffold: false },
  ];
}

export function shouldRenderModelResolutionPreviewOnInput(
  target: EventTarget | null,
  providerSelect: EventTarget,
): boolean {
  return target !== providerSelect;
}

/**
 * フォームの現在値から各工程の解決結果を計算してミニテーブルを描画する。
 * readSettingsFromModal は現在の接続欄をモーダル内キャッシュへ同期するため、
 * プロバイダー選択時は接続欄の切替が完了した change 後に呼ぶ。
 * モーダル未描画などで計算できない場合はその旨を表示する。
 */
export function renderModelResolutionPreview(): void {
  const body = document.querySelector<HTMLElement>("#model-resolution-preview-body");
  if (!body) return;

  const config = modalProviderConfig;
  let rows: ModelResolutionPreviewRow[] | undefined;
  try {
    const settings = readSettingsFromModal();
    rows = computeModelResolutionPreviewRows(config, settings);
  } catch (error) {
    console.warn("[litra] model resolution preview failed:", error);
    body.textContent = "計算できません";
    return;
  }

  if (!rows) {
    body.textContent = "計算できません";
    return;
  }

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const heading of ["工程", "モデル", "接続先", "出力上限", "温度", "思考", "足場"]) {
    const th = document.createElement("th");
    th.textContent = heading;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    const cells = [
      row.role,
      describePreviewModel(config!, row.resolved),
      describePreviewEndpoint(config!, row.resolved),
      `${row.resolved.maxTokens} tokens`,
      describePreviewTemperature(row.resolved),
      describePreviewThinking(row.resolved),
      row.showScaffold ? row.resolved.promptScaffold ?? "full" : "—",
    ];
    for (const text of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  body.replaceChildren(table);
}

export function populateModelList(modelIds: string[]): void {
  const datalist = document.querySelector<HTMLDataListElement>("#setting-model-list");
  if (!datalist) return;

  datalist.innerHTML = "";
  for (const id of modelIds) {
    const option = document.createElement("option");
    option.value = id;
    datalist.appendChild(option);
  }
}

export function showSettingsModal(): void {
  getElements().settingsModal.classList.remove("hidden");
}

export function hideSettingsModal(): void {
  getElements().settingsModal.classList.add("hidden");
}

function createLicenseSummary(payload: ThirdPartyLicensePayload): HTMLElement {
  const summary = document.createElement("p");
  summary.className = "license-summary";
  summary.textContent = `${payload.appName} ${payload.appVersion} / ${payload.entries.length} 件`;
  return summary;
}

function createLicenseList(entries: ThirdPartyLicenseEntry[]): HTMLElement {
  const list = document.createElement("div");
  list.className = "license-list";

  for (const entry of entries) {
    const item = document.createElement("article");
    item.className = "license-item";

    const title = document.createElement("h3");
    title.textContent = `${entry.name} ${entry.version}`;

    const meta = document.createElement("p");
    meta.textContent = `${entry.ecosystem} / ${entry.license}`;

    item.append(title, meta);
    if (entry.source || entry.homepage) {
      const link = document.createElement("a");
      link.href = entry.source ?? entry.homepage ?? "#";
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "source";
      item.appendChild(link);
    }
    list.appendChild(item);
  }

  return list;
}

async function showLicenseModal(): Promise<void> {
  const { licenseModal, licenseContent } = getElements();
  licenseModal.classList.remove("hidden");
  licenseContent.textContent = "ライセンス情報を読み込んでいます...";

  try {
    const response = await fetch("/third-party-licenses.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = (await response.json()) as ThirdPartyLicensePayload;
    licenseContent.replaceChildren(createLicenseSummary(payload), createLicenseList(payload.entries));
  } catch (error) {
    console.error("[litra] failed to load third-party licenses:", error);
    licenseContent.textContent = "ライセンス情報を読み込めませんでした。";
  }
}

function hideLicenseModal(): void {
  getElements().licenseModal.classList.add("hidden");
}

export interface SettingsActions {
  onSave: (settings: AiSettings) => void;
  onCancel: () => void;
  onInitialize: () => void;
}

export interface ModelFetchActions {
  onFetch: (settings: AiSettings) => void;
}

export interface ProviderChangeActions {
  onChange: (providerId: string) => ProviderEntry | undefined;
}

export function bindProviderChangeAction(actions: ProviderChangeActions): void {
  const { settingProvider, settingModel, settingModelSelect } = getElements();

  settingProvider.addEventListener("change", () => {
    const previousProvider = modalCurrentProvider;
    const provider = settingProvider.value as Provider;

    captureProviderConfig(previousProvider);
    modalCurrentProvider = provider;
    applyProviderConfig(provider);

    const entry = actions.onChange(provider);

    updateAdvancedVisibility(provider, modalProviderConfigs?.[provider]?.model);
    updateOAuthControls(provider);
    updateModelFetchState(provider);
    updateModelInputMode(provider);
    updateSamplingControlsVisibility(provider);
    updateCapacityControlsVisibility(provider);
    populateFixedModelSelect(provider, modalProviderConfigs?.[provider].model ?? entry?.defaultModel ?? "");
    populateConfiguredModelList(entry);
    applyModelDefaults(entry, modalProviderConfigs?.[provider].model ?? entry?.defaultModel ?? "", provider);
  });

  settingModel.addEventListener("change", () => {
    if (!modalProviderConfig) return;
    const provider = modalCurrentProvider;
    captureProviderConfig(provider);
    // モデル切替時は、まずプロバイダ単位の enabled/disabled 状態に戻してから
    // モデル単位の disabled を適用する。そうしないと、前のモデルで disabled に
    // されたパラメータ（例: topK 未対応モデル→対応モデル）が re-enable されない。
    updateAdvancedVisibility(provider, modalProviderConfigs?.[provider]?.model);
    updateSamplingControlsVisibility(provider);
    updateCapacityControlsVisibility(provider);
    applyModelDefaults(getProviderEntry(modalProviderConfig, provider), modalProviderConfigs?.[provider].model ?? "", provider);
  });

  settingModelSelect.addEventListener("change", () => {
    if (!modalProviderConfig) return;
    const provider = modalCurrentProvider;
    captureProviderConfig(provider);
    updateAdvancedVisibility(provider, modalProviderConfigs?.[provider]?.model);
    updateSamplingControlsVisibility(provider);
    updateCapacityControlsVisibility(provider);
    applyModelDefaults(getProviderEntry(modalProviderConfig, provider), modalProviderConfigs?.[provider].model ?? "", provider);
  });
}

export function bindSettingsActions(actions: SettingsActions): void {
  const {
    settingsForm,
    btnCancelSettings,
    btnInitializeSettings,
    btnShowLicenses,
    licenseModal,
    btnCloseLicenses,
    settingWebdavEnabled,
    settingDeepseekThinking,
    settingProvider,
    btnOAuthLogin,
    btnOAuthLogout,
    btnOAuthCancel,
  } = getElements();

  settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    actions.onSave(readSettingsFromModal());
  });

  settingWebdavEnabled.addEventListener("change", updateWebDavControlsState);
  // DeepSeek thinking の ON/OFF で temperature/topP/penalty 欄の有効状態が変わる
  settingDeepseekThinking.addEventListener("change", () => {
    updateSamplingControlsVisibility(modalCurrentProvider);
  });
  // どの入力が変わってもモデル解決プレビューを更新する(委譲リスナー。描画は軽量なので都度実行)
  settingsForm.addEventListener("change", () => renderModelResolutionPreview());
  settingsForm.addEventListener("input", (event) => {
    // select は input → change の順に発火する。プロバイダーの input 時点では
    // 接続欄が旧プロバイダーのままなので、readSettingsFromModal を呼ぶと旧値を
    // 新プロバイダーへ保存してしまう。change 側の切替完了後に描画する。
    if (shouldRenderModelResolutionPreviewOnInput(event.target, settingProvider)) {
      renderModelResolutionPreview();
    }
  });
  btnShowLicenses.addEventListener("click", () => void showLicenseModal());
  btnCloseLicenses.addEventListener("click", hideLicenseModal);
  licenseModal.querySelector(".modal-backdrop")?.addEventListener("click", hideLicenseModal);
  btnCancelSettings.addEventListener("click", actions.onCancel);
  btnInitializeSettings.addEventListener("click", () => actions.onInitialize());

  // OAuth ボタン
  btnOAuthLogin.addEventListener("click", () => {
    void startOAuthLogin(modalCurrentProvider);
  });
  btnOAuthLogout.addEventListener("click", () => {
    void logoutOAuth(modalCurrentProvider);
  });
  btnOAuthCancel.addEventListener("click", () => {
    if (oauthAbortController) {
      oauthAbortController.abort();
      oauthAbortController = null;
    }
  });
}

export function bindModelFetchAction(actions: ModelFetchActions): void {
  const { btnFetchModels } = getElements();

  btnFetchModels.addEventListener("click", () => {
    actions.onFetch(readSettingsFromModal());
  });
}

export function bindAdvancedSettingsToggle(): void {
  const { advancedSettingsToggle, advancedSettings } = getElements();

  advancedSettingsToggle.addEventListener("click", () => {
    const isHidden = advancedSettings.classList.toggle("hidden");
    advancedSettingsToggle.textContent = isHidden
      ? "生成・執筆支援の詳細を表示（continuePassage のモデル設定）"
      : "生成・執筆支援の詳細を隠す（continuePassage のモデル設定）";
    advancedSettingsToggle.setAttribute("aria-expanded", String(!isHidden));
  });
}

export function bindBackgroundProviderChangeAction(): void {
  const { settingBackgroundProvider, settingBackgroundModel } = getElements();

  settingBackgroundProvider.addEventListener("change", () => {
    const value = settingBackgroundProvider.value;
    if (value === "") {
      settingBackgroundModel.innerHTML = "";
      const emptyOption = document.createElement("option");
      emptyOption.value = "";
      emptyOption.textContent = "チャット欄に同期";
      settingBackgroundModel.appendChild(emptyOption);
      settingBackgroundModel.value = "";
      return;
    }
    renderBackgroundModelOptions(modalProviderConfig, value as Provider);
  });
}

export function bindJudgmentModelControls(): void {
  const {
    settingWritingSource,
    settingWritingProvider,
    settingJudgmentSource,
    settingJudgmentProvider,
  } = getElements();

  settingWritingSource.addEventListener("change", () => {
    updateWritingCustomRowVisibility(settingWritingSource.value);
  });

  settingWritingProvider.addEventListener("change", () => {
    const value = settingWritingProvider.value;
    renderWritingModelOptions(modalProviderConfig, value === "" ? "" : (value as Provider));
  });

  // 「個別指定」を選んだときだけプロバイダ・モデル行を表示する
  settingJudgmentSource.addEventListener("change", () => {
    updateJudgmentCustomRowVisibility(settingJudgmentSource.value);
  });

  // プロバイダ切替でモデル一覧を再描画する(バックグラウンドモデルの change と同じパターン)
  settingJudgmentProvider.addEventListener("change", () => {
    const value = settingJudgmentProvider.value;
    renderJudgmentModelOptions(modalProviderConfig, value === "" ? "" : (value as Provider));
  });
}
