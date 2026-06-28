import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, emit } from "@tauri-apps/api/event";
import { applyWindowBounds, trackWindowBounds } from "./window/bounds.ts";
import { applyStoredRatio, createVerticalResizer } from "./ui/resizable.ts";
import { bindAutoResize } from "./ui/auto-resize.ts";
import { showError, showInfo } from "./ui/common.ts";
import { renderThreadList } from "./ui/genres/thread-list.ts";
import { renderMarkdown } from "./markdown.ts";
import {
  loadSettings,
  resolveChatSettings,
  getProviderSpecificSettings,
  type Provider,
  type AiSettings,
} from "./settings.ts";
import {
  loadProviderConfig,
  getProviderEntry,
  getProviderModelIds,
  providerRequiresApiKey,
  type ProviderConfig,
} from "./providers/config.ts";
import { streamChat } from "./ai/service.ts";
import { buildGenreChatMessages } from "./genres/chat-context.ts";
import { createGenreChatTools } from "./genres/chat-tools.ts";
import { loadGenreKnowledge } from "./genres/knowledge.ts";
import * as repository from "./genres/repository.ts";
import * as chat from "./genres/chat.ts";
import { createGenreSource } from "./genres/sources.ts";
import {
  type Genre,
  type GenreChatThread,
  type GenreChatMessage,
} from "./genres/schema.ts";
import {
  detectLongText,
  detectNovelText,
  extractAttachmentPreview,
  saveChatAttachment,
} from "./genres/chat-attachments.ts";

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
let providerConfig: ProviderConfig | null = null;
let selectedProvider: Provider | null = null;
let selectedModel: string | null = null;
let resetInputHeight: (() => void) | undefined;

