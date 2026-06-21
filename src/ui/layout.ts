export interface AppElements {
  editor: HTMLTextAreaElement;
  chatForm: HTMLFormElement;
  chatInput: HTMLTextAreaElement;
  chatMessages: HTMLElement;
  btnSend: HTMLButtonElement;
  btnCancel: HTMLButtonElement;
  btnContinue: HTMLButtonElement;
  btnRewrite: HTMLButtonElement;
  btnFeedback: HTMLButtonElement;
  btnSettings: HTMLButtonElement;
  settingsModal: HTMLElement;
  settingsForm: HTMLFormElement;
  settingApiKey: HTMLInputElement;
  settingBaseUrl: HTMLInputElement;
  settingModel: HTMLInputElement;
  settingTemperature: HTMLInputElement;
  settingMaxTokens: HTMLInputElement;
  btnSaveSettings: HTMLButtonElement;
  btnCancelSettings: HTMLButtonElement;
}

let elements: AppElements | null = null;

export function getElements(): AppElements {
  if (elements) {
    return elements;
  }

  const editor = document.querySelector<HTMLTextAreaElement>("#editor");
  const chatForm = document.querySelector<HTMLFormElement>("#chat-form");
  const chatInput = document.querySelector<HTMLTextAreaElement>("#chat-input");
  const chatMessages = document.querySelector<HTMLElement>("#chat-messages");
  const btnSend = document.querySelector<HTMLButtonElement>("#btn-send");
  const btnCancel = document.querySelector<HTMLButtonElement>("#btn-cancel");
  const btnContinue = document.querySelector<HTMLButtonElement>("#btn-continue");
  const btnRewrite = document.querySelector<HTMLButtonElement>("#btn-rewrite");
  const btnFeedback = document.querySelector<HTMLButtonElement>("#btn-feedback");
  const btnSettings = document.querySelector<HTMLButtonElement>("#btn-settings");
  const settingsModal = document.querySelector<HTMLElement>("#settings-modal");
  const settingsForm = document.querySelector<HTMLFormElement>("#settings-form");
  const settingApiKey = document.querySelector<HTMLInputElement>("#setting-api-key");
  const settingBaseUrl = document.querySelector<HTMLInputElement>("#setting-base-url");
  const settingModel = document.querySelector<HTMLInputElement>("#setting-model");
  const settingTemperature = document.querySelector<HTMLInputElement>("#setting-temperature");
  const settingMaxTokens = document.querySelector<HTMLInputElement>("#setting-max-tokens");
  const btnSaveSettings = document.querySelector<HTMLButtonElement>("#btn-save-settings");
  const btnCancelSettings = document.querySelector<HTMLButtonElement>("#btn-cancel-settings");

  if (
    !editor ||
    !chatForm ||
    !chatInput ||
    !chatMessages ||
    !btnSend ||
    !btnCancel ||
    !btnContinue ||
    !btnRewrite ||
    !btnFeedback ||
    !btnSettings ||
    !settingsModal ||
    !settingsForm ||
    !settingApiKey ||
    !settingBaseUrl ||
    !settingModel ||
    !settingTemperature ||
    !settingMaxTokens ||
    !btnSaveSettings ||
    !btnCancelSettings
  ) {
    throw new Error("Required DOM elements are missing");
  }

  elements = {
    editor,
    chatForm,
    chatInput,
    chatMessages,
    btnSend,
    btnCancel,
    btnContinue,
    btnRewrite,
    btnFeedback,
    btnSettings,
    settingsModal,
    settingsForm,
    settingApiKey,
    settingBaseUrl,
    settingModel,
    settingTemperature,
    settingMaxTokens,
    btnSaveSettings,
    btnCancelSettings,
  };

  return elements;
}
