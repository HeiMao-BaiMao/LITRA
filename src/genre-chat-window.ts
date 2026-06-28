import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, emit } from "@tauri-apps/api/event";
import { applyWindowBounds, trackWindowBounds } from "./window/bounds.ts";
import { showError, showInfo } from "./ui/common.ts";
import { renderThreadList } from "./ui/genres/thread-list.ts";
import { renderGenreChat } from "./ui/genres/genre-chat.ts";
import { loadSettings, resolveChatSettings } from "./settings.ts";
import { streamChat } from "./ai/service.ts";
import { buildGenreChatMessages } from "./genres/chat-context.ts";
import { loadGenreKnowledge } from "./genres/knowledge.ts";
import * as repository from "./genres/repository.ts";
import * as chat from "./genres/chat.ts";
import type { Genre, GenreChatThread, GenreChatMessage } from "./genres/schema.ts";
import {
  GENRE_CHAT_SYNC,
  GENRE_CHAT_SEND,
  GENRE_CHAT_STOP,
  GENRE_SELECTED,
  type GenreChatSyncPayload,
  type GenreChatSendPayload,
  type GenreSelectedEvent,
} from "./genres/events.ts";
import { listenDpiZoom } from "./window/dpi-scale.ts";

interface ChatState {
  genreId: string | null;
  genre: Genre | null;
  threads: GenreChatThread[];
  currentThreadId: string | null;
  messages: GenreChatMessage[];
  isStreaming: boolean;
}

const state: ChatState = {
  genreId: null,
  genre: null,
  threads: [],
  currentThreadId: null,
  messages: [],
  isStreaming: false,
};

let currentAbortController: AbortController | null = null;

async function init(): Promise<void> {
  const win = getCurrentWindow();
  await applyWindowBounds(win, "genre-chat");
  trackWindowBounds(win, "genre-chat");
  void listenDpiZoom();
  setupEventListeners();

  const urlParams = new URLSearchParams(window.location.search);
  const genreId = urlParams.get("genreId");

  if (genreId) {
    await loadGenre(genreId);
  }
}

function setupEventListeners(): void {
  listen<GenreSelectedEvent>(GENRE_SELECTED, async (event) => {
    await loadGenre(event.payload.genreId);
  });

  listen<GenreChatSendPayload>(GENRE_CHAT_SEND, async (event) => {
    await sendMessage(event.payload.content);
  });

  listen(GENRE_CHAT_STOP, () => {
    stopStreaming();
  });
}

async function loadGenre(genreId: string): Promise<void> {
  try {
    state.genreId = genreId;
    state.genre = await repository.loadGenre(genreId);
    if (!state.genre) {
      showError("ジャンルが見つかりません");
      return;
    }

    document.getElementById("genre-chat-title")!.textContent = `${state.genre.name} - ジャンルAIチャット`;

    await refreshThreads();

    if (!state.currentThreadId && state.threads.length > 0) {
      state.currentThreadId = state.threads[0].id;
      await loadCurrentThread();
    }
  } catch (error) {
    showError("ジャンルの読み込みに失敗しました", error);
  }
}

async function refreshThreads(): Promise<void> {
  if (!state.genreId) return;
  try {
    state.threads = await chat.listGenreChatThreads(state.genreId);
    const container = document.getElementById("thread-list");
    if (container) {
      renderThreadList(container, state.threads, state.currentThreadId, {
        onSelect: async (threadId) => {
          state.currentThreadId = threadId;
          await loadCurrentThread();
          await refreshThreads();
        },
        onCreate: createThread,
        onRename: renameThread,
        onArchive: archiveThread,
        onDelete: deleteThread,
      });
    }
  } catch (error) {
    showError("スレッド一覧の取得に失敗しました", error);
  }
}

async function loadCurrentThread(): Promise<void> {
  if (!state.genreId || !state.currentThreadId) {
    state.messages = [];
    renderMessages();
    return;
  }

  try {
    const document = await chat.loadGenreChatThread(state.genreId, state.currentThreadId);
    state.messages = document.messages;
    renderMessages();
  } catch (error) {
    showError("メッセージの読み込みに失敗しました", error);
  }
}

async function createThread(): Promise<void> {
  if (!state.genreId) return;
  try {
    const thread = await chat.createGenreChatThread(state.genreId, "新規スレッド");
    state.currentThreadId = thread.id;
    await refreshThreads();
    await loadCurrentThread();
  } catch (error) {
    showError("スレッドの作成に失敗しました", error);
  }
}

async function renameThread(threadId: string, title: string): Promise<void> {
  if (!state.genreId) return;
  try {
    await chat.updateThreadTitle(state.genreId, threadId, title);
    await refreshThreads();
  } catch (error) {
    showError("スレッド名の変更に失敗しました", error);
  }
}

