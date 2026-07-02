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

export function appendMessage(
  role: ChatMessage["role"],
  content: string,
  excludeFromContext = false,
): void {
  const container = getElements().chatMessages;
  const messageEl = document.createElement("div");
  messageEl.className = `chat-message ${role}`;
  renderChatMessageHtml(messageEl, content);
  container.appendChild(messageEl);
  scrollToBottom();

  state.chatMessages.push({ role, content, excludeFromContext });
  sync();
}

function isNearBottom(container: HTMLElement): boolean {
  return container.scrollHeight - container.scrollTop - container.clientHeight < 80;
}

export function updateLastAssistantChunk(chunk: string): void {
  const container = getElements().chatMessages;
  const followScroll = isNearBottom(container);
  let messageEl = container.querySelector<HTMLElement>(".chat-message.assistant:last-child");

  if (!messageEl) {
    messageEl = document.createElement("div");
    messageEl.className = "chat-message assistant";
    container.appendChild(messageEl);

    state.chatMessages.push({ role: "assistant", content: "" });
  }

  const lastMessage = state.chatMessages[state.chatMessages.length - 1];
  if (lastMessage && lastMessage.role === "assistant") {
    lastMessage.content += chunk;
    renderChatMessageHtml(messageEl, lastMessage.content, lastMessage.thinking);
  }
  if (followScroll) scrollToBottom();
  sync();
}

export function updateLastAssistantThinking(chunk: string): void {
  const container = getElements().chatMessages;
  const followScroll = isNearBottom(container);
  let messageEl = container.querySelector<HTMLElement>(".chat-message.assistant:last-child");

  if (!messageEl) {
    messageEl = document.createElement("div");
    messageEl.className = "chat-message assistant";
    container.appendChild(messageEl);

    state.chatMessages.push({ role: "assistant", content: "" });
  }

  const lastMessage = state.chatMessages[state.chatMessages.length - 1];
  if (lastMessage && lastMessage.role === "assistant") {
    lastMessage.thinking = `${lastMessage.thinking ?? ""}${chunk}`;
    renderChatMessageHtml(messageEl, lastMessage.content, lastMessage.thinking);
  }
  if (followScroll) scrollToBottom();
  sync();
}

export function updateMessageContent(index: number, content: string): boolean {
  const message = state.chatMessages[index];
  if (!message) return false;

  message.content = content;
  const container = getElements().chatMessages;
  const followScroll = isNearBottom(container);
  const messageEl = container.querySelectorAll<HTMLElement>(".chat-message")[index];
  if (messageEl) {
    renderChatMessageHtml(messageEl, content, message.thinking);
    if (followScroll) scrollToBottom();
  }
  sync();
  return true;
}

export function removeLastEmptyAssistantMessage(): void {
  const lastMessage = state.chatMessages[state.chatMessages.length - 1];
  if (
    !lastMessage ||
    lastMessage.role !== "assistant" ||
    lastMessage.content.trim().length > 0 ||
    (lastMessage.thinking?.trim().length ?? 0) > 0
  ) {
    return;
  }

  state.chatMessages.pop();
  const container = getElements().chatMessages;
  const lastEl = container.querySelector<HTMLElement>(".chat-message.assistant:last-child");
  lastEl?.remove();
  sync();
}

export function clearChatDisplay(): void {
  getElements().chatMessages.innerHTML = "";
}

export function clearChat(): void {
  clearChatDisplay();
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
    renderChatMessageHtml(messageEl, message.content, message.thinking);
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
