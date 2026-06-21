import { getElements } from "./layout.ts";
import { state, type ChatMessage } from "../state.ts";

export function appendMessage(role: ChatMessage["role"], content: string): void {
  const container = getElements().chatMessages;
  const messageEl = document.createElement("div");
  messageEl.className = `chat-message ${role}`;
  messageEl.textContent = content;
  container.appendChild(messageEl);
  scrollToBottom();

  state.chatMessages.push({ role, content });
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

  messageEl.textContent += chunk;
  const lastMessage = state.chatMessages[state.chatMessages.length - 1];
  if (lastMessage && lastMessage.role === "assistant") {
    lastMessage.content += chunk;
  }
}

export function clearChat(): void {
  getElements().chatMessages.innerHTML = "";
  state.chatMessages.length = 0;
}

export function scrollToBottom(): void {
  const container = getElements().chatMessages;
  container.scrollTop = container.scrollHeight;
}
