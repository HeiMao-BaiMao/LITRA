import { getElements } from "./layout.ts";
import type { AiSettings } from "../settings.ts";

export function renderSettings(settings: AiSettings): void {
  const {
    settingApiKey,
    settingBaseUrl,
    settingModel,
    settingTemperature,
    settingMaxTokens,
  } = getElements();

  settingApiKey.value = settings.apiKey;
  settingBaseUrl.value = settings.baseUrl;
  settingModel.value = settings.model;
  settingTemperature.value = String(settings.temperature);
  settingMaxTokens.value = String(settings.maxTokens);
}

export function readSettingsFromModal(): AiSettings {
  const {
    settingApiKey,
    settingBaseUrl,
    settingModel,
    settingTemperature,
    settingMaxTokens,
  } = getElements();

  return {
    apiKey: settingApiKey.value.trim(),
    baseUrl: settingBaseUrl.value.trim(),
    model: settingModel.value.trim(),
    temperature: Number(settingTemperature.value),
    maxTokens: Number(settingMaxTokens.value),
  };
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

export function bindSettingsActions(actions: SettingsActions): void {
  const { settingsForm, btnCancelSettings } = getElements();

  settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    actions.onSave(readSettingsFromModal());
  });

  btnCancelSettings.addEventListener("click", actions.onCancel);
}
