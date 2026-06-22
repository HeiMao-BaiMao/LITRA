import { getElements } from "./layout.ts";
import type {
  AiSettings,
  DeepSeekReasoningEffort,
  OpenAIReasoningEffort,
  Provider,
} from "../settings.ts";
import {
  getProviderModelDefaults,
  getProviderModelIds,
  type ProviderConfig,
  type ProviderEntry,
} from "../providers/config.ts";
import { DEEPSEEK_FIXED_MODELS } from "../ai/model-list.ts";

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

function populateDeepSeekModelSelect(currentModel: string): void {
  const { settingModelSelect } = getElements();
  settingModelSelect.innerHTML = "";
  for (const { id, label } of DEEPSEEK_FIXED_MODELS) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = label;
    settingModelSelect.appendChild(option);
  }
  settingModelSelect.value = DEEPSEEK_FIXED_MODELS.some((m) => m.id === currentModel)
    ? currentModel
    : DEEPSEEK_FIXED_MODELS[0]?.id ?? "";
}

function updateModelInputMode(provider: Provider): void {
  const { settingModel, settingModelSelect } = getElements();
  const isDeepSeek = provider === "deepseek";

  settingModel.classList.toggle("hidden", isDeepSeek);
  settingModelSelect.classList.toggle("hidden", !isDeepSeek);
}

function updateModelFetchState(provider: Provider): void {
  const { btnFetchModels } = getElements();
  const isDeepSeek = provider === "deepseek";

  btnFetchModels.disabled = isDeepSeek;
  btnFetchModels.textContent = isDeepSeek ? "DeepSeek は固定" : "取得";
}

function setSamplingControlsEnabled(enabled: boolean): void {
  const {
    settingTemperature,
    settingTopP,
    settingTopK,
    settingFrequencyPenalty,
    settingPresencePenalty,
  } = getElements();
  const inputs = [
    settingTemperature,
    settingTopP,
    settingTopK,
    settingFrequencyPenalty,
    settingPresencePenalty,
  ];
  for (const input of inputs) {
    input.disabled = !enabled;
    input.parentElement?.classList.toggle("hidden", !enabled);
  }
}

function updateSamplingControlsVisibility(provider: Provider): void {
  // DeepSeek の thinking モードでは temperature / top_p / top_k / ペナルティ類は無視される。
  setSamplingControlsEnabled(provider !== "deepseek");
}

function populateConfiguredModelList(entry: ProviderEntry | undefined): void {
  populateModelList(getProviderModelIds(entry));
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

export function renderSettings(settings: AiSettings): void {
  const {
    settingProvider,
    settingApiKey,
    settingBaseUrl,
    settingModel,
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

  const { settingModelSelect } = getElements();

  settingProvider.value = settings.provider;
  settingApiKey.value = settings.apiKey;
  settingBaseUrl.value = settings.baseUrl;
  settingModel.value = settings.model;
  settingModelSelect.value = settings.model;
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

  updateAdvancedVisibility(settings.provider);
  updateModelFetchState(settings.provider);
  updateModelInputMode(settings.provider);
  updateSamplingControlsVisibility(settings.provider);
  populateDeepSeekModelSelect(settings.model);
}

export function readSettingsFromModal(): AiSettings {
  const {
    settingProvider,
    settingApiKey,
    settingBaseUrl,
    settingModel,
    settingModelSelect,
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
  const model =
    provider === "deepseek" ? settingModelSelect.value.trim() : settingModel.value.trim();

  return {
    provider,
    apiKey: settingApiKey.value.trim(),
    baseUrl: settingBaseUrl.value.trim(),
    model,
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
    const { provider } = readSettingsFromModal();

    const entry = actions.onChange(provider);
    if (entry) {
      const { settingBaseUrl } = getElements();
      settingBaseUrl.value = entry.defaultBaseUrl;
      settingModel.value = entry.defaultModel;
      settingModelSelect.value = entry.defaultModel;
    }

    updateAdvancedVisibility(provider);
    updateModelFetchState(provider);
    updateModelInputMode(provider);
    updateSamplingControlsVisibility(provider);
    populateDeepSeekModelSelect(entry?.defaultModel ?? "");
    populateConfiguredModelList(entry);
    applyModelDefaults(entry, entry?.defaultModel ?? "");
  });

  settingModel.addEventListener("change", () => {
    const { provider, model } = readSettingsFromModal();
    applyModelDefaults(actions.onChange(provider), model);
  });

  settingModelSelect.addEventListener("change", () => {
    const { provider, model } = readSettingsFromModal();
    applyModelDefaults(actions.onChange(provider), model);
  });
}

export function bindSettingsActions(actions: SettingsActions): void {
  const { settingsForm, btnCancelSettings } = getElements();

  settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    actions.onSave(readSettingsFromModal());
  });

  btnCancelSettings.addEventListener("click", actions.onCancel);
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