async function init(): Promise<void> {
  const win = getCurrentWindow();
  await applyWindowBounds(win, "genre-chat");
  trackWindowBounds(win, "genre-chat");
  void listenDpiZoom();
  setupEventListeners();

  const app = document.getElementById("genre-chat-app");
  if (app) {
    await applyStoredRatio(app, "--genre-chat-sidebar-width", "genreChatSidebar", 0.22);
    createVerticalResizer({
      container: app,
      propertyName: "--genre-chat-sidebar-width",
      position: "left",
      positionClass: "genre-chat-left",
      saveKey: "genreChatSidebar",
      minRatio: 0.15,
      maxRatio: 0.45,
    });
  }

  const input = document.querySelector<HTMLTextAreaElement>("#chat-input");
  if (input) {
    resetInputHeight = bindAutoResize(input, 15);
  }

  await setupChatControls();

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

async function setupChatControls(): Promise<void> {
  try {
    providerConfig = await loadProviderConfig();
  } catch (error) {
    showError("プロバイダー設定の読み込みに失敗しました", error);
    providerConfig = { providers: [] };
  }

  const settings = await loadSettings();
  const resolved = resolveChatSettings(settings);
  selectedProvider = resolved.provider;
  selectedModel = resolved.model;

  const providerSelect = document.querySelector<HTMLSelectElement>("#chat-provider");
  const modelSelect = document.querySelector<HTMLSelectElement>("#chat-model");
  const form = document.querySelector<HTMLFormElement>("#chat-form");
  const input = document.querySelector<HTMLTextAreaElement>("#chat-input");
  const btnSend = document.querySelector<HTMLButtonElement>("#btn-send");
  const btnCancel = document.querySelector<HTMLButtonElement>("#btn-cancel");

  if (!providerSelect || !modelSelect || !form || !input || !btnSend || !btnCancel) return;

  for (const provider of providerConfig.providers) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.name;
    providerSelect.appendChild(option);
  }

  providerSelect.value = selectedProvider;
  renderChatModelOptions(modelSelect, selectedProvider);
  modelSelect.value = selectedModel;

  providerSelect.addEventListener("change", () => {
    const provider = providerSelect.value as Provider;
    selectedProvider = provider;
    const defaults = getProviderSpecificSettings(settings, provider);
    const fallbackModel =
      getProviderModelIds(getProviderEntry(providerConfig ?? { providers: [] }, provider))[0] ?? "";
    selectedModel = defaults.model || fallbackModel;
    renderChatModelOptions(modelSelect, provider);
    modelSelect.value = selectedModel;
  });

  modelSelect.addEventListener("change", () => {
    selectedModel = modelSelect.value;
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    resetInputHeight?.();
    void sendMessage(text);
  });

  const btnRegisterSource = document.querySelector<HTMLButtonElement>("#btn-register-source");
  btnRegisterSource?.addEventListener("click", async () => {
    const content = input.value.trim();
    if (!content) return;
    if (!state.genreId) {
      showError("ジャンルが選択されていません");
      return;
    }

    const title = window.prompt("資料のタイトルを入力してください");
    if (!title?.trim()) return;

    btnRegisterSource.disabled = true;
    try {
      await createGenreSource(state.genreId, {
        title: title.trim(),
        content,
        sourceType: "fiction_excerpt",
        sourceRole: "partial_example",
      });
      input.value = "";
      resetInputHeight?.();
      window.alert("資料として登録しました");
    } catch (error) {
      showError("資料の登録に失敗しました", error);
    } finally {
      btnRegisterSource.disabled = false;
    }
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  btnCancel.addEventListener("click", () => {
    stopStreaming();
  });
}

function renderChatModelOptions(select: HTMLSelectElement, providerId: Provider): void {
  select.innerHTML = "";
  const entry = getProviderEntry(providerConfig ?? { providers: [] }, providerId);
  for (const model of entry?.models ?? []) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.label ?? model.id;
    select.appendChild(option);
  }
}

function setGeneratingState(isGenerating: boolean): void {
  const input = document.querySelector<HTMLTextAreaElement>("#chat-input");
  const btnSend = document.querySelector<HTMLButtonElement>("#btn-send");
  const btnCancel = document.querySelector<HTMLButtonElement>("#btn-cancel");
  if (input) input.disabled = isGenerating;
  if (btnSend) btnSend.disabled = isGenerating;
  if (btnCancel) {
    btnCancel.disabled = !isGenerating;
    btnCancel.classList.toggle("hidden", !isGenerating);
  }
}

async function loadGenre(genreId: string): Promise<void> {
  try {
    state.genreId = genreId;
    state.genre = await repository.loadGenre(genreId);
    if (!state.genre) {
      showError("ジャンルが見つかりません");
      return;
    }

    const titleEl = document.getElementById("genre-chat-title");
    if (titleEl) {
      titleEl.textContent = `${state.genre.name} - ジャンルAIチャット`;
    }

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

async function buildChatSettings(): Promise<AiSettings> {
  const settings = await loadSettings();
  const provider = selectedProvider ?? settings.provider;
  const specific = getProviderSpecificSettings(settings, provider);
  return {
    ...settings,
    provider,
    apiKey: specific.apiKey,
    baseUrl: specific.baseUrl,
    model: selectedModel ?? specific.model,
  };
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

  const settings = await buildChatSettings();
  const entry = getProviderEntry(providerConfig ?? { providers: [] }, settings.provider);
  if (providerRequiresApiKey(entry) && !settings.apiKey) {
    showError(`${entry?.name ?? settings.provider} の API キーを設定してください`);
    return;
  }
  if (!settings.model.trim()) {
    showError("モデルを選択してください");
    return;
  }

  try {
    if (!state.currentThreadId) {
      const thread = await chat.createGenreChatThread(state.genreId, content.slice(0, 30));
      state.currentThreadId = thread.id;
      await refreshThreads();
    }

    const userDocument = await chat.loadGenreChatThread(state.genreId, state.currentThreadId);
    const userMessageId = crypto.randomUUID();

    let userContent = content;
    let attachments: GenreChatMessage["attachments"] | undefined;
    if (state.currentThreadId && (detectNovelText(content) || detectLongText(content))) {
      const attachmentType = detectNovelText(content) ? "novel_text" : "long_text";
      const attachmentName = attachmentType === "novel_text" ? "小説本文" : "長文テキスト";
      const attachment = await saveChatAttachment(state.genreId, state.currentThreadId, userMessageId, {
        name: attachmentName,
        type: attachmentType,
        content,
      });
      attachments = [attachment];
      userContent = `[${attachmentName}は添付ファイルに保存されました]\n\n${extractAttachmentPreview(content)}`;
    }

    const userUpdatedDocument = chat.appendMessage(userDocument, {
      id: userMessageId,
      threadId: state.currentThreadId,
      role: "user",
      content: userContent,
      attachments,
    });
    await chat.saveGenreChatThread(state.genreId, userUpdatedDocument);

    state.messages = userUpdatedDocument.messages;
    renderMessages();

    state.isStreaming = true;
    currentAbortController = new AbortController();
    setGeneratingState(true);

    const knowledge = await loadGenreKnowledge(state.genreId);
    const modelMessages = buildGenreChatMessages(state.genre, knowledge, state.messages, {
      includePendingCandidates: true,
      maxContextTokens: settings.maxContextTokens,
      maxOutputTokens: settings.maxTokens,
    });

    const tools = createGenreChatTools({
      genreId: state.genreId,
      settings,
      threadId: state.currentThreadId,
    });

    let assistantContent = "";
    const streamResult = await streamChat({
      settings,
      messages: modelMessages,
      tools,
      toolChoice: "auto",
      onChunk: (chunk) => {
        assistantContent += chunk;
        updateStreamingMessage(assistantContent);
      },
      abortSignal: currentAbortController.signal,
    });

    const assistantDocument = await chat.loadGenreChatThread(state.genreId, state.currentThreadId);
    const assistantUpdatedDocument = chat.appendMessage(assistantDocument, {
      id: crypto.randomUUID(),
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
    setGeneratingState(false);
    renderMessages();

    await emit(GENRE_CHAT_SYNC, {
      messages: state.messages,
      isGenerating: false,
    } satisfies GenreChatSyncPayload);
  } catch (error) {
    state.isStreaming = false;
    currentAbortController = null;
    setGeneratingState(false);
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
  setGeneratingState(false);
  renderMessages();
}

function updateStreamingMessage(content: string): void {
  const container = document.getElementById("chat-messages");
  if (!container) return;

  const bubble = container.querySelector<HTMLElement>(".chat-message.assistant:last-child");
  if (bubble) {
    bubble.innerHTML = renderMarkdown(content);
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function renderMessages(): void {
  const container = document.getElementById("chat-messages");
  if (!container) return;

  container.innerHTML = "";
  for (const message of state.messages) {
    const el = document.createElement("div");
    el.className = `chat-message ${message.role}`;
    el.innerHTML = renderMarkdown(message.content);

    if (message.attachments?.length) {
      const attachmentList = document.createElement("div");
      attachmentList.className = "chat-attachments";
      for (const attachment of message.attachments) {
        const badge = document.createElement("span");
        badge.className = "chat-attachment-badge";
        badge.textContent = `📎 ${attachment.name} (${formatBytes(attachment.size)})`;
        attachmentList.appendChild(badge);
      }
      el.appendChild(attachmentList);
    }

    const referencedSourceCount = message.referencedSourceIds?.length ?? 0;
    if (referencedSourceCount > 0) {
      const sourceList = document.createElement("div");
      sourceList.className = "genre-chat-referenced-sources";
      sourceList.textContent = `参照資料: ${referencedSourceCount}件`;
      el.appendChild(sourceList);
    }

    const referencedCandidateCount = message.referencedCandidateIds?.length ?? 0;
    if (referencedCandidateCount > 0) {
      const candidates = document.createElement("div");
      candidates.className = "genre-chat-candidates";
      candidates.textContent = `提案中の候補: ${referencedCandidateCount}件`;
      el.appendChild(candidates);
    }

    container.appendChild(el);
  }
  container.scrollTop = container.scrollHeight;
}

window.addEventListener("DOMContentLoaded", () => {
  init().catch((error) => {
    console.error("Failed to initialize genre chat window:", error);
    showError("ジャンルチャットの初期化に失敗しました", error);
  });
});

window.addEventListener("beforeunload", () => {
  stopStreaming();
});
