import { getElements } from "./layout.ts";
import type {
  AiSettings,
  DeepSeekReasoningEffort,
  DeepSeekThinkingMode,
  OpenAIReasoningEffort,
  Provider,
} from "../settings.ts";
import type { ProviderConfig, ProviderEntry } from "../providers/config.ts";

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

function parseDeepSeekThinkingMode(value: string): DeepSeekThinkingMode | undefined {
  if (value === "adaptive" || value === "enabled" || value === "disabled") return value;
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

export function renderSettings(settings: AiSettings): void {
  const {
    settingProvider,
    settingApiKey,
    settingBaseUrl,
    settingModel,
    settingTemperature,
    settingMaxTokens,
    settingTopP,
    settingTopK,
    settingFrequencyPenalty,
    settingPresencePenalty,
    settingOpenaiReasoningEffort,
    settingDeepseekThinkingMode,
    settingDeepseekReasoningEffort,
    settingAnthropicThinkingEnabled,
    settingAnthropicThinkingBudget,
  } = getElements();

  settingProvider.value = settings.provider;
  settingApiKey.value = settings.apiKey;
  settingBaseUrl.value = settings.baseUrl;
  settingModel.value = settings.model;
  settingTemperature.value = String(settings.temperature);
  settingMaxTokens.value = String(settings.maxTokens);
  settingTopP.value = optionalNumberInput(settings.topP);
  settingTopK.value = optionalNumberInput(settings.topK);
  settingFrequencyPenalty.value = optionalNumberInput(settings.frequencyPenalty);
  settingPresencePenalty.value = optionalNumberInput(settings.presencePenalty);
  settingOpenaiReasoningEffort.value = settings.openaiReasoningEffort ?? "";
  settingDeepseekThinkingMode.value = settings.deepseekThinkingMode ?? "";
  settingDeepseekReasoningEffort.value = settings.deepseekReasoningEffort ?? "";
  settingAnthropicThinkingEnabled.checked = settings.anthropicThinkingEnabled ?? false;
  settingAnthropicThinkingBudget.value = optionalNumberInput(settings.anthropicThinkingBudget);

  updateAdvancedVisibility(settings.provider);
}

export function readSettingsFromModal(): AiSettings {
  const {
    settingProvider,
    settingApiKey,
    settingBaseUrl,
    settingModel,
    settingTemperature,
    settingMaxTokens,
    settingTopP,
    settingTopK,
    settingFrequencyPenalty,
    settingPresencePenalty,
    settingOpenaiReasoningEffort,
    settingDeepseekThinkingMode,
    settingDeepseekReasoningEffort,
    settingAnthropicThinkingEnabled,
    settingAnthropicThinkingBudget,
  } = getElements();

  return {
    provider: settingProvider.value as Provider,
    apiKey: settingApiKey.value.trim(),
    baseUrl: settingBaseUrl.value.trim(),
    model: settingModel.value.trim(),
    temperature: Number(settingTemperature.value),
    maxTokens: Number(settingMaxTokens.value),
    topP: parseOptionalNumber(settingTopP.value),
    topK: parseOptionalNumber(settingTopK.value),
    frequencyPenalty: parseOptionalNumber(settingFrequencyPenalty.value),
    presencePenalty: parseOptionalNumber(settingPresencePenalty.value),
    openaiReasoningEffort: parseOpenAIReasoningEffort(settingOpenaiReasoningEffort.value),
    deepseekThinkingMode: parseDeepSeekThinkingMode(settingDeepseekThinkingMode.value),
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
  const { settingProvider } = getElements();

  settingProvider.addEventListener("change", () => {
    const { provider } = readSettingsFromModal();
    const datalist = document.querySelector<HTMLDataListElement>("#setting-model-list");
    if (datalist) datalist.innerHTML = "";

    const entry = actions.onChange(provider);
    if (entry) {
      const { settingBaseUrl, settingModel } = getElements();
      settingBaseUrl.value = entry.defaultBaseUrl;
      settingModel.value = entry.defaultModel;
    }

    updateAdvancedVisibility(provider);
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
