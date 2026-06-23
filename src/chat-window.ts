import { emit, listen } from "@tauri-apps/api/event";
import type { ChatMessage } from "./state.ts";
import type { Provider } from "./settings.ts";
import { renderChatMessageHtml } from "./markdown.ts";
import { loadProviderConfig, getProviderEntry } from "./providers/config.ts";
import { bindAutoResize } from "./ui/auto-resize.ts";
import { listenDpiZoom } from "./window/dpi-scale.ts";
import type { ProviderConfig } from "./providers/config.ts";

interface ChatSyncPayload {
  messages: ChatMessage[];
  isGenerating: boolean;
}

interface ChatSettingsSyncPayload {
  provider: Provider;
  model: string;
}

let providerConfig: ProviderConfig | null = null;
let isSyncing = false;
let resetInputHeight: (() => void) | undefined;

function renderMessages(container: HTMLElement, messages: ChatMessage[]): void {
  container.innerHTML = "";
  for (const message of messages) {
    const el = document.createElement("div");
    el.className = `chat-message ${message.role}`;
    renderChatMessageHtml(el, message.content);
    container.appendChild(el);
  }
  container.scrollTop = container.scrollHeight;
}

function setGeneratingState(
  isGenerating: boolean,
  input: HTMLTextAreaElement,
  btnSend: HTMLButtonElement,
  btnCancel: HTMLButtonElement,
): void {
  input.disabled = isGenerating;
  btnSend.disabled = isGenerating;
  btnCancel.disabled = !isGenerating;
  btnCancel.classList.toggle("hidden", !isGenerating);
}

function populateProviderOptions(providerSelect: HTMLSelectElement): void {
  if (!providerConfig) return;
  providerSelect.innerHTML = "";
  for (const provider of providerConfig.providers) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.name;
    providerSelect.appendChild(option);
  }
}

function populateModelOptions(modelSelect: HTMLSelectElement, providerId: Provider): void {
  if (!providerConfig) return;
  const entry = getProviderEntry(providerConfig, providerId);
  modelSelect.innerHTML = "";
  for (const model of entry?.models ?? []) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.label ?? model.id;
    modelSelect.appendChild(option);
  }
}

async function init(): Promise<void> {
  void listenDpiZoom();

  const messagesContainer = document.querySelector<HTMLElement>("#chat-messages");
  const form = document.querySelector<HTMLFormElement>("#chat-form");
  const input = document.querySelector<HTMLTextAreaElement>("#chat-input");
  const btnSend = document.querySelector<HTMLButtonElement>("#btn-send");
  const btnCancel = document.querySelector<HTMLButtonElement>("#btn-cancel");
  const providerSelect = document.querySelector<HTMLSelectElement>("#chat-provider");
  const modelSelect = document.querySelector<HTMLSelectElement>("#chat-model");

  if (!messagesContainer || !form || !input || !btnSend || !btnCancel || !providerSelect || !modelSelect) return;

  resetInputHeight = bindAutoResize(input, 15);

  try {
    providerConfig = await loadProviderConfig();
    populateProviderOptions(providerSelect);
  } catch (error) {
    console.error("[phenex:chat-window] failed to load provider config:", error);
  }

  listen<ChatSyncPayload>("chat-sync", (event) => {
    renderMessages(messagesContainer, event.payload.messages);
    setGeneratingState(event.payload.isGenerating, input, btnSend, btnCancel);
  });

  listen("chat-clear-display", () => {
    messagesContainer.innerHTML = "";
  });

  listen<ChatSettingsSyncPayload>("chat-settings-sync", (event) => {
    isSyncing = true;
    try {
      const { provider, model } = event.payload;
      if (providerSelect.value !== provider) {
        populateModelOptions(modelSelect, provider);
      }
      providerSelect.value = provider;
      modelSelect.value = model;
    } finally {
      isSyncing = false;
    }
  });

  providerSelect.addEventListener("change", () => {
    if (isSyncing) return;
    const provider = providerSelect.value as Provider;
    populateModelOptions(modelSelect, provider);
    const model = modelSelect.value;
    void emit("chat-settings-change", { provider, model });
  });

  modelSelect.addEventListener("change", () => {
    if (isSyncing) return;
    const provider = providerSelect.value as Provider;
    const model = modelSelect.value;
    void emit("chat-settings-change", { provider, model });
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    resetInputHeight?.();
    emit("chat-send", { content: text });
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  btnCancel.addEventListener("click", () => {
    emit("chat-stop", {});
  });

  emit("chat-ready", {});
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init());
} else {
  void init();
}
