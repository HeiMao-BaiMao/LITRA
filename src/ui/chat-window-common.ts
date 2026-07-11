import { renderChatMessageHtml } from "../markdown.ts";
import type { ChatSubmitShortcut, Provider } from "../settings.ts";
import { getProviderEntry, type ProviderConfig } from "../providers/config.ts";

export interface ChatWindowControls {
  form: HTMLFormElement;
  input: HTMLTextAreaElement;
  btnSend: HTMLButtonElement;
  btnCancel: HTMLButtonElement;
  providerSelect: HTMLSelectElement;
  modelSelect: HTMLSelectElement;
}

export interface RenderableChatMessage {
  id?: string;
  role: string;
  content: string;
  thinking?: string;
  provider?: string;
  model?: string;
  transport?: { provider?: string; model?: string; responseModelId?: string };
}

export function queryChatWindowControls(): ChatWindowControls | undefined {
  const form = document.querySelector<HTMLFormElement>("#chat-form");
  const input = document.querySelector<HTMLTextAreaElement>("#chat-input");
  const btnSend = document.querySelector<HTMLButtonElement>("#btn-send");
  const btnCancel = document.querySelector<HTMLButtonElement>("#btn-cancel");
  const providerSelect = document.querySelector<HTMLSelectElement>("#chat-provider");
  const modelSelect = document.querySelector<HTMLSelectElement>("#chat-model");

  if (!form || !input || !btnSend || !btnCancel || !providerSelect || !modelSelect) {
    return undefined;
  }

  return {
    form,
    input,
    btnSend,
    btnCancel,
    providerSelect,
    modelSelect,
  };
}

export function queryChatMessagesContainer(): HTMLElement | undefined {
  return document.querySelector<HTMLElement>("#chat-messages") ?? undefined;
}

export function setChatGeneratingState(
  controls: Pick<ChatWindowControls, "form" | "input" | "btnSend" | "btnCancel">,
  isGenerating: boolean,
): void {
  controls.form.classList.toggle("is-generating", isGenerating);
  controls.input.disabled = isGenerating;
  controls.btnSend.disabled = isGenerating;
  controls.btnCancel.disabled = !isGenerating;
  controls.btnCancel.classList.toggle("hidden", !isGenerating);
  controls.btnCancel.classList.toggle("is-active", isGenerating);
}

export function populateChatProviderOptions(
  providerSelect: HTMLSelectElement,
  providerConfig: ProviderConfig,
): void {
  providerSelect.innerHTML = "";
  for (const provider of providerConfig.providers) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.name;
    providerSelect.appendChild(option);
  }
}

export function populateChatModelOptions(
  modelSelect: HTMLSelectElement,
  providerConfig: ProviderConfig,
  providerId: Provider,
): void {
  const entry = getProviderEntry(providerConfig, providerId);
  modelSelect.innerHTML = "";
  for (const model of entry?.models ?? []) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.label ?? model.id;
    modelSelect.appendChild(option);
  }
}

export function bindChatSubmitShortcut(
  input: HTMLTextAreaElement,
  form: HTMLFormElement,
  shortcut: ChatSubmitShortcut | (() => ChatSubmitShortcut) = "ctrlEnter",
): void {
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;

    const currentShortcut = typeof shortcut === "function" ? shortcut() : shortcut;
    const shouldSubmit =
      currentShortcut === "enter"
        ? !event.shiftKey
        : !event.shiftKey && (event.ctrlKey || event.metaKey);

    if (shouldSubmit) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
}

export function takeChatInputValue(
  input: HTMLTextAreaElement,
  resetInputHeight?: () => void,
): string {
  const text = input.value.trim();
  if (!text) return "";
  input.value = "";
  resetInputHeight?.();
  return text;
}

export function renderChatMessageContent(
  element: HTMLElement,
  content: string,
  thinking?: string,
): void {
  renderChatMessageHtml(element, content, thinking);
}

export function renderChatMessageList<T extends RenderableChatMessage>(
  container: HTMLElement,
  messages: T[],
  options: {
    afterRender?: (element: HTMLElement, message: T) => void;
  } = {},
): void {
  container.innerHTML = "";
  for (const message of messages) {
    const element = document.createElement("div");
    element.className = `chat-message ${message.role}`;
    if (message.id) {
      element.dataset.messageId = message.id;
    }
    renderChatMessageHtml(
      element,
      message.content,
      message.thinking,
      message.transport ?? { provider: message.provider, model: message.model },
    );
    options.afterRender?.(element, message);
    container.appendChild(element);
  }
  container.scrollTop = container.scrollHeight;
}
