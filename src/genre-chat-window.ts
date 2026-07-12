import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, emit } from "@tauri-apps/api/event";
import type { ModelMessage } from "ai";
import { applyWindowBounds, trackWindowBounds } from "./window/bounds.ts";
import { applyStoredRatio, createVerticalResizer } from "./ui/resizable.ts";
import { bindAutoResize } from "./ui/auto-resize.ts";
import { showError, showInfo } from "./ui/common.ts";
import { renderThreadList } from "./ui/genres/thread-list.ts";
import {
  bindChatSubmitShortcut,
  populateChatModelOptions,
  populateChatProviderOptions,
  queryChatMessagesContainer,
  queryChatWindowControls,
  renderChatMessageContent,
  renderChatMessageList,
  setChatGeneratingState,
  takeChatInputValue,
} from "./ui/chat-window-common.ts";
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
import { streamChat, type StreamRunResult, type StreamToolEvent } from "./ai/service.ts";
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

const TOOL_TRACE_MAX_CHARS = 12000;
const GENRE_CHAT_MAX_LENGTH_CONTINUATIONS = 2;
const GENRE_CHAT_TOOL_RECOVERY_PROMPT =
  "直前の応答はツール実行後に最終回答へ進まず停止しました。直前までのツール実行結果と会話文脈だけを根拠に、ユーザーへの最終応答を日本語で簡潔に返してください。追加のツール呼び出しはできません。";
