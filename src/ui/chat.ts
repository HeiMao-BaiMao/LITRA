import { getElements } from "./layout.ts";
import { state, type ChatMessage } from "../state.ts";
import { renderChatMessageHtml } from "../markdown.ts";

let onSync: ((messages: ChatMessage[], isGenerating: boolean) => void) | null = null;

export function setChatSyncCallback(callback: (messages: ChatMessage[], isGenerating: boolean) => void): void {
  onSync = callback;
}

function sync(): void {
  onSync?.([...state.chatMessages], state.isGenerating);
}

export function appendMessage(role: ChatMessage["role"], content: string): void {
  const container = getElements().chatMessages;
  const messageEl = document.createElement("div");
  messageEl.className = `chat-message ${role}`;
  renderChatMessageHtml(messageEl, content);
  container.appendChild(messageEl);
  scrollToBottom();

  state.chatMessages.push({ role, content });
  sync();
}

export function updateLastAssistantChunk(chunk: string): void {
  const container = getElements().chatMessages;
  let messageEl = container.querySelector<HTMLElement>(".chat-message.assistant:last-child");

  if (!messageEl) {
    messageEl = document.createElement("div");
    messageEl.className = "chat-message assistant";
    container.appendChild(messageEl);

    state.chatMessages.push({ role: "assistant", content: "" });
    scrollToBottom();
  }

  const lastMessage = state.chatMessages[state.chatMessages.length - 1];
  if (lastMessage && lastMessage.role === "assistant") {
    lastMessage.content += chunk;
    renderChatMessageHtml(messageEl, lastMessage.content);
  }
  sync();
}

export function clearChat(): void {
  getElements().chatMessages.innerHTML = "";
  state.chatMessages.length = 0;
  sync();
}

export function renderMessages(messages: ChatMessage[]): void {
  const container = getElements().chatMessages;
  container.innerHTML = "";
  state.chatMessages.length = 0;

  for (const message of messages) {
    const messageEl = document.createElement("div");
    messageEl.className = `chat-message ${message.role}`;
    renderChatMessageHtml(messageEl, message.content);
    container.appendChild(messageEl);
    state.chatMessages.push(message);
  }

  scrollToBottom();
  sync();
}

export function scrollToBottom(): void {
  const container = getElements().chatMessages;
  container.scrollTop = container.scrollHeight;
}
