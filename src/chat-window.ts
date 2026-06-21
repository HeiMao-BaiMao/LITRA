import { emit, listen } from "@tauri-apps/api/event";
import type { ChatMessage } from "./state.ts";

interface ChatSyncPayload {
  messages: ChatMessage[];
  isGenerating: boolean;
}

function renderMessages(container: HTMLElement, messages: ChatMessage[]): void {
  container.innerHTML = "";
  for (const message of messages) {
    const el = document.createElement("div");
    el.className = `chat-message ${message.role}`;
    el.textContent = message.content;
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

function init(): void {
  const messagesContainer = document.querySelector<HTMLElement>("#chat-messages");
  const form = document.querySelector<HTMLFormElement>("#chat-form");
  const input = document.querySelector<HTMLTextAreaElement>("#chat-input");
  const btnSend = document.querySelector<HTMLButtonElement>("#btn-send");
  const btnCancel = document.querySelector<HTMLButtonElement>("#btn-cancel");

  if (!messagesContainer || !form || !input || !btnSend || !btnCancel) return;

  listen<ChatSyncPayload>("chat-sync", (event) => {
    renderMessages(messagesContainer, event.payload.messages);
    setGeneratingState(event.payload.isGenerating, input, btnSend, btnCancel);
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
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
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
