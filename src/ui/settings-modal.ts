import { getElements } from "./layout.ts";
import type { AiSettings, Provider } from "../settings.ts";
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

export function renderSettings(settings: AiSettings): void {
  const {
    settingProvider,
    settingApiKey,
    settingBaseUrl,
    settingModel,
    settingTemperature,
    settingMaxTokens,
  } = getElements();

  settingProvider.value = settings.provider;
  settingApiKey.value = settings.apiKey;
  settingBaseUrl.value = settings.baseUrl;
  settingModel.value = settings.model;
  settingTemperature.value = String(settings.temperature);
  settingMaxTokens.value = String(settings.maxTokens);
}

export function readSettingsFromModal(): AiSettings {
  const {
    settingProvider,
    settingApiKey,
    settingBaseUrl,
    settingModel,
    settingTemperature,
    settingMaxTokens,
  } = getElements();

  return {
    provider: settingProvider.value as Provider,
    apiKey: settingApiKey.value.trim(),
    baseUrl: settingBaseUrl.value.trim(),
    model: settingModel.value.trim(),
    temperature: Number(settingTemperature.value),
    maxTokens: Number(settingMaxTokens.value),
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
