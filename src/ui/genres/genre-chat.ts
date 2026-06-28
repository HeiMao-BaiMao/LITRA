import type { GenreChatMessage } from "../../genres/schema.ts";
import { renderMarkdown } from "../../markdown.ts";

export interface GenreChatActions {
  onSend: (content: string) => void;
  onStop: () => void;
}

export function renderGenreChat(
  container: HTMLElement,
  messages: GenreChatMessage[],
  isStreaming: boolean,
  actions: GenreChatActions,
): void {
  container.innerHTML = "";

  const messagesEl = document.createElement("div");
  messagesEl.className = "genre-chat-messages";

  for (const message of messages) {
    const row = document.createElement("div");
    row.className = `genre-chat-message ${message.role}`;

    const bubble = document.createElement("div");
    bubble.className = "genre-chat-bubble";
    bubble.innerHTML = renderMarkdown(message.content);

    const referencedSourceCount = message.referencedSourceIds?.length ?? 0;
    if (referencedSourceCount > 0) {
      const sourceList = document.createElement("div");
      sourceList.className = "genre-chat-referenced-sources";
      sourceList.textContent = `参照資料: ${referencedSourceCount}件`;
      bubble.appendChild(sourceList);
    }

    const referencedCandidateCount = message.referencedCandidateIds?.length ?? 0;
    if (referencedCandidateCount > 0) {
      const candidates = document.createElement("div");
      candidates.className = "genre-chat-candidates";
      candidates.textContent = `提案中の候補: ${referencedCandidateCount}件`;
      bubble.appendChild(candidates);
    }

    row.appendChild(bubble);
    messagesEl.appendChild(row);
  }

  container.appendChild(messagesEl);

  const inputArea = document.createElement("div");
  inputArea.className = "genre-chat-input-area";

  const textarea = document.createElement("textarea");
  textarea.className = "genre-chat-input";
  textarea.placeholder = "質問や指示を入力...（Shift+Enterで送信）";
  textarea.rows = 3;
  textarea.disabled = isStreaming;

  const btnSend = document.createElement("button");
  btnSend.type = "button";
  btnSend.className = "genre-chat-send";
  btnSend.textContent = isStreaming ? "停止" : "送信";
  btnSend.disabled = !isStreaming && textarea.value.trim().length === 0;

  const updateButton = () => {
    if (isStreaming) {
      btnSend.textContent = "停止";
      btnSend.disabled = false;
    } else {
      btnSend.textContent = "送信";
      btnSend.disabled = textarea.value.trim().length === 0;
    }
  };

  textarea.addEventListener("input", updateButton);
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      const content = textarea.value.trim();
      if (content) {
        actions.onSend(content);
        textarea.value = "";
        updateButton();
      }
    }
  });

  btnSend.addEventListener("click", () => {
    if (isStreaming) {
      actions.onStop();
    } else {
      const content = textarea.value.trim();
      if (content) {
        actions.onSend(content);
        textarea.value = "";
        updateButton();
      }
    }
  });

  inputArea.appendChild(textarea);
  inputArea.appendChild(btnSend);
  container.appendChild(inputArea);
}