async function archiveThread(threadId: string): Promise<void> {
  if (!state.genreId) return;
  try {
    await chat.archiveThread(state.genreId, threadId);
    if (state.currentThreadId === threadId) {
      state.currentThreadId = null;
      state.messages = [];
      renderMessages();
    }
    await refreshThreads();
  } catch (error) {
    showError("スレッドのアーカイブに失敗しました", error);
  }
}

async function deleteThread(threadId: string): Promise<void> {
  if (!state.genreId) return;
  if (!window.confirm("このスレッドを削除しますか？")) return;

  try {
    await chat.deleteGenreChatThread(state.genreId, threadId);
    if (state.currentThreadId === threadId) {
      state.currentThreadId = null;
      state.messages = [];
      renderMessages();
    }
    await refreshThreads();
  } catch (error) {
    showError("スレッドの削除に失敗しました", error);
  }
}

async function sendMessage(content: string): Promise<void> {
  if (!state.genreId || !state.genre) {
    showError("ジャンルが選択されていません");
    return;
  }

  if (state.isStreaming) {
    stopStreaming();
    return;
  }

  const settings = resolveChatSettings(await loadSettings());
  if (!settings.apiKey) {
    showError("AI設定でAPIキーを設定してください");
    return;
  }

  try {
    if (!state.currentThreadId) {
      const thread = await chat.createGenreChatThread(state.genreId, content.slice(0, 30));
      state.currentThreadId = thread.id;
      await refreshThreads();
    }

    const userDocument = await chat.loadGenreChatThread(state.genreId, state.currentThreadId);
    const userUpdatedDocument = chat.appendMessage(userDocument, {
      threadId: state.currentThreadId,
      role: "user",
      content,
    });
    await chat.saveGenreChatThread(state.genreId, userUpdatedDocument);

    state.messages = userUpdatedDocument.messages;
    renderMessages();

    state.isStreaming = true;
    currentAbortController = new AbortController();
    renderMessages();

    const knowledge = await loadGenreKnowledge(state.genreId);
    const modelMessages = buildGenreChatMessages(state.genre, knowledge, state.messages);

    let assistantContent = "";
    const streamResult = await streamChat({
      settings,
      messages: modelMessages,
      onChunk: (chunk) => {
        assistantContent += chunk;
        updateStreamingMessage(assistantContent);
      },
      abortSignal: currentAbortController.signal,
    });

    const assistantDocument = await chat.loadGenreChatThread(state.genreId, state.currentThreadId);
    const assistantUpdatedDocument = chat.appendMessage(assistantDocument, {
      threadId: state.currentThreadId,
      role: "assistant",
      content: assistantContent,
      provider: settings.provider,
      model: settings.model,
      finishReason: streamResult.finishReason,
    });
    await chat.saveGenreChatThread(state.genreId, assistantUpdatedDocument);

    state.messages = assistantUpdatedDocument.messages;
    state.isStreaming = false;
    currentAbortController = null;
    renderMessages();

    await emit(GENRE_CHAT_SYNC, {
      messages: state.messages,
      isGenerating: false,
    } satisfies GenreChatSyncPayload);
  } catch (error) {
    state.isStreaming = false;
    currentAbortController = null;
    if (error instanceof Error && error.name === "AbortError") {
      showInfo("生成を中断しました");
    } else {
      showError("メッセージの送信に失敗しました", error);
    }
    renderMessages();
  }
}

function stopStreaming(): void {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
  state.isStreaming = false;
  renderMessages();
}

function updateStreamingMessage(content: string): void {
  const container = document.getElementById("genre-chat-messages");
  if (!container) return;

  const bubble = container.querySelector(".genre-chat-message.assistant:last-child .genre-chat-bubble");
  if (bubble) {
    bubble.innerHTML = content;
  } else {
    state.messages = [
      ...state.messages,
      {
        id: "streaming",
        threadId: state.currentThreadId ?? "",
        role: "assistant",
        content,
        createdAt: new Date().toISOString(),
      },
    ];
    renderMessages();
  }
}

function renderMessages(): void {
  const container = document.getElementById("genre-chat-main");
  if (!container) return;

  renderGenreChat(container, state.messages, state.isStreaming, {
    onSend: sendMessage,
    onStop: stopStreaming,
  });
}

window.addEventListener("DOMContentLoaded", () => {
  init().catch((error) => {
    console.error("Failed to initialize genre chat window:", error);
    showError("ジャンルチャットの初期化に失敗しました", error);
  });
});

getCurrentWindow().onCloseRequested(() => {
  stopStreaming();
});
