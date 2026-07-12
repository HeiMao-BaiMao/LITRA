import { emit, listen } from "@tauri-apps/api/event";
import type { ChatMessage } from "./state.ts";
import type { ChatSubmitShortcut, Provider } from "./settings.ts";
import { loadProviderConfig } from "./providers/config.ts";
import { bindAutoResize } from "./ui/auto-resize.ts";
import {
  bindChatSubmitShortcut,
  populateChatModelOptions,
  populateChatProviderOptions,
  queryChatMessagesContainer,
  queryChatWindowControls,
  renderChatMessageList,
  renderDirectWritingToggle,
  setChatGeneratingState,
  takeChatInputValue,
} from "./ui/chat-window-common.ts";
import { listenDpiZoom } from "./window/dpi-scale.ts";
import type { ProviderConfig } from "./providers/config.ts";

interface ChatSyncPayload {
  messages: ChatMessage[];
  isGenerating: boolean;
  directWritingEnabled: boolean;
}

interface ChatSettingsSyncPayload {
  provider: Provider;
  model: string;
  chatSubmitShortcut?: ChatSubmitShortcut;
}

let providerConfig: ProviderConfig | null = null;
let isSyncing = false;
let resetInputHeight: (() => void) | undefined;
let chatSubmitShortcut: ChatSubmitShortcut = "ctrlEnter";

async function init(): Promise<void> {
  void listenDpiZoom();

  const messagesContainer = queryChatMessagesContainer();
  const controls = queryChatWindowControls();
  if (!messagesContainer || !controls) return;
  const { form, input, btnCancel, providerSelect, modelSelect } = controls;

  resetInputHeight = bindAutoResize(input, 15);

  try {
    providerConfig = await loadProviderConfig();
    populateChatProviderOptions(providerSelect, providerConfig);
  } catch (error) {
    console.error("[litra:chat-window] failed to load provider config:", error);
  }

  listen<ChatSyncPayload>("chat-sync", (event) => {
    renderChatMessageList(messagesContainer, event.payload.messages);
    setChatGeneratingState(controls, event.payload.isGenerating);
    renderDirectWritingToggle(controls.btnDirectWriting, event.payload.directWritingEnabled);
  });

  listen("chat-clear-display", () => {
    messagesContainer.innerHTML = "";
  });

  listen<ChatSettingsSyncPayload>("chat-settings-sync", (event) => {
    isSyncing = true;
    try {
      const { provider, model } = event.payload;
      chatSubmitShortcut = event.payload.chatSubmitShortcut ?? "ctrlEnter";
      if (providerConfig && providerSelect.value !== provider) {
        populateChatModelOptions(modelSelect, providerConfig, provider);
      }
      providerSelect.value = provider;
      modelSelect.value = model;
    } finally {
      isSyncing = false;
    }
  });

  providerSelect.addEventListener("change", () => {
    if (isSyncing) return;
    if (!providerConfig) return;
    const provider = providerSelect.value as Provider;
    populateChatModelOptions(modelSelect, providerConfig, provider);
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
    const text = takeChatInputValue(input, resetInputHeight);
    if (!text) return;
    emit("chat-send", { content: text });
  });

  bindChatSubmitShortcut(input, form, () => chatSubmitShortcut);

  btnCancel.addEventListener("click", () => {
    emit("chat-stop", {});
  });

  controls.btnDirectWriting?.addEventListener("click", () => {
    if (controls.btnDirectWriting?.disabled) return;
    void emit("chat-direct-writing-toggle", {});
  });

  emit("chat-ready", {});
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init());
} else {
  void init();
}
