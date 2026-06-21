import { getElements } from "./layout.ts";
import type { AiSettings, Provider } from "../settings.ts";

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