const GENRE_CHAT_LENGTH_CONTINUATION_PROMPT =
  "前の応答は出力上限で途中で切れています。すでに書いた内容を繰り返さず、直前の文から自然に続きを日本語で続けてください。前置き、見出し、注釈は不要です。";

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

  const controls = queryChatWindowControls();
  if (!controls) return;
  const { providerSelect, modelSelect, form, input, btnCancel } = controls;

  populateChatProviderOptions(providerSelect, providerConfig);
  providerSelect.value = selectedProvider;
  populateChatModelOptions(modelSelect, providerConfig, selectedProvider);
  modelSelect.value = selectedModel;

  providerSelect.addEventListener("change", () => {
    const provider = providerSelect.value as Provider;
    selectedProvider = provider;
    const defaults = getProviderSpecificSettings(settings, provider);
    const fallbackModel =
      getProviderModelIds(getProviderEntry(providerConfig ?? { providers: [] }, provider))[0] ?? "";
    selectedModel = defaults.model || fallbackModel;
    populateChatModelOptions(modelSelect, providerConfig ?? { providers: [] }, provider);
    modelSelect.value = selectedModel;
  });

  modelSelect.addEventListener("change", () => {
    selectedModel = modelSelect.value;
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = takeChatInputValue(input, resetInputHeight);
    if (!text) return;
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

  bindChatSubmitShortcut(input, form, settings.chatSubmitShortcut);

  btnCancel.addEventListener("click", () => {
    stopStreaming();
  });
}

function setGeneratingState(isGenerating: boolean): void {
  const controls = queryChatWindowControls();
  if (controls) setChatGeneratingState(controls, isGenerating);
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
      titleEl.textContent = `${state.genre.name} - ジャンルリトラチャット`;
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
  const rawTitle = window.prompt("新しいスレッド名", "新規スレッド");
  if (rawTitle === null) return;
  const title = rawTitle.trim() || "新規スレッド";
  try {
    const thread = await chat.createGenreChatThread(state.genreId, title);
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

function limitToolTraceText(text: string, maxChars = TOOL_TRACE_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const marker = "\n\n【中略】\n\n";
  const available = Math.max(0, maxChars - marker.length);
  if (available <= 0) return text.slice(0, maxChars);
  const headChars = Math.ceil(available / 2);
  const tailChars = Math.floor(available / 2);
  return `${text.slice(0, headChars)}${marker}${text.slice(text.length - tailChars)}`;
}

function stringifyTraceValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatToolTrace(events: StreamToolEvent[]): string {
  const lines = events
    .filter((event) => event.type === "result" || event.type === "error")
    .map((event) => {
      if (event.type === "result") {
        return [
          `## ${event.toolName}`,
          "input:",
          limitToolTraceText(stringifyTraceValue(event.input), 2000),
          "output:",
          limitToolTraceText(stringifyTraceValue(event.output), 5000),
        ].join("\n");
      }
      return [
        `## ${event.toolName}`,
        "input:",
        limitToolTraceText(stringifyTraceValue(event.input), 2000),
        "error:",
        limitToolTraceText(stringifyTraceValue(event.error), 3000),
      ].join("\n");
    });

  return limitToolTraceText(lines.join("\n\n"));
}

function canUseStructuredToolRecovery(result: StreamRunResult): boolean {
  return result.stoppedAfterToolResult && result.pendingToolCallIds.length === 0 && result.responseMessages.length > 0;
}

function buildToolRecoveryMessages(
  modelMessages: ModelMessage[],
  result: StreamRunResult,
  assistantContent: string,
  toolEvents: StreamToolEvent[],
): ModelMessage[] {
  if (canUseStructuredToolRecovery(result)) {
    return [
      ...modelMessages,
      ...result.responseMessages,
      { role: "user", content: GENRE_CHAT_TOOL_RECOVERY_PROMPT },
    ];
  }

  const toolTrace = formatToolTrace(toolEvents);
  return [
    ...modelMessages,
    ...(assistantContent.trim()
      ? [{ role: "assistant" as const, content: assistantContent }]
      : []),
    {
      role: "user",
      content: `${GENRE_CHAT_TOOL_RECOVERY_PROMPT}\n\n【ツール実行結果】\n${toolTrace || "（ツール結果なし）"}`,
    },
  ];
}

function toolEventStatus(event: StreamToolEvent): string {
  switch (event.type) {
    case "progress":
      return `（${event.toolName}: ${event.label}）`;
    case "input-start":
      return `（ツール入力を準備中: ${event.toolName}）`;
    case "call":
      return `（ツール実行中: ${event.toolName}）`;
    case "result":
      return `（ツール結果を受信: ${event.toolName}）`;
    case "error":
      return `（ツールでエラー: ${event.toolName}）`;
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

  const settings = await buildChatSettings();
  const entry = getProviderEntry(providerConfig ?? { providers: [] }, settings.provider);
  if (providerRequiresApiKey(entry) && !settings.apiKey) {
    showError(`${entry?.name ?? settings.provider} の API キーを設定してください`);
    return;
  }
  if (typeof settings.model !== "string" || !settings.model.trim()) {
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
    const controller = new AbortController();
    currentAbortController = controller;
    setGeneratingState(true);

    // 最初のトークンが届く前から待機中インジケーターを表示する
    updateStreamingMessage("", "");

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
    let assistantThinking = "";
    const toolEvents: StreamToolEvent[] = [];
    const appendChunk = (chunk: string) => {
      assistantContent += chunk;
      updateStreamingMessage(assistantContent, assistantThinking);
    };
    const handleToolEvent = (event: StreamToolEvent) => {
      toolEvents.push(event);
      if (!assistantContent.trim()) {
        updateStreamingMessage(toolEventStatus(event), assistantThinking);
      }
    };
    const handleReasoning = (chunk: string) => {
      assistantThinking += chunk;
      updateStreamingMessage(assistantContent, assistantThinking);
    };

    let streamResult: StreamRunResult = await streamChat({
      settings,
      messages: modelMessages,
      tools,
      toolChoice: "auto",
      onChunk: appendChunk,
      onReasoning: handleReasoning,
      onToolEvent: handleToolEvent,
      abortSignal: controller.signal,
    });

    if (
      !controller.signal.aborted &&
      streamResult.stoppedAfterToolActivity
    ) {
      const recoveryMessages = buildToolRecoveryMessages(modelMessages, streamResult, assistantContent, toolEvents);
      streamResult = await streamChat({
        settings,
        messages: recoveryMessages,
        onChunk: appendChunk,
        onReasoning: handleReasoning,
        abortSignal: controller.signal,
      });
    }

    let continuationCount = 0;
    while (
      !controller.signal.aborted &&
      streamResult.finishReason === "length" &&
      assistantContent.trim() &&
      continuationCount < GENRE_CHAT_MAX_LENGTH_CONTINUATIONS
    ) {
      continuationCount++;
      const continuationMessages: ModelMessage[] = [
        ...modelMessages,
        { role: "assistant", content: assistantContent },
        { role: "user", content: GENRE_CHAT_LENGTH_CONTINUATION_PROMPT },
      ];
      streamResult = await streamChat({
        settings,
        messages: continuationMessages,
        onChunk: appendChunk,
        onReasoning: handleReasoning,
        abortSignal: controller.signal,
      });
    }

    if (controller.signal.aborted) {
      const abortError = new Error("Aborted");
      abortError.name = "AbortError";
      throw abortError;
    }

    const assistantDocument = await chat.loadGenreChatThread(state.genreId, state.currentThreadId);
    const finalContent = assistantContent.trim()
      ? assistantContent
      : "（ツール実行後に最終応答が返りませんでした。もう一度短く指示してください。）";
    const assistantUpdatedDocument = chat.appendMessage(assistantDocument, {
      id: crypto.randomUUID(),
      threadId: state.currentThreadId,
      role: "assistant",
      content: finalContent,
      thinking: assistantThinking.trim() ? assistantThinking : undefined,
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
    removeEmptyStreamingMessage();
    if (error instanceof Error && error.name === "AbortError") {
      showInfo("生成を中断しました");
    } else {
      showError("メッセージの送信に失敗しました", error);
    }
    renderMessages();
  }
}

function removeEmptyStreamingMessage(): void {
  state.messages = state.messages.filter(
    (message) =>
      message.id !== "streaming" ||
      message.content.trim().length > 0 ||
      (message.thinking ?? "").trim().length > 0,
  );
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

function updateStreamingMessage(content: string, thinking?: string): void {
  const container = document.getElementById("chat-messages");
  if (!container) return;

  const existingIndex = state.messages.findIndex((message) => message.id === "streaming");
  if (existingIndex >= 0) {
    state.messages[existingIndex] = {
      ...state.messages[existingIndex],
      content,
      thinking,
    };
  } else {
    state.messages = [
      ...state.messages,
      {
        id: "streaming",
        threadId: state.currentThreadId ?? "",
        role: "assistant",
        content,
        thinking,
        createdAt: new Date().toISOString(),
      },
    ];
  }

  scheduleStreamingRender();
}

// ストリーミング描画は requestAnimationFrame で 1 フレーム 1 回に集約する。
// チャンクごとに全文 Markdown を再レンダーすると長い返答で UI が固まるため。
// state.messages の更新は同期のままなので、確定処理との整合は保たれる。
let streamingRenderFrame: number | null = null;

function scheduleStreamingRender(): void {
  if (streamingRenderFrame !== null) return;
  streamingRenderFrame = requestAnimationFrame(() => {
    streamingRenderFrame = null;
    const container = document.getElementById("chat-messages");
    if (!container) return;
    const message = state.messages.find((m) => m.id === "streaming");
    if (!message) return; // 既に確定済み（最終描画は renderMessages が担う）
    const bubble = container.querySelector<HTMLElement>('.chat-message[data-message-id="streaming"]');
    if (bubble) {
      renderChatMessageContent(bubble, message.content, message.thinking);
      container.scrollTop = container.scrollHeight;
    } else {
      renderMessages();
    }
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function renderMessages(): void {
  const container = queryChatMessagesContainer();
  if (!container) return;

  renderChatMessageList(container, state.messages, {
    afterRender: (el, message) => {
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
    },
  });
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
