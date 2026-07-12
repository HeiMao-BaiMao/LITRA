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

// --- ストリーミング中の描画・同期の間引き ---------------------------------
// チャンクごとに全文 Markdown 再レンダー＋全履歴 IPC 送信を行うと、
// 返答が長くなるにつれて UI が固まりリアルタイム性が失われる。
// 描画は requestAnimationFrame で 1 フレームに 1 回へ集約し、
// 別ウィンドウへの同期はトレーリング付きスロットルで間引く。

const STREAM_SYNC_INTERVAL_MS = 100;
let pendingRenderFrame: number | null = null;
let streamRenderTarget: { el: HTMLElement; message: ChatMessage } | null = null;
let lastSyncAt = 0;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

function throttledSync(): void {
  const elapsed = Date.now() - lastSyncAt;
  if (elapsed >= STREAM_SYNC_INTERVAL_MS) {
    lastSyncAt = Date.now();
    sync();
    return;
  }
  if (syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    lastSyncAt = Date.now();
    sync();
  }, STREAM_SYNC_INTERVAL_MS - elapsed);
}

function scheduleStreamRender(el: HTMLElement, message: ChatMessage): void {
  streamRenderTarget = { el, message };
  if (pendingRenderFrame !== null) return;
  pendingRenderFrame = requestAnimationFrame(() => {
    pendingRenderFrame = null;
    const target = streamRenderTarget;
    streamRenderTarget = null;
    if (!target || !target.el.isConnected) return;
    const container = getElements().chatMessages;
    const followScroll = isNearBottom(container);
    renderChatMessageHtml(target.el, target.message.content, target.message.thinking, target.message.transport);
    if (followScroll) scrollToBottom();
  });
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
    scheduleStreamRender(messageEl, lastMessage);
  }
  throttledSync();
}

export function updateLastAssistantThinking(chunk: string): void {
  const container = getElements().chatMessages;
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
    scheduleStreamRender(messageEl, lastMessage);
  }
  throttledSync();
}

export function updateMessageContent(index: number, content: string): boolean {
  const message = state.chatMessages[index];
  if (!message) return false;

  message.content = content;
  const container = getElements().chatMessages;
  const followScroll = isNearBottom(container);
  const messageEl = container.querySelectorAll<HTMLElement>(".chat-message")[index];
  if (messageEl) {
    renderChatMessageHtml(messageEl, content, message.thinking, message.transport);
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
    renderChatMessageHtml(messageEl, message.content, message.thinking, message.transport);
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
