import { getElements } from "./layout.ts";
import type {
  AiSettings,
  DeepSeekReasoningEffort,
  OpenAIReasoningEffort,
  Provider,
  ProviderSpecificSettings,
} from "../settings.ts";
import { getProviderEntry } from "../providers/config.ts";
import {
  getProviderModelDefaults,
  getProviderModelIds,
  type ProviderConfig,
  type ProviderEntry,
} from "../providers/config.ts";
import {
  DEEPSEEK_FIXED_MODELS,
  OPENCODE_GO_FIXED_MODELS,
  SAKURA_FIXED_MODELS,
  type FixedModel,
} from "../ai/model-list.ts";
import {
  loadWebDavSyncConfig,
  type WebDavSyncConfig,
} from "../sync/webdav.ts";

let modalProviderConfigs: Record<Provider, ProviderSpecificSettings> | null = null;
let modalProviderConfig: ProviderConfig | null = null;
let modalCurrentProvider: Provider = "openai";

const ALL_PROVIDERS: Provider[] = ["openai", "anthropic", "deepseek", "google", "llamacpp", "sakura", "plamo", "opencode"];

function getFixedModelOptions(provider: Provider): FixedModel[] | undefined {
  switch (provider) {
    case "deepseek":
      return DEEPSEEK_FIXED_MODELS;
    case "sakura":
      return SAKURA_FIXED_MODELS;
    case "opencode":
      return OPENCODE_GO_FIXED_MODELS;
    default:
      return undefined;
  }
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

function updateAdvancedVisibility(provider: Provider): void {
  const { advancedSettings } = getElements();
  const openaiGroup = advancedSettings.querySelector<HTMLElement>(".provider-field-openai");
  const deepseekGroup = advancedSettings.querySelector<HTMLElement>(".provider-field-deepseek");
  const anthropicGroup = advancedSettings.querySelector<HTMLElement>(".provider-field-anthropic");

  if (openaiGroup) {
    openaiGroup.classList.toggle("hidden", provider !== "openai");
  }
  if (deepseekGroup) {
    deepseekGroup.classList.toggle("hidden", provider !== "deepseek");
  }
  if (anthropicGroup) {
    anthropicGroup.classList.toggle("hidden", provider !== "anthropic");
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
}

function applyModelDefaults(entry: ProviderEntry | undefined, modelId: string): void {
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

  applyProviderConfig(settings.provider);
  updateAdvancedVisibility(settings.provider);
  updateModelFetchState(settings.provider);
  updateModelInputMode(settings.provider);
  updateSamplingControlsVisibility(settings.provider);
  updateCapacityControlsVisibility(settings.provider);
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
    applyModelDefaults(entry, modalProviderConfigs?.[provider].model ?? entry?.defaultModel ?? "");
  });

  settingModel.addEventListener("change", () => {
    if (!modalProviderConfig) return;
    const provider = modalCurrentProvider;
    captureProviderConfig(provider);
    applyModelDefaults(getProviderEntry(modalProviderConfig, provider), modalProviderConfigs?.[provider].model ?? "");
  });

  settingModelSelect.addEventListener("change", () => {
    if (!modalProviderConfig) return;
    const provider = modalCurrentProvider;
    captureProviderConfig(provider);
    applyModelDefaults(getProviderEntry(modalProviderConfig, provider), modalProviderConfigs?.[provider].model ?? "");
  });
}

export function bindSettingsActions(actions: SettingsActions): void {
  const { settingsForm, btnCancelSettings, btnInitializeSettings } = getElements();

  settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    actions.onSave(readSettingsFromModal());
  });

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
