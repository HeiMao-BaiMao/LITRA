import { getElements } from "./layout.ts";
import type {
  AiSettings,
  DeepSeekReasoningEffort,
  GoogleThinkingLevel,
  OpenAIReasoningEffort,
  Provider,
  ProviderSpecificSettings,
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
import { type FixedModel } from "../ai/model-list.ts";
import {
  loadWebDavSyncConfig,
  type WebDavSyncConfig,
} from "../sync/webdav.ts";

let modalProviderConfigs: Record<Provider, ProviderSpecificSettings> | null = null;
let modalProviderConfig: ProviderConfig | null = null;
let modalCurrentProvider: Provider = "openai";

const ALL_PROVIDERS: Provider[] = ["openai", "anthropic", "deepseek", "google", "llamacpp", "sakura", "plamo", "opencode"];

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

function parseGoogleThinkingLevel(value: string): GoogleThinkingLevel | undefined {
  if (value === "minimal" || value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return undefined;
}

function updateAdvancedVisibility(provider: Provider): void {
  const { advancedSettings } = getElements();
  const openaiGroup = advancedSettings.querySelector<HTMLElement>(".provider-field-openai");
  const deepseekGroup = advancedSettings.querySelector<HTMLElement>(".provider-field-deepseek");
  const anthropicGroup = advancedSettings.querySelector<HTMLElement>(".provider-field-anthropic");
  const googleGroup = advancedSettings.querySelector<HTMLElement>(".provider-field-google");

  if (openaiGroup) {
    openaiGroup.classList.toggle("hidden", provider !== "openai");
  }
  if (deepseekGroup) {
    deepseekGroup.classList.toggle("hidden", provider !== "deepseek");
  }
  if (anthropicGroup) {
    anthropicGroup.classList.toggle("hidden", provider !== "anthropic");
  }
  if (googleGroup) {
    googleGroup.classList.toggle("hidden", provider !== "google");
  }
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
  // - deepseek: sampling / penalty とも disabled + hidden（thinking モードでは API に送られないため現状維持）。
  // - opencode: sampling / penalty とも disabled のみ（API に送られない。値は見える）。
  // - sakura:   penalty のみ disabled（sampling は送られる。値は見える）。
  // - 上記以外: すべて enabled。
  if (provider === "deepseek") {
    setSamplingParamsEnabled(false, true);
    setPenaltyParamsEnabled(false, true);
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
    settingTopP,
    settingTopK,
    settingFrequencyPenalty,
    settingPresencePenalty,
    settingOpenaiReasoningEffort,
    settingDeepseekReasoningEffort,
    settingAnthropicThinkingEnabled,
    settingAnthropicThinkingBudget,
    settingGoogleThinkingLevel,
    settingTwoStageContinuation,
  } = getElements();

  settingProvider.value = settings.provider;
  modalCurrentProvider = settings.provider;
  settingTemperature.value = String(settings.temperature);
  settingMaxTokens.value = String(settings.maxTokens);
  settingMaxContextTokens.value = String(settings.maxContextTokens);
  settingTopP.value = optionalNumberInput(settings.topP);
  settingTopK.value = optionalNumberInput(settings.topK);
  settingFrequencyPenalty.value = optionalNumberInput(settings.frequencyPenalty);
  settingPresencePenalty.value = optionalNumberInput(settings.presencePenalty);
  settingOpenaiReasoningEffort.value = settings.openaiReasoningEffort ?? "";
  settingDeepseekReasoningEffort.value = settings.deepseekReasoningEffort ?? "";
  settingAnthropicThinkingEnabled.checked = settings.anthropicThinkingEnabled ?? false;
  settingAnthropicThinkingBudget.value = optionalNumberInput(settings.anthropicThinkingBudget);
  settingGoogleThinkingLevel.value = settings.googleThinkingLevel ?? "";
  settingTwoStageContinuation.checked = settings.twoStageContinuation ?? false;

  applyProviderConfig(settings.provider);
  updateAdvancedVisibility(settings.provider);
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

  void renderWebDavSettings();
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

export function readSettingsFromModal(): AiSettings {
  const {
    settingProvider,
    settingBackgroundProvider,
    settingBackgroundModel,
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
    settingGoogleThinkingLevel,
    settingTwoStageContinuation,
  } = getElements();

  const provider = settingProvider.value as Provider;
  captureProviderConfig(provider);

  if (!modalProviderConfigs) {
    throw new Error("settings modal has not been rendered");
  }

  const activeConfig = modalProviderConfigs[provider];

  const backgroundProviderValue = settingBackgroundProvider.value;
  const backgroundModelValue = settingBackgroundModel.value.trim();

  return {
    provider,
    apiKey: activeConfig.apiKey,
    baseUrl: activeConfig.baseUrl,
    model: activeConfig.model,
    providerConfigs: modalProviderConfigs,
    backgroundProvider: backgroundProviderValue === "" ? undefined : (backgroundProviderValue as Provider),
    backgroundModel: backgroundModelValue === "" ? undefined : backgroundModelValue,
    temperature: Number(settingTemperature.value),
    maxTokens: Number(settingMaxTokens.value),
    maxContextTokens: Number(settingMaxContextTokens.value),
    topP: parseOptionalNumber(settingTopP.value),
    topK: parseOptionalNumber(settingTopK.value),
    frequencyPenalty: parseOptionalNumber(settingFrequencyPenalty.value),
    presencePenalty: parseOptionalNumber(settingPresencePenalty.value),
    openaiReasoningEffort: parseOpenAIReasoningEffort(settingOpenaiReasoningEffort.value),
    deepseekReasoningEffort: parseDeepSeekReasoningEffort(settingDeepseekReasoningEffort.value),
    anthropicThinkingEnabled: settingAnthropicThinkingEnabled.checked,
    anthropicThinkingBudget: parseOptionalNumber(settingAnthropicThinkingBudget.value),
    googleThinkingLevel: parseGoogleThinkingLevel(settingGoogleThinkingLevel.value),
    twoStageContinuation: settingTwoStageContinuation.checked,
  };
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

    updateAdvancedVisibility(provider);
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
    updateSamplingControlsVisibility(provider);
    updateCapacityControlsVisibility(provider);
    applyModelDefaults(getProviderEntry(modalProviderConfig, provider), modalProviderConfigs?.[provider].model ?? "", provider);
  });

  settingModelSelect.addEventListener("change", () => {
    if (!modalProviderConfig) return;
    const provider = modalCurrentProvider;
    captureProviderConfig(provider);
    updateSamplingControlsVisibility(provider);
    updateCapacityControlsVisibility(provider);
    applyModelDefaults(getProviderEntry(modalProviderConfig, provider), modalProviderConfigs?.[provider].model ?? "", provider);
  });
}

export function bindSettingsActions(actions: SettingsActions): void {
  const { settingsForm, btnCancelSettings, btnInitializeSettings, settingWebdavEnabled } = getElements();

  settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    actions.onSave(readSettingsFromModal());
  });

  settingWebdavEnabled.addEventListener("change", updateWebDavControlsState);
  btnCancelSettings.addEventListener("click", actions.onCancel);
  btnInitializeSettings.addEventListener("click", () => actions.onInitialize());
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
    advancedSettingsToggle.textContent = isHidden ? "詳細設定を表示" : "詳細設定を隠す";
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
