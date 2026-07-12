import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow, getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import {
  applyWindowBounds,
  loadWindowDetached,
  saveWindowDetached,
  trackWindowBounds,
} from "./window/bounds.ts";
import {
  loadSettings,
  saveSettings,
  resetAllSettings,
  type AiSettings,
  type Provider,
  getProviderSpecificSettings,
} from "./settings.ts";
import { saveExaApiKey } from "./websearch-settings.ts";
import { composeStyleSampleText, measureStyleFingerprint } from "./ai/style-fingerprint.ts";
import { applyImport, classifyFilesWithAI, type AiImportCandidate, type ImportContentMode } from "./project/import.ts";
import { state, type ChatTransportMetadata, type ProjectView } from "./state.ts";
import {
  streamChat,
  streamContinuation,
  streamFeedback,
  streamRewrite,
  resolveForcedToolChoice,
  type StreamRunResult,
  type StreamToolEvent,
} from "./ai/service.ts";
import { buildSummaryPrompt, limitPromptText, parseSummaryOutput, samplePromptText } from "./ai/prompts.ts";
import { formatAiErrorMessage } from "./ai/provider-options.ts";
import {
  resolveChatRunSettings as resolveChatRunSettingsWith,
  resolveBackgroundRunSettings as resolveBackgroundRunSettingsWith,
  resolveWritingRunSettings as resolveWritingRunSettingsWith,
  resolveJudgmentRunSettings as resolveJudgmentRunSettingsWith,
} from "./ai/role-settings.ts";
import { updateAdvancedVisibility } from "./ui/settings-modal.ts";
import { pickDefinedOrFallback } from "./settings-merge.ts";
import {
  createCheckConsistencyTool,
  createCreateCharacterTool,
  createCreateProjectMemoTool,
  createCreateWorldEntryTool,
  createEditEpisodeBatchTool,
  createEditEpisodeTool,
  createFindEpisodeLinesTool,
  createGetGenreAnalysisTool,
  createGetGenreKnowledgeItemTool,
  createGetGenreOverviewTool,
  createGetGenreSourceTool,
  createGetEpisodeLinesTool,
  createCreateRelationshipTool,
  createDeleteRelationshipTool,
  createGetEpisodeMemoTool,
  createGetProjectMemoTool,
  createListGenreAnalysesTool,
  createListGenreKnowledgeTool,
  createListGenresTool,
  createListGenreSourcesTool,
  createListCharactersTool,
  createListEpisodeMemosTool,
  createListEpisodesTool,
  createListProjectMemosTool,
  createListRelationshipsTool,
  createListWorldEntriesTool,
  createRebuildSearchIndexTool,
  createRetrieveEpisodeTool,
  createContinuePassageTool,
  createRewritePassageTool,
  createLineEditPassageTool,
  createSaveEpisodeMemoTool,
  createSaveEpisodeOneLinerTool,
  createSaveEpisodeSummaryAndOneLinerTool,
  createSaveEpisodeSummaryTool,
  createSearchGenreSourceTextTool,
  createSearchEpisodesTool,
  createGetEditLogTool,
  createUpdateCharacterTool,
  createUpdateProjectMemoTool,
  createUpdateRelationshipTool,
  createUpdateWorldEntryTool,
  createWebSearchTool,
  createWebFetchTool,
} from "./ai/tools.ts";
import { getElements } from "./ui/layout.ts";
import {
  initEditor,
  setEditorInputCallback,
  flushPendingAutosave,
  getSelection,
  insertAtCursor,
  replaceSelection,
} from "./ui/editor.ts";
import {
  appendMessage,
  clearChat,
  clearChatDisplay,
  removeLastEmptyAssistantMessage,
  renderMessages,
  setChatSyncCallback,
  updateMessageContent,
  updateLastAssistantChunk,
  updateLastAssistantThinking,
} from "./ui/chat.ts";
import {
  bindChatSubmitShortcut,
  populateChatModelOptions,
  populateChatProviderOptions,
} from "./ui/chat-window-common.ts";
import { renderChatMessageHtml } from "./markdown.ts";
import { bindToolbarActions } from "./ui/toolbar.ts";
import {
  bindAdvancedSettingsToggle,
  bindBackgroundProviderChangeAction,
  bindJudgmentModelControls,
  bindModelFetchAction,
  bindProviderChangeAction,
  bindSettingsActions,
  hideSettingsModal,
  populateModelList,
  readExaApiKeyFromModal,
  readWebDavSyncConfigFromModal,
  renderProviderOptions,
  renderSettings,
  showSettingsModal,
} from "./ui/settings-modal.ts";
import {
  loadWebDavSyncConfig,
  pullWebDavAll,
  pushWebDavAll,
  onSyncProgress,
  saveWebDavSyncConfig,
  type SyncProgressPayload,
} from "./sync/webdav.ts";
import {
  bindFolderImportActions,
  bindProjectModalActions,
  bindProjectModalClose,
  clearNewProjectTitle,
  getNewProjectTitle,
  hideImportPreviewModal,
  hideProjectModal,
  renderImportLoading,
  renderImportModeSelection,
  renderImportPreview,
  renderImportResult,
  renderImportResultWithReview,
  showImportPreviewModal,
  renderProjectList,
  showProjectModal,
} from "./ui/project-modal.ts";
import {
  bindProjectNavActions,
  renderEpisodeList,
  renderEpisodeMemo,
  renderEpisodeSummary,
  setActiveNav,
  type ProjectNavActions,
} from "./ui/project-nav.ts";
import {
  renderSettingsEditor,
  type SettingsEditorActions,
} from "./ui/settings-editor.ts";
import { applyStoredRatio, createVerticalResizer } from "./ui/resizable.ts";
import { bindAutoResize } from "./ui/auto-resize.ts";
import { fetchAvailableModels } from "./ai/model-list.ts";
import {
  getProviderEntry,
  getProviderModelDefaults,
  getProviderModelIds,
  loadProviderConfig,
  providerRequiresApiKey,
  type ProviderConfig,
} from "./providers/config.ts";
import { readCodexCredential } from "./providers/codex-auth.ts";
import { readCopilotCredential } from "./providers/copilot-auth.ts";
import {
  createProject,
  deleteProject,
  listProjects,
  loadProject,
  saveProject,
  type Project,
} from "./project/repository.ts";
import type { CharacterRelationshipMap } from "./project/schema.ts";
import {
  createEpisode,
  deleteEpisode,
  loadEpisode,
  loadEpisodeList,
  migrateFromManuscript,
  moveEpisode,
  reorderEpisodes,
  saveEpisode,
  updateEpisodeTitle,
} from "./project/episodes.ts";
import {
  loadRelationships,
  saveRelationships,
  removeCharacterRelationships,
  removeEpisodeRelationships,
} from "./project/relationships.ts";
import {
  createCharacter,
  createWorldEntry,
  deleteCharacter,
  deleteWorldEntry,
  loadCharacters,
  loadWorldEntries,
  updateCharacter,
  updateWorldEntry,
} from "./project/settings.ts";
import { loadChat, saveChat } from "./project/documents.ts";
import { loadSummaries, saveEpisodeSummary, saveEpisodeOneLiner } from "./project/summaries.ts";
import { loadMemos, saveEpisodeMemo } from "./project/memos.ts";
import {
  listProjectMemos,
  createProjectMemo,
  updateProjectMemo,
  deleteProjectMemo,
  type ProjectMemo,
} from "./project/project-memo.ts";
import { renderMemosEditor, type MemosEditorActions } from "./ui/memos-editor.ts";
import type { Character, Episode, EpisodeMemoMap, EpisodeSummaryMap, WorldEntry } from "./project/schema.ts";
import { buildRelatedScenesBlock, findMentionedCharacterNames } from "./project/related-scenes.ts";
import { hasToolCall, type ModelMessage, type ToolSet } from "ai";

let currentSettings: AiSettings;
let providerConfig: ProviderConfig;
let currentProject: Project | null = null;
let episodes: Episode[] = [];
let characters: Character[] = [];
let worldEntries: WorldEntry[] = [];
let relationshipsMap: CharacterRelationshipMap = { groups: [] };
let episodeSummaries: EpisodeSummaryMap = { summaries: {} };
let episodeMemos: EpisodeMemoMap = { memos: {} };
let projectMemos: ProjectMemo[] = [];
let currentMemoId: string | null = null;
let chatMessageInFlight = false;

let pendingImportFiles: File[] = [];
let pendingImportCandidates: AiImportCandidate[] = [];
let pendingImportContentMode: ImportContentMode = "bodyAndSettings";
let resetChatInputHeight: (() => void) | undefined;

const DEFAULT_MAX_CONTEXT_TOKENS = 65536;
const CONTEXT_CHAR_PER_TOKEN = 1.6;
const CONTEXT_OVERHEAD_TOKENS = 2048;
const TOOL_DISPLAY_INPUT_MAX_CHARS = 4000;
const TOOL_DISPLAY_OUTPUT_MAX_CHARS = 12000;
const CHAT_LENGTH_CONTINUATION_PROMPT =
  "前の応答は出力上限で途中で切れています。すでに書いた内容を繰り返さず、直前の文から自然に続きを書いてください。前置き、見出し、注釈は不要です。";
const CHAT_TOOL_CALL_RETRY_LIMIT = 3;
const CHAT_TOOL_RESULT_CONTINUATION_LIMIT = 1;
const CHAT_TOOL_CALL_RETRY_PROMPT =
  "直前の応答は、必要なツール呼び出しに到達しないまま説明文で終わっています。説明、手順、expectedText/replacementText の表示を続けず、直ちに必要なツールを呼び出してください。本文編集では findEpisodeLines または getEpisodeLines で確認し、単一範囲なら editEpisode、明確な複数範囲なら editEpisodeBatch を1回だけ呼び出してください。曖昧または高リスクな編集だけ事前確認し、範囲ごとの逐次確認はしないでください。ユーザーへの文章回答はツール実行後に editSummary または editedLineRanges を使って一度だけ行ってください。";
const CHAT_TOOL_RESULT_CONTINUATION_PROMPT =
  "直前のツール実行は完了しています。追加のツール呼び出しはせず、ツール結果だけを踏まえてユーザーへの最終返答を日本語で簡潔に返してください。ツールが失敗している場合は、失敗内容と必要な次の指示を短く伝えてください。";

interface PromptContextBudgets {
  settingsField: number;
  settingsSection: number;
  projectMemos: number;
  previousSummary: number;
  currentMemo: number;
  summarySource: number;
  continuationContext: number;
  rewriteContextSide: number;
  chatHistoryMessages: number;
  chatMessage: number;
  chatHistory: number;
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getPromptContextBudgets(settings: AiSettings = currentSettings): PromptContextBudgets {
  const maxContextTokens = positiveFinite(settings.maxContextTokens)
    ? Math.floor(settings.maxContextTokens)
    : DEFAULT_MAX_CONTEXT_TOKENS;
  const maxOutputTokens = positiveFinite(settings.maxTokens) ? Math.floor(settings.maxTokens) : 8192;
  const reservedTokens = Math.min(
    Math.max(maxOutputTokens, 1024) + CONTEXT_OVERHEAD_TOKENS,
    Math.floor(maxContextTokens * 0.5),
  );
  const usableTokens = Math.max(2048, maxContextTokens - reservedTokens);
  const usableChars = Math.max(4096, Math.floor(usableTokens * CONTEXT_CHAR_PER_TOKEN));
  const scaled = (ratio: number, min: number, max: number) =>
    Math.floor(clampNumber(usableChars * ratio, min, max));

  return {
    settingsField: scaled(0.015, 800, 24000),
    settingsSection: scaled(0.12, 8000, 240000),
    projectMemos: scaled(0.08, 5000, 160000),
    previousSummary: scaled(0.035, 2200, 70000),
    currentMemo: scaled(0.06, 3500, 120000),
    summarySource: scaled(0.72, 24000, 1200000),
    continuationContext: scaled(0.45, 12000, 800000),
    rewriteContextSide: scaled(0.18, 5000, 360000),
    chatHistoryMessages: Number.MAX_SAFE_INTEGER,
    chatMessage: scaled(0.14, 4000, 280000),
    chatHistory: scaled(0.35, 10000, 700000),
  };
}

// 実行時のモデル設定解決(applyRuntimeModelDefaults / applyRoleProfile / resolve*RunSettings)は
// src/ai/role-settings.ts へ共有化した。ここでは providerConfig(モジュール変数)を渡すだけの
// 薄いラッパーを残し、既存の呼び出し箇所の差分を最小化する。挙動は移設前と同一。
function resolveChatRunSettings(settings: AiSettings): AiSettings {
  return resolveChatRunSettingsWith(providerConfig, settings);
}

function resolveBackgroundRunSettings(settings: AiSettings): AiSettings {
  return resolveBackgroundRunSettingsWith(providerConfig, settings);
}

function resolveWritingRunSettings(settings: AiSettings): AiSettings {
  return resolveWritingRunSettingsWith(providerConfig, settings);
}

function resolveJudgmentRunSettings(settings: AiSettings): AiSettings {
  return resolveJudgmentRunSettingsWith(providerConfig, settings);
}

function getProviderProtocol(settings: AiSettings): string {
  switch (settings.provider) {
    case "sakura":
    case "openai":
    case "llamacpp":
      return "responses";
    case "plamo":
    case "deepseek":
    case "opencode":
      return "chat-completions";
    case "anthropic":
    case "google":
      return settings.provider;
    case "codex":
      return "responses";
    case "github-copilot":
      return "chat-completions";
  }
}

function annotateLastAssistantRun(
  run: StreamRunResult,
  settings: AiSettings,
  kind: ChatTransportMetadata["kind"],
): void {
  for (let i = state.chatMessages.length - 1; i >= 0; i--) {
    const message = state.chatMessages[i];
    if (message.role !== "assistant" || isToolResultLog(message.content)) continue;

    const createdAt = new Date().toISOString();
    message.id ??= `${createdAt}-${i}`;
    message.createdAt ??= createdAt;
    message.transport = {
      provider: settings.provider,
      model: settings.model,
      baseUrl: settings.baseUrl,
      protocol: getProviderProtocol(settings),
      responseId: run.response?.id,
      responseModelId: run.response?.modelId,
      finishReason: run.finishReason,
      maxTokens: settings.maxTokens,
      maxContextTokens: settings.maxContextTokens,
      createdAt,
      kind,
    };
    // Streaming rendering completed before transport metadata was available.
    // Re-render once so the model badge appears in the response card.
    updateMessageContent(i, message.content);
    return;
  }
}

let memoCollapsedBeforeDetach = false;
let chatCollapsedBeforeDetach = false;
let isMainClosing = false;

type ToolLogStatus = "input" | "running" | "success" | "failure" | "interrupted";

interface ToolLogState {
  messageIndex: number;
  toolCallId: string;
  toolName: string;
  status: ToolLogStatus;
  input?: unknown;
  output?: unknown;
  progress?: ToolProgressState;
  progressHistory?: ToolProgressState[];
}

interface ToolProgressState {
  phase: string;
  label: string;
  step?: number;
  totalSteps?: number;
  model?: string;
}

const toolLogStates = new Map<string, ToolLogState>();

function setGenerating(generating: boolean): void {
  state.isGenerating = generating;
  const {
    btnSend,
    btnCancel,
    btnContinue,
    btnRewrite,
    btnFeedback,
    btnSettings,
    chatForm,
    chatInput,
  } = getElements();

  const disabled = generating;
  btnSend.disabled = disabled;
  btnContinue.disabled = disabled;
  btnRewrite.disabled = disabled;
  btnFeedback.disabled = disabled;
  btnSettings.disabled = disabled;
  chatInput.disabled = disabled;
  chatForm.classList.toggle("is-generating", generating);

  if (generating) {
    btnCancel.classList.add("is-active");
    btnCancel.classList.remove("hidden");
    btnCancel.disabled = false;
  } else {
    btnCancel.classList.remove("is-active");
    btnCancel.classList.add("hidden");
    btnCancel.disabled = true;
    state.abortController = null;
  }

  syncChatToWindow();
}

function startGeneration(): AbortController {
  toolLogStates.clear();
  const controller = new AbortController();
  state.abortController = controller;
  setGenerating(true);
  return controller;
}

function stopGeneration(): void {
  state.abortController?.abort();
  markPendingToolLogsInterrupted("ユーザーが停止しました。");
  setGenerating(false);
}

function validateProject(): boolean {
  if (!currentProject) {
    window.alert("プロジェクトを選択または作成してください。");
    showProjectModal();
    return false;
  }
  return true;
}

function validateEpisode(): boolean {
  if (!validateProject()) return false;
  if (!state.currentEpisodeId) {
    window.alert("エピソードを選択してください。");
    return false;
  }
  return true;
}

/** OAuth プロバイダーがログイン済みか確認する */
async function isOAuthLoggedIn(provider: Provider): Promise<boolean> {
  if (provider === "codex") {
    const cred = await readCodexCredential();
    return cred !== undefined;
  }
  if (provider === "github-copilot") {
    const cred = await readCopilotCredential();
    return cred !== undefined;
  }
  return false;
}

function isOAuthProvider(provider: Provider): boolean {
  return provider === "codex" || provider === "github-copilot";
}

async function validateSettings(): Promise<boolean> {
  const entry = getProviderEntry(providerConfig, currentSettings.provider);
  if (isOAuthProvider(currentSettings.provider)) {
    const loggedIn = await isOAuthLoggedIn(currentSettings.provider);
    if (!loggedIn) {
      window.alert("ログインしてください。");
      openSettings();
      return false;
    }
  } else if (providerRequiresApiKey(entry) && !currentSettings.apiKey) {
    window.alert("API キーを設定してください。");
    openSettings();
    return false;
  }
  if (typeof currentSettings.model !== "string" || !currentSettings.model.trim()) {
    window.alert("モデル名を設定してください。");
    openSettings();
    return false;
  }
  return true;
}

async function validateChatSettings(): Promise<boolean> {
  const chatSettings = resolveChatRunSettings(currentSettings);
  const entry = getProviderEntry(providerConfig, chatSettings.provider);
  if (isOAuthProvider(chatSettings.provider)) {
    const loggedIn = await isOAuthLoggedIn(chatSettings.provider);
    if (!loggedIn) {
      window.alert(`${entry?.name ?? chatSettings.provider} にログインしてください。`);
      openSettings();
      return false;
    }
  } else if (providerRequiresApiKey(entry) && !chatSettings.apiKey) {
    window.alert(`${entry?.name ?? chatSettings.provider} の API キーを設定してください。`);
    openSettings();
    return false;
  }
  if (typeof chatSettings.model !== "string" || !chatSettings.model.trim()) {
    window.alert("モデル名を設定してください。");
    openSettings();
    return false;
  }
  return true;
}

function createAiTools(options: {
  includeContinuePassage?: boolean;
  onToolProgress?: (event: Extract<StreamToolEvent, { type: "progress" }>) => void;
} = {}): ToolSet | undefined {
  if (!currentProject) return undefined;

  const searchDeps = { projectId: currentProject.id };
  const summaryDeps = {
    projectId: currentProject.id,
    onSaveSummary: (episodeId: string, content: string) => {
      episodeSummaries.summaries[episodeId] = {
        ...(episodeSummaries.summaries[episodeId] ?? { oneLiner: "" }),
        content,
        updatedAt: new Date().toISOString(),
      };
      if (episodeId === state.currentEpisodeId) {
        renderEpisodeSummary(episodeId, content, handleUpdateSummary, handleGenerateSummary);
      }
      syncSummaryToWindow();
    },
    onSaveOneLiner: (episodeId: string, oneLiner: string) => {
      const existing = episodeSummaries.summaries[episodeId];
      episodeSummaries.summaries[episodeId] = {
        content: existing?.content ?? "",
        oneLiner,
        updatedAt: new Date().toISOString(),
      };
      syncSummaryToWindow();
    },
  };

  const settingsDeps = {
    projectId: currentProject.id,
    onUpdateCharacters: (newCharacters: Character[]) => {
      characters = newCharacters;
      renderSettingsView();
      syncSettingsToWindow();
    },
    onUpdateWorldEntries: (newEntries: WorldEntry[]) => {
      worldEntries = newEntries;
      renderSettingsView();
      syncSettingsToWindow();
    },
  };

  const relationshipDeps = {
    projectId: currentProject.id,
    characters,
    episodes,
    relationshipsMap,
    onUpdateRelationships: (map: CharacterRelationshipMap) => {
      relationshipsMap = map;
      renderSettingsView();
      syncSettingsToWindow();
    },
  };

  const memoDeps = {
    projectId: currentProject.id,
    episodes,
    episodeMemos,
    onUpdateMemos: (memos: EpisodeMemoMap) => {
      episodeMemos = memos;
      if (state.currentEpisodeId) {
        renderEpisodeMemo(
          state.currentEpisodeId,
          episodeMemos.memos[state.currentEpisodeId]?.content,
          handleUpdateMemo,
        );
      }
      syncMemoToWindow();
    },
  };

  const projectMemoDeps = {
    projectId: currentProject.id,
    onUpdateMemos: (memos: ProjectMemo[]) => {
      projectMemos = memos;
      renderMemosView();
      syncProjectMemosToWindow();
    },
  };

  const tools: ToolSet = {
    findEpisodeLines: createFindEpisodeLinesTool(searchDeps),
    getEpisodeLines: createGetEpisodeLinesTool(searchDeps),
    listEpisodes: createListEpisodesTool(searchDeps),
    retrieveEpisode: createRetrieveEpisodeTool(searchDeps),
    searchEpisodes: createSearchEpisodesTool(searchDeps),
    getEditLog: createGetEditLogTool(searchDeps),
    rebuildSearchIndex: createRebuildSearchIndexTool(searchDeps),
    saveEpisodeSummary: createSaveEpisodeSummaryTool(summaryDeps),
    saveEpisodeOneLiner: createSaveEpisodeOneLinerTool(summaryDeps),
    listCharacters: createListCharactersTool(settingsDeps),
    updateCharacter: createUpdateCharacterTool(settingsDeps),
    createCharacter: createCreateCharacterTool(settingsDeps),
    listWorldEntries: createListWorldEntriesTool(settingsDeps),
    updateWorldEntry: createUpdateWorldEntryTool(settingsDeps),
    createWorldEntry: createCreateWorldEntryTool(settingsDeps),
    listRelationships: createListRelationshipsTool(relationshipDeps),
    createRelationship: createCreateRelationshipTool(relationshipDeps),
    updateRelationship: createUpdateRelationshipTool(relationshipDeps),
    deleteRelationship: createDeleteRelationshipTool(relationshipDeps),
    listEpisodeMemos: createListEpisodeMemosTool(memoDeps),
    getEpisodeMemo: createGetEpisodeMemoTool(memoDeps),
    saveEpisodeMemo: createSaveEpisodeMemoTool(memoDeps),
    listProjectMemos: createListProjectMemosTool(projectMemoDeps),
    getProjectMemo: createGetProjectMemoTool(projectMemoDeps),
    updateProjectMemo: createUpdateProjectMemoTool(projectMemoDeps),
    createProjectMemo: createCreateProjectMemoTool(projectMemoDeps),
    webSearch: createWebSearchTool(),
    webFetch: createWebFetchTool(),
    listGenres: createListGenresTool(),
    getGenreOverview: createGetGenreOverviewTool(),
    listGenreKnowledge: createListGenreKnowledgeTool(),
    getGenreKnowledgeItem: createGetGenreKnowledgeItemTool(),
    listGenreSources: createListGenreSourcesTool(),
    getGenreSource: createGetGenreSourceTool(),
    searchGenreSourceText: createSearchGenreSourceTextTool(),
    listGenreAnalyses: createListGenreAnalysesTool(),
    getGenreAnalysis: createGetGenreAnalysisTool(),
    checkConsistency: createCheckConsistencyTool({
      projectId: currentProject.id,
      settings: currentSettings,
      resolveSettings: () => resolveBackgroundRunSettings(currentSettings),
      currentEpisodeId: state.currentEpisodeId ?? undefined,
    }),
    // チャットで「もっと良い表現にできない?」等と頼まれたときに、チャットモデルの
    // 即興ではなく、リライトボタンと同じ執筆系パイプライン(役割解決・足場・語りの型
    // 規則・設定資料)で差し替え案を生成させるためのツール。
    rewritePassage: createRewritePassageTool({
      resolveSettings: () => resolveWritingRunSettings(currentSettings),
      resolveJudgmentSettings: () => resolveJudgmentRunSettings(currentSettings),
      getEditorText: () => getElements().editor.value,
      getSettingsContext: () => buildSettingsContext(state.currentEpisodeId ?? undefined),
      getContextSideBudget: () => getPromptContextBudgets().rewriteContextSide,
    }),
    // チャットで「編集者として直して」「ペン入れして」等と頼まれたときに、
    // チャットモデルの即興ではなく、判断系モデル(編集者)の査読→執筆系モデルの
    // 置換案生成の二段階プロセスで編集提案を生成させるツール。
    lineEditPassage: createLineEditPassageTool({
      resolveJudgmentSettings: () => resolveJudgmentRunSettings(currentSettings),
      resolveWritingSettings: () => resolveWritingRunSettings(currentSettings),
      getEditorText: () => getElements().editor.value,
      getSettingsContext: () => buildSettingsContext(state.currentEpisodeId ?? undefined),
      getContextSideBudget: () => getPromptContextBudgets().rewriteContextSide,
      onProgress: options.onToolProgress,
    }),
  };

  if (options.includeContinuePassage !== false) {
    // チャットからの新規本文生成だけを、続き生成ボタンと同じ執筆パイプラインへ送る。
    // 専用パイプライン自身へこのツールを渡すと自己呼び出しになるため、呼び出し側で除外する。
    tools.continuePassage = createContinuePassageTool({
      resolveWritingSettings: () => resolveWritingRunSettings(currentSettings),
      resolveJudgmentSettings: () => resolveJudgmentRunSettings(currentSettings),
      prepareContext: async () => {
        const text = getElements().editor.value;
        const { start } = getSelection();
        const context = buildContinuationContext(text, start);
        const relatedScenes = await buildContinuationRelatedScenes(context);
        return {
          context,
          settingsContext: buildSettingsContext(state.currentEpisodeId ?? undefined),
          relatedScenes,
          styleFingerprint: measureStyleFingerprint(
            composeStyleSampleText(text, await findPreviousEpisodeContent()),
          ),
          episodeId: state.currentEpisodeId ?? undefined,
          characterVoiceInput: {
            names: findMentionedCharacterNames(characters, context),
            excerpts: relatedScenes ?? "",
          },
        };
      },
    });
  }

  if (state.currentEpisodeId) {
    tools.editEpisode = createEditEpisodeTool({
      projectId: currentProject.id,
      episodeId: state.currentEpisodeId,
      onApply: (newText, targetEpisodeId) => {
        if (state.currentEpisodeId !== targetEpisodeId) return;
        const { editor } = getElements();
        editor.value = newText;
        state.editorText = newText;
      },
    });
    tools.editEpisodeBatch = createEditEpisodeBatchTool({
      projectId: currentProject.id,
      episodeId: state.currentEpisodeId,
      onApply: (newText, targetEpisodeId) => {
        if (state.currentEpisodeId !== targetEpisodeId) return;
        const { editor } = getElements();
        editor.value = newText;
        state.editorText = newText;
      },
    });
  }

  return tools;
}

function displayJsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return String(value);
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (typeof value === "undefined") return "undefined";
  return value;
}

function stringifyForDisplay(value: unknown, maxChars: number): string {
  let text: string;
  try {
    const json = JSON.stringify(value, displayJsonReplacer, 2);
    text = typeof json === "string" ? json : String(value);
  } catch {
    text = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  }
  return limitPromptText(text, maxChars, "head");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFailureToolOutput(output: unknown): boolean {
  if (!isRecord(output)) return false;
  if ("error" in output && output.error != null) return true;
  return output.success === false;
}

function isToolResultLog(content: string): boolean {
  return content.startsWith("【ツール");
}

function modelMessageContentToString(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  return JSON.stringify(content);
}

function getLastUserMessageText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user") return modelMessageContentToString(message.content);
  }
  return "";
}

function getLastAssistantPlainText(): string {
  for (let i = state.chatMessages.length - 1; i >= 0; i--) {
    const message = state.chatMessages[i];
    if (message.role !== "assistant") continue;
    if (isToolResultLog(message.content)) continue;
    return message.content;
  }
  return "";
}

function textLooksLikeToolRequired(text: string): boolean {
  return /editEpisode|editEpisodeBatch|findEpisodeLines|getEpisodeLines|expectedText|replacementText|startLine|endLine|行番号|本文を確認|現在の本文|現状の本文|変更\d|変更[0-9a-zA-Zぁ-んァ-ヶ一-龠]*|複数箇所|一括編集|置き換え|置換|差し替え|挿入|削除|反映|編集を実行|ツール.?コール|ツール.?呼び出し|保存して|要約を保存|一行要約/.test(text);
}

function shouldRetryMissingToolCall(messages: ModelMessage[], run: StreamRunResult): boolean {
  if (controllerWasAborted()) return false;
  if (run.toolCallCount > 0 || run.toolResultCount > 0 || run.toolErrorCount > 0) return false;

  const lastUserText = getLastUserMessageText(messages);
  const lastAssistantText = getLastAssistantPlainText();
  return textLooksLikeToolRequired(`${lastUserText}\n${lastAssistantText}`);
}

function shouldContinueAfterToolResult(run: StreamRunResult): boolean {
  if (controllerWasAborted()) return false;
  if (!run.stoppedAfterToolResult) return false;
  if (run.pendingToolCallIds.length > 0) return false;
  return run.responseMessages.length > 0;
}

function buildToolResultContinuationMessages(messages: ModelMessage[], run: StreamRunResult): ModelMessage[] {
  return [
    ...messages,
    ...run.responseMessages,
    { role: "user", content: CHAT_TOOL_RESULT_CONTINUATION_PROMPT },
  ];
}

function controllerWasAborted(): boolean {
  return state.abortController?.signal.aborted === true;
}

function markLastAssistantToolCallMissed(reason: string): string {
  for (let i = state.chatMessages.length - 1; i >= 0; i--) {
    const message = state.chatMessages[i];
    if (message.role !== "assistant") continue;
    if (isToolResultLog(message.content)) continue;

    const original = message.content;
    const replacement =
      `【ツール未到達: 再試行】\n` +
      `状態: ${reason}\n` +
      `説明文だけが生成され、実際のツール呼び出しが返りませんでした。ツール呼び出しを優先して再試行します。`;
    updateMessageContent(i, replacement);
    return original;
  }
  return "";
}

function appendMissingToolFallback(): void {
  appendMessage(
    "assistant",
    "（必要なツール呼び出しに到達できませんでした。説明文の生成を止めて再試行しましたが、モデルが tool-call を返しませんでした。）",
  );
}

function toolStatusLabel(status: ToolLogStatus): string {
  switch (status) {
    case "input":
      return "入力生成中";
    case "running":
      return "実行中";
    case "success":
      return "成功";
    case "failure":
      return "失敗";
    case "interrupted":
      return "中断";
  }
}

function formatToolLog(state: ToolLogState): string {
  const label = toolStatusLabel(state.status);
  let text = `【ツール${label}: ${state.toolName}】\n`;
  text += `状態: ${label}\n`;
  text += `ID: ${state.toolCallId}\n`;

  if (state.progress) {
    text += `進捗: ${JSON.stringify({ current: state.progress, history: state.progressHistory ?? [] })}\n`;
  }

  if (state.input !== undefined) {
    text += `入力: ${stringifyForDisplay(state.input, TOOL_DISPLAY_INPUT_MAX_CHARS)}\n`;
  } else {
    text += "入力: （モデルがツール引数を生成中です）\n";
  }

  if (state.output !== undefined) {
    text += `結果:\n${stringifyForDisplay(state.output, TOOL_DISPLAY_OUTPUT_MAX_CHARS)}`;
  } else if (state.status === "input") {
    text += "結果: （未実行）";
  } else if (state.status === "running") {
    text += "結果: （実行中）";
  } else if (state.status === "interrupted") {
    text += "結果: （完了前に中断されました）";
  }

  return text;
}

function upsertToolLog(next: Omit<ToolLogState, "messageIndex">, settings?: AiSettings): void {
  const existing = toolLogStates.get(next.toolCallId);
  if (existing) {
    const updated: ToolLogState = { ...existing, ...next };
    toolLogStates.set(next.toolCallId, updated);
    if (!updateMessageContent(existing.messageIndex, formatToolLog(updated))) {
      toolLogStates.delete(next.toolCallId);
      upsertToolLog(next, settings);
    }
    return;
  }

  removeLastEmptyAssistantMessage();
  const messageIndex = state.chatMessages.length;
  const created: ToolLogState = { ...next, messageIndex };
  appendMessage("assistant", formatToolLog(created));
  const message = state.chatMessages[messageIndex];
  if (message && settings) {
    const createdAt = new Date().toISOString();
    message.transport = {
      provider: settings.provider,
      model: settings.model,
      baseUrl: settings.baseUrl,
      protocol: getProviderProtocol(settings),
      createdAt,
      kind: "chat",
    };
    updateMessageContent(messageIndex, message.content);
  }
  toolLogStates.set(next.toolCallId, created);
}

function handleToolEvent(event: StreamToolEvent, settings: AiSettings): void {
  switch (event.type) {
    case "progress": {
      const existing = toolLogStates.get(event.toolCallId);
      const progress: ToolProgressState = {
        phase: event.phase,
        label: event.label,
        step: event.step,
        totalSteps: event.totalSteps,
        model: event.model,
      };
      const history = [...(existing?.progressHistory ?? [])];
      const previousIndex = history.findIndex((item) => item.phase === progress.phase);
      if (previousIndex >= 0) history[previousIndex] = progress;
      else history.push(progress);
      upsertToolLog({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: "running",
        input: existing?.input,
        progress,
        progressHistory: history,
      }, settings);
      break;
    }
    case "input-start":
      upsertToolLog({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: "input",
      }, settings);
      break;
    case "call":
      upsertToolLog({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: "running",
        input: event.input,
      }, settings);
      break;
    case "result":
      upsertToolLog({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: isFailureToolOutput(event.output) ? "failure" : "success",
        input: event.input,
        output: event.output,
      }, settings);
      break;
    case "error":
      upsertToolLog({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: "failure",
        input: event.input,
        output: { error: event.error },
      }, settings);
      break;
  }
}

function markPendingToolLogsInterrupted(message: string): void {
  for (const [toolCallId, state] of toolLogStates) {
    if (state.status === "success" || state.status === "failure" || state.status === "interrupted") continue;
    upsertToolLog({
      ...state,
      toolCallId,
      status: "interrupted",
      output: { interrupted: true, message },
    });
  }
}

function finalizeToolRun(run: StreamRunResult): void {
  if (run.pendingToolCallIds.length === 0) return;

  for (const toolCallId of run.pendingToolCallIds) {
    const state = toolLogStates.get(toolCallId);
    if (!state || state.status === "success" || state.status === "failure") continue;
    upsertToolLog({
      ...state,
      toolCallId,
      status: "interrupted",
      output: { interrupted: true, message: "ツール結果が返る前にストリームが終了しました。" },
    });
  }
}

function appendAssistantChunk(chunk: string): void {
  const lastMessage = state.chatMessages[state.chatMessages.length - 1];
  if (!lastMessage || lastMessage.role !== "assistant" || isToolResultLog(lastMessage.content)) {
    appendMessage("assistant", "");
  }
  updateLastAssistantChunk(chunk);
}

function appendAssistantThinking(chunk: string): void {
  const lastMessage = state.chatMessages[state.chatMessages.length - 1];
  if (!lastMessage || lastMessage.role !== "assistant" || isToolResultLog(lastMessage.content)) {
    appendMessage("assistant", "");
  }
  updateLastAssistantThinking(chunk);
}

function appendToolInterruptedFallback(): void {
  const lastMessage = state.chatMessages[state.chatMessages.length - 1];
  if (lastMessage?.role === "assistant" && !isToolResultLog(lastMessage.content) && lastMessage.content.trim()) {
    return;
  }

  appendMessage(
    "assistant",
    "（ツール実行後にモデルの最終応答が返りませんでした。必要なら続けて指示してください。）",
  );
}

async function streamChatOnce(
  messages: ModelMessage[],
  controller: AbortController,
  allowTools: boolean,
  settings: AiSettings,
) {
  return await streamChat({
    settings,
    messages,
    settingsContext: buildSettingsContext(state.currentEpisodeId ?? undefined, settings),
    tools: allowTools
      ? createAiTools({ onToolProgress: (event) => handleToolEvent(event, settings) })
      : undefined,
    onChunk: (chunk) => {
      appendAssistantChunk(chunk);
    },
    onReasoning: (chunk) => {
      appendAssistantThinking(chunk);
    },
    onToolEvent: allowTools ? (event) => handleToolEvent(event, settings) : undefined,
    abortSignal: controller.signal,
  });
}

async function streamChatWithAutoContinuation(
  initialMessages: ModelMessage[],
  controller: AbortController,
  settings: AiSettings,
) {
  let messages = initialMessages;
  let toolCallRetryCount = 0;
  let toolResultContinuationCount = 0;
  let run = await streamChatOnce(messages, controller, true, settings);
  finalizeToolRun(run);

  while (!controller.signal.aborted) {
    if (shouldRetryMissingToolCall(messages, run)) {
      if (toolCallRetryCount >= CHAT_TOOL_CALL_RETRY_LIMIT) {
        appendMissingToolFallback();
        break;
      }

      toolCallRetryCount++;
      console.warn("[litra] model did not emit a tool call; retrying with tool-call directive", {
        retry: toolCallRetryCount,
      });
      const missedText = markLastAssistantToolCallMissed(
        `ツール未実行のため再試行 ${toolCallRetryCount}/${CHAT_TOOL_CALL_RETRY_LIMIT}`,
      );
      messages = [
        ...buildChatMessagesForModel(settings),
        {
          role: "user",
          content: `${CHAT_TOOL_CALL_RETRY_PROMPT}\n\n【直前に生成された未実行の説明文】\n${limitPromptText(missedText, 4000, "head")}`,
        },
      ];
      run = await streamChatOnce(messages, controller, true, settings);
      finalizeToolRun(run);
      continue;
    }

    if (shouldContinueAfterToolResult(run)) {
      if (toolResultContinuationCount >= CHAT_TOOL_RESULT_CONTINUATION_LIMIT) {
        console.warn("[litra] tool result continuation limit reached");
        break;
      }

      toolResultContinuationCount++;
      console.warn("[litra] model stopped after tool result; requesting final response", {
        retry: toolResultContinuationCount,
      });
      messages = buildToolResultContinuationMessages(messages, run);
      run = await streamChatOnce(messages, controller, false, settings);
      finalizeToolRun(run);
      continue;
    }

    if (run.finishReason !== "length" || run.textCharCount <= 0) {
      break;
    }

    console.warn("[litra] chat output hit maxOutputTokens; auto-continuing");
    messages = [
      ...buildChatMessagesForModel(settings),
      { role: "user", content: CHAT_LENGTH_CONTINUATION_PROMPT },
    ];
    run = await streamChatOnce(messages, controller, false, settings);
    finalizeToolRun(run);
  }

  return run;
}

function buildChatMessagesForModel(settings: AiSettings = currentSettings): ModelMessage[] {
  const budgets = getPromptContextBudgets(settings);
  const naturalMessages = state.chatMessages.filter(
    (message) =>
      message.content.trim().length > 0 &&
      !message.excludeFromContext &&
      !isToolResultLog(message.content),
  );

  const selected: typeof naturalMessages = [];
  let totalChars = 0;

  for (let i = naturalMessages.length - 1; i >= 0; i--) {
    const message = naturalMessages[i];
    const content = limitPromptText(message.content, budgets.chatMessage, "middle");
    const nextTotal = totalChars + content.length;

    if (selected.length >= budgets.chatHistoryMessages || (selected.length > 0 && nextTotal > budgets.chatHistory)) {
      break;
    }

    selected.unshift({ ...message, content });
    totalChars = nextTotal;
  }

  return selected.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

function buildContinuationContext(text: string, start: number): string {
  return limitPromptText(text.slice(0, start), getPromptContextBudgets().continuationContext, "tail");
}

function buildRewriteContext(editorText: string, start: number, end: number): string {
  const budgets = getPromptContextBudgets();
  const before = limitPromptText(editorText.slice(0, start), budgets.rewriteContextSide, "tail");
  const after = limitPromptText(editorText.slice(end), budgets.rewriteContextSide, "head");
  return `${before}\n[選択部分]\n${after}`;
}

function applyPanelVisibility(): void {
  const {
    summarySection,
    memoSection,
    btnToggleMemo,
    settingsSection,
    memosSection,
    chatPanel,
    btnToggleChat,
  } = getElements();
  summarySection.classList.toggle("detached", state.summaryDetached);
  memoSection.classList.toggle("detached", state.memoDetached);
  settingsSection.classList.toggle("detached", state.settingsDetached);
  memosSection.classList.toggle("detached", state.memosDetached);
  chatPanel.classList.toggle("detached", state.chatDetached);
  memoSection.classList.toggle("collapsed", state.memoCollapsed);
  btnToggleMemo.textContent = state.memoCollapsed ? "＋" : "−";
  btnToggleMemo.setAttribute("aria-expanded", String(!state.memoCollapsed));
  chatPanel.classList.toggle("collapsed", state.chatCollapsed);
  btnToggleChat.textContent = state.chatCollapsed ? "＋" : "−";
  btnToggleChat.setAttribute("aria-expanded", String(!state.chatCollapsed));
}

function toggleMemo(): void {
  state.memoCollapsed = !state.memoCollapsed;
  applyPanelVisibility();
}

function toggleChat(): void {
  state.chatCollapsed = !state.chatCollapsed;
  applyPanelVisibility();
}

function syncMemoToWindow(): void {
  const episodeId = state.currentEpisodeId;
  emit("memo-sync", {
    episodeId,
    content: episodeId ? episodeMemos.memos[episodeId]?.content ?? "" : "",
  });
}

function syncChatToWindow(): void {
  emit("chat-sync", { messages: state.chatMessages, isGenerating: state.isGenerating });
}

function syncSummaryToWindow(): void {
  const episodeId = state.currentEpisodeId;
  emit("summary-sync", {
    episodeId,
    content: episodeId ? episodeSummaries.summaries[episodeId]?.content ?? "" : "",
  });
}

function syncSettingsToWindow(): void {
  emit("settings-sync", {
    view: state.currentView === "episode" ? "characters" : state.currentView,
    characters,
    worldEntries,
    episodes,
    relationshipsMap,
    currentCharacterId: state.currentCharacterId,
    currentWorldEntryId: state.currentWorldEntryId,
  });
}

type ManagedWindowOptions = ConstructorParameters<typeof WebviewWindow>[1];

async function openManagedWindow(
  label: string,
  options: ManagedWindowOptions,
  lifecycle: {
    beforeCreate?: () => void;
    onCreated?: () => void;
    onDestroyed?: () => void;
    syncDelayMs?: number;
  } = {},
): Promise<void> {
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus();
    return;
  }

  lifecycle.beforeCreate?.();

  const webview = new WebviewWindow(label, options);

  webview.once("tauri://created", () => {
    if (lifecycle.onCreated) {
      setTimeout(lifecycle.onCreated, lifecycle.syncDelayMs ?? 500);
    }
    void applyWindowBounds(webview, label);
    trackWindowBounds(webview, label);
  });

  webview.once("tauri://destroyed", () => {
    if (!isMainClosing) {
      lifecycle.onDestroyed?.();
    }
  });
}

async function openMemoWindow(): Promise<void> {
  await openManagedWindow(
    "memo",
    {
      url: "memo-window.html",
      title: "覚え書き - LITRA",
      width: 420,
      height: 640,
      minWidth: 280,
      minHeight: 320,
      dragDropEnabled: false,
    },
    {
      beforeCreate: () => {
        memoCollapsedBeforeDetach = state.memoCollapsed;
        state.memoDetached = true;
        applyPanelVisibility();
        void saveWindowDetached("memo", true);
      },
      onCreated: syncMemoToWindow,
      onDestroyed: () => {
        state.memoDetached = false;
        state.memoCollapsed = memoCollapsedBeforeDetach;
        applyPanelVisibility();
        void saveWindowDetached("memo", false);
      },
    },
  );
}

async function openChatWindow(): Promise<void> {
  await openManagedWindow(
    "chat",
    {
      url: "chat-window.html",
      title: "リトラチャット - LITRA",
      width: 480,
      height: 640,
      minWidth: 200,
      minHeight: 320,
      dragDropEnabled: false,
    },
    {
      beforeCreate: () => {
        chatCollapsedBeforeDetach = state.chatCollapsed;
        state.chatDetached = true;
        applyPanelVisibility();
        void saveWindowDetached("chat", true);
      },
      onCreated: () => {
        syncChatToWindow();
        syncChatSettingsToWindow();
      },
      onDestroyed: () => {
        state.chatDetached = false;
        state.chatCollapsed = chatCollapsedBeforeDetach;
        applyPanelVisibility();
        void saveWindowDetached("chat", false);
      },
    },
  );
}

async function openSummaryWindow(): Promise<void> {
  await openManagedWindow(
    "summary",
    {
      url: "summary-window.html",
      title: "エピソード要約 - LITRA",
      width: 420,
      height: 640,
      minWidth: 280,
      minHeight: 320,
      dragDropEnabled: false,
    },
    {
      beforeCreate: () => {
        state.summaryDetached = true;
        applyPanelVisibility();
        void saveWindowDetached("summary", true);
      },
      onCreated: syncSummaryToWindow,
      onDestroyed: () => {
        state.summaryDetached = false;
        applyPanelVisibility();
        void saveWindowDetached("summary", false);
      },
    },
  );
}

async function openSettingsWindow(): Promise<void> {
  await openManagedWindow(
    "settings",
    {
      url: "settings-window.html",
      title: "設定 - LITRA",
      width: 640,
      height: 700,
      minWidth: 420,
      minHeight: 420,
      dragDropEnabled: false,
    },
    {
      beforeCreate: () => {
        state.settingsDetached = true;
        applyPanelVisibility();
        void saveWindowDetached("settings", true);

        if (state.currentView === "episode") {
          state.currentView = "characters";
        }
        setView(state.currentView);
        renderSettingsView();
        syncSettingsToWindow();
      },
      onCreated: syncSettingsToWindow,
      onDestroyed: () => {
        state.settingsDetached = false;
        applyPanelVisibility();
        setView(state.currentView);
        renderSettingsView();
        void saveWindowDetached("settings", false);
      },
    },
  );
}

function syncProjectMemosToWindow(): void {
  emit("project-memos-sync", { memos: projectMemos, currentMemoId });
}

async function openProjectMemosWindow(): Promise<void> {
  await openManagedWindow(
    "projectMemos",
    {
      url: "project-memo-window.html",
      title: "メモ - LITRA",
      width: 480,
      height: 640,
      minWidth: 280,
      minHeight: 320,
      dragDropEnabled: false,
    },
    {
      beforeCreate: () => {
        state.memosDetached = true;
        applyPanelVisibility();
        renderMemosView();
        void saveWindowDetached("projectMemos", true);
      },
      onCreated: syncProjectMemosToWindow,
      onDestroyed: () => {
        state.memosDetached = false;
        applyPanelVisibility();
        renderMemosView();
        void saveWindowDetached("projectMemos", false);
      },
    },
  );
}

async function openGenreLibraryWindow(): Promise<void> {
  await openManagedWindow("genre-library", {
    url: "genre-library.html",
    title: "ジャンルライブラリ - LITRA",
    width: 960,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    resizable: true,
    maximizable: true,
    minimizable: true,
    closable: true,
    decorations: true,
    dragDropEnabled: false,
  });
}

async function restoreDetachedWindows(): Promise<void> {
  const labels = ["memo", "chat", "summary", "settings", "projectMemos"] as const;
  for (const label of labels) {
    try {
      const detached = await loadWindowDetached(label);
      if (!detached) continue;

      if (label === "memo") {
        await openMemoWindow();
      } else if (label === "chat") {
        await openChatWindow();
      } else if (label === "summary") {
        await openSummaryWindow();
      } else if (label === "settings") {
        await openSettingsWindow();
      } else if (label === "projectMemos") {
        await openProjectMemosWindow();
      }
    } catch (error) {
      console.error(`[litra] failed to restore ${label} window:`, error);
    }
  }
}

function updateToolbarTitle(title: string): void {
  getElements().toolbarProjectName.textContent = title || "プロジェクト未選択";
}

function setEditorEnabled(enabled: boolean): void {
  const { editor } = getElements();
  editor.disabled = !enabled;
  editor.placeholder = enabled
    ? "ここから小説を書き始めましょう..."
    : "プロジェクトを選択してください...";
}

function setView(view: ProjectView): void {
  state.currentView = view;
  const { editorSection, settingsPanel, memosPanel } = getElements();

  if (view === "episode") {
    editorSection.classList.remove("hidden");
    settingsPanel.classList.add("hidden");
    memosPanel.classList.add("hidden");
  } else if (view === "memos") {
    editorSection.classList.add("hidden");
    settingsPanel.classList.add("hidden");
    memosPanel.classList.remove("hidden");
  } else if (state.settingsDetached) {
    editorSection.classList.remove("hidden");
    settingsPanel.classList.add("hidden");
    memosPanel.classList.add("hidden");
  } else {
    editorSection.classList.add("hidden");
    settingsPanel.classList.remove("hidden");
    memosPanel.classList.add("hidden");
  }

  setActiveNav(view);
}

function renderProjectNavigation(): void {
  renderEpisodeList(episodes, state.currentEpisodeId, {
    onSelectEpisode: (id) => void selectEpisode(id),
    onDeleteEpisode: (id) => void handleDeleteEpisode(id),
    onUpdateEpisodeTitle: (id, title) => void handleUpdateEpisodeTitle(id, title),
    onMoveEpisode: (id, direction) => void handleMoveEpisode(id, direction),
    onReorderEpisodes: (orderedIds) => void handleReorderEpisodes(orderedIds),
  });
  setActiveNav(state.currentView);
}

function renderSettingsView(): void {
  if (state.currentView === "episode" || state.currentView === "memos") return;
  renderSettingsEditor(
    state.currentView,
    characters,
    worldEntries,
    episodes,
    relationshipsMap,
    state.currentCharacterId,
    state.currentWorldEntryId,
    settingsActions,
  );
}

const memosActions: MemosEditorActions = {
  onCreate: (title) => void handleCreateProjectMemo(title),
  onUpdate: (id, updates) => void handleUpdateProjectMemo(id, updates),
  onDelete: (id) => void handleDeleteProjectMemo(id),
  onSelect: (id) => void handleSelectProjectMemo(id),
};

function renderMemosView(): void {
  if (state.currentView !== "memos") return;
  const panel = getElements().memosPanel;
  if (state.memosDetached) {
    panel.innerHTML = `<div class="memos-detached-notice">メモは別ウィンドウで開いています</div>`;
    return;
  }
  renderMemosEditor(projectMemos, currentMemoId, memosActions, panel);
}

async function saveCurrentEpisode(): Promise<void> {
  if (!currentProject || !state.currentEpisodeId) return;
  const text = getElements().editor.value;
  const episode = episodes.find((ep) => ep.id === state.currentEpisodeId);
  if (!episode) return;

  await saveEpisode(currentProject.id, episode.fileName, text);
  currentProject.updatedAt = new Date().toISOString();
  await saveProject(currentProject);
}

async function autosaveEpisode(text: string): Promise<void> {
  if (!currentProject || !state.currentEpisodeId) return;
  const episode = episodes.find((ep) => ep.id === state.currentEpisodeId);
  if (!episode) return;

  await saveEpisode(currentProject.id, episode.fileName, text);
  currentProject.updatedAt = new Date().toISOString();
  await saveProject(currentProject);
}

async function saveCurrentSummary(): Promise<void> {
  if (!currentProject || !state.currentEpisodeId) return;
  const text = getElements().episodeSummary.value;
  await saveEpisodeSummary(currentProject.id, state.currentEpisodeId, text);
  const existing = episodeSummaries.summaries[state.currentEpisodeId];
  episodeSummaries.summaries[state.currentEpisodeId] = {
    content: text,
    oneLiner: existing?.oneLiner ?? "",
    updatedAt: new Date().toISOString(),
  };
  syncSummaryToWindow();
}

async function handleUpdateSummary(episodeId: string, text: string): Promise<void> {
  if (!currentProject) return;
  await saveEpisodeSummary(currentProject.id, episodeId, text);
  const existing = episodeSummaries.summaries[episodeId];
  episodeSummaries.summaries[episodeId] = {
    content: text,
    oneLiner: existing?.oneLiner ?? "",
    updatedAt: new Date().toISOString(),
  };
  syncSummaryToWindow();
}

async function saveCurrentMemo(): Promise<void> {
  if (!currentProject || !state.currentEpisodeId) return;
  const text = getElements().episodeMemo.value;
  await saveEpisodeMemo(currentProject.id, state.currentEpisodeId, text);
  episodeMemos.memos[state.currentEpisodeId] = {
    content: text,
    updatedAt: new Date().toISOString(),
  };
  syncMemoToWindow();
}

async function handleUpdateMemo(episodeId: string, text: string): Promise<void> {
  if (!currentProject) return;
  await saveEpisodeMemo(currentProject.id, episodeId, text);
  episodeMemos.memos[episodeId] = {
    content: text,
    updatedAt: new Date().toISOString(),
  };
  syncMemoToWindow();
}

async function selectEpisode(
  episodeId: string,
  options: { saveCurrent?: boolean } = {},
): Promise<void> {
  if (!currentProject) return;
  if (options.saveCurrent !== false) {
    await saveCurrentEpisode();
    await saveCurrentSummary();
    await saveCurrentMemo();
  }

  const episode = episodes.find((ep) => ep.id === episodeId);
  if (!episode) return;

  const text = await loadEpisode(currentProject.id, episode.fileName);
  const { editor } = getElements();
  editor.value = text;
  state.editorText = text;
  state.selectionStart = 0;
  state.selectionEnd = 0;

  state.currentEpisodeId = episode.id;
  state.currentView = "episode";
  setView("episode");
  renderProjectNavigation();
  renderEpisodeSummary(
    episode.id,
    episodeSummaries.summaries[episode.id]?.content,
    handleUpdateSummary,
    handleGenerateSummary,
  );
  renderEpisodeMemo(episode.id, episodeMemos.memos[episode.id]?.content, handleUpdateMemo);
  syncMemoToWindow();
  syncSummaryToWindow();
}

async function ensureEpisodeExists(): Promise<void> {
  if (!currentProject) return;
  if (episodes.length === 0) {
    const episode = await createEpisode(currentProject.id, "第1話");
    episodes.push(episode);
  }
  if (
    !state.currentEpisodeId ||
    !episodes.some((episode) => episode.id === state.currentEpisodeId)
  ) {
    state.currentEpisodeId = episodes[0]?.id ?? null;
  }
}

async function handleNewEpisode(): Promise<void> {
  if (!currentProject) return;
  const title = window.prompt("エピソードタイトルを入力してください") || "新しいエピソード";
  const episode = await createEpisode(currentProject.id, title);
  episodes = (await loadEpisodeList(currentProject.id)).episodes;
  await selectEpisode(episode.id);
}

async function handleDeleteEpisode(episodeId: string): Promise<void> {
  if (!currentProject) return;
  await deleteEpisode(currentProject.id, episodeId);
  episodes = (await loadEpisodeList(currentProject.id)).episodes;
  removeEpisodeRelationships(relationshipsMap, episodeId);
  await saveRelationships(currentProject.id, relationshipsMap);

  if (state.currentEpisodeId === episodeId) {
    state.currentEpisodeId = episodes.length > 0 ? episodes[0].id : null;
    if (state.currentEpisodeId) {
      await selectEpisode(state.currentEpisodeId, { saveCurrent: false });
    } else {
      getElements().editor.value = "";
      state.editorText = "";
      await handleNewEpisode();
    }
  }

  renderProjectNavigation();
}

async function handleUpdateEpisodeTitle(episodeId: string, title: string): Promise<void> {
  if (!currentProject) return;
  await updateEpisodeTitle(currentProject.id, episodeId, title);
  episodes = (await loadEpisodeList(currentProject.id)).episodes;
  renderProjectNavigation();
}

async function handleMoveEpisode(episodeId: string, direction: "up" | "down"): Promise<void> {
  if (!currentProject) return;
  await saveCurrentEpisode();
  await moveEpisode(currentProject.id, episodeId, direction);
  episodes = (await loadEpisodeList(currentProject.id)).episodes;

  const current = episodes.find((ep) => ep.id === state.currentEpisodeId);
  if (current) {
    await selectEpisode(current.id, { saveCurrent: false });
  }

  renderProjectNavigation();
}

async function handleReorderEpisodes(orderedIds: string[]): Promise<void> {
  if (!currentProject) return;
  await saveCurrentEpisode();
  await reorderEpisodes(currentProject.id, orderedIds);
  episodes = (await loadEpisodeList(currentProject.id)).episodes;

  const current = episodes.find((ep) => ep.id === state.currentEpisodeId);
  if (current) {
    await selectEpisode(current.id, { saveCurrent: false });
  }

  renderProjectNavigation();
}

async function handleGenerateSummary(episodeId: string): Promise<void> {
  if (!currentProject || !(await validateSettings())) return;

  const episode = episodes.find((ep) => ep.id === episodeId);
  if (!episode) return;

  await saveCurrentEpisode();

  const text = await loadEpisode(currentProject.id, episode.fileName);
  const budgets = getPromptContextBudgets();
  const sourceText = samplePromptText(text, budgets.summarySource, 4);
  const prompt = buildSummaryPrompt(
    episode.id,
    episode.title || "無題",
    sourceText,
  );

  appendMessage(
    "user",
    `「${episode.title || "無題"}」の要約と一行要約を作成してください。`,
    true,
  );

  const summaryToolDeps = {
    projectId: currentProject.id,
    onSaveSummary: (savedEpisodeId: string, content: string) => {
      episodeSummaries.summaries[savedEpisodeId] = {
        ...(episodeSummaries.summaries[savedEpisodeId] ?? { oneLiner: "" }),
        content,
        updatedAt: new Date().toISOString(),
      };
      if (savedEpisodeId === state.currentEpisodeId) {
        renderEpisodeSummary(savedEpisodeId, content, handleUpdateSummary, handleGenerateSummary);
      }
      syncSummaryToWindow();
    },
    onSaveOneLiner: (savedEpisodeId: string, oneLiner: string) => {
      const existing = episodeSummaries.summaries[savedEpisodeId];
      episodeSummaries.summaries[savedEpisodeId] = {
        content: existing?.content ?? "",
        oneLiner,
        updatedAt: new Date().toISOString(),
      };
      syncSummaryToWindow();
    },
  };

  const summaryTools: ToolSet = {
    saveEpisodeSummaryAndOneLiner: createSaveEpisodeSummaryAndOneLinerTool(summaryToolDeps),
  };

  const controller = startGeneration();
  try {
    const messages: ModelMessage[] = [{ role: "user", content: prompt }];

    const resolvedRunSettings = resolveBackgroundRunSettings(currentSettings);
    // プロバイダ判定は解決後の設定で行う(バックグラウンドでは opencode になる場合がある)。
    // thinking と tool_choice の両立可否はプロバイダ毎に異なるため一元化したヘルパーで解決する。
    const run = await streamChat({
      settings: resolvedRunSettings,
      messages,
      tools: summaryTools,
      toolChoice: resolveForcedToolChoice(resolvedRunSettings),
      stopWhen: hasToolCall("saveEpisodeSummaryAndOneLiner"),
      onChunk: (chunk) => {
        appendAssistantChunk(chunk);
      },
      onReasoning: (chunk) => {
        appendAssistantThinking(chunk);
      },
      onToolEvent: (event) => handleToolEvent(event, resolvedRunSettings),
      abortSignal: controller.signal,
    });
    finalizeToolRun(run);

    if (run.toolCallCount === 0) {
      const plainText = getLastAssistantPlainText();
      const { summary, oneLiner } = parseSummaryOutput(plainText);
      if (summary) {
        await saveEpisodeSummary(currentProject.id, episode.id, summary);
        episodeSummaries.summaries[episode.id] = {
          ...(episodeSummaries.summaries[episode.id] ?? { oneLiner: "" }),
          content: summary,
          updatedAt: new Date().toISOString(),
        };
        if (episode.id === state.currentEpisodeId) {
          renderEpisodeSummary(episode.id, summary, handleUpdateSummary, handleGenerateSummary);
        }
      }
      if (oneLiner) {
        await saveEpisodeOneLiner(currentProject.id, episode.id, oneLiner);
        const existing = episodeSummaries.summaries[episode.id];
        episodeSummaries.summaries[episode.id] = {
          content: existing?.content ?? "",
          oneLiner,
          updatedAt: new Date().toISOString(),
        };
      }
      if (summary || oneLiner) {
        syncSummaryToWindow();
        invoke("rebuild_search_index", { projectId: currentProject.id }).catch((error) => {
          console.warn("[litra] failed to rebuild search index after summary update:", error);
        });
      }
    }

    const plainText = getLastAssistantPlainText();
    const saved = episodeSummaries.summaries[episode.id];
    if (!plainText && saved?.content) {
      appendMessage(
        "assistant",
        `【要約】\n${saved.content}${saved.oneLiner ? `\n\n【一行要約】\n${saved.oneLiner}` : ""}`,
      );
    }

    renderProjectNavigation();
    await saveCurrentChat();
  } catch (error) {
    if (error instanceof Error && error.name !== "AbortError") {
      window.alert(`エラー: ${error.message}`);
    }
  } finally {
    setGenerating(false);
  }
}

async function loadProjectData(project: Project): Promise<void> {
  currentProject = project;
  state.currentProject = { id: project.id, title: project.title };

  await migrateFromManuscript(project.id);

  const [episodeList, characterList, worldList, relationshipData, messages, summaries, memos, projectMemoList] = await Promise.all([
    loadEpisodeList(project.id),
    loadCharacters(project.id),
    loadWorldEntries(project.id),
    loadRelationships(project.id),
    loadChat(project.id),
    loadSummaries(project.id),
    loadMemos(project.id),
    listProjectMemos(project.id),
  ]);

  episodes = episodeList.episodes;
  characters = characterList.characters;
  worldEntries = worldList.entries;
  relationshipsMap = relationshipData;
  episodeSummaries = summaries;
  episodeMemos = memos;
  projectMemos = projectMemoList;
  currentMemoId = projectMemos[0]?.id ?? null;

  await ensureEpisodeExists();

  if (state.currentEpisodeId) {
    const episode = episodes.find((ep) => ep.id === state.currentEpisodeId);
    if (episode) {
      const text = await loadEpisode(project.id, episode.fileName);
      getElements().editor.value = text;
      state.editorText = text;
    }
  }

  state.selectionStart = 0;
  state.selectionEnd = 0;
  state.currentView = "episode";

  renderMessages(messages);
  updateToolbarTitle(project.title);
  setView("episode");
  setEditorEnabled(true);
  renderProjectNavigation();
  renderEpisodeSummary(
    state.currentEpisodeId,
    state.currentEpisodeId ? episodeSummaries.summaries[state.currentEpisodeId]?.content : undefined,
    handleUpdateSummary,
    handleGenerateSummary,
  );
  renderEpisodeMemo(
    state.currentEpisodeId,
    state.currentEpisodeId ? episodeMemos.memos[state.currentEpisodeId]?.content : undefined,
    handleUpdateMemo,
  );
  syncMemoToWindow();
  syncSummaryToWindow();
  syncChatToWindow();
  syncSettingsToWindow();
  syncProjectMemosToWindow();
  hideProjectModal();

  invoke("rebuild_search_index", { projectId: project.id }).catch((error) => {
    console.error("[litra] failed to rebuild search index:", error);
  });
}

async function saveCurrentChat(): Promise<void> {
  if (!currentProject) return;
  await saveChat(currentProject.id, state.chatMessages);
}

async function handleCreateProjectMemo(title: string): Promise<void> {
  if (!currentProject) {
    window.alert("プロジェクトが選択されていません");
    return;
  }
  try {
    const memo = await createProjectMemo(currentProject.id, title);
    projectMemos.push(memo);
    currentMemoId = memo.id;
    currentProject.updatedAt = new Date().toISOString();
    await saveProject(currentProject);
    renderMemosView();
    syncProjectMemosToWindow();
  } catch (error) {
    console.error("[litra] failed to create project memo:", error);
    window.alert(`メモの作成に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleUpdateProjectMemo(id: string, updates: { title?: string; content?: string }): Promise<void> {
  if (!currentProject) return;
  try {
    const memo = await updateProjectMemo(currentProject.id, id, updates);
    const index = projectMemos.findIndex((m) => m.id === id);
    if (index !== -1) {
      projectMemos[index] = memo;
    }
    currentProject.updatedAt = new Date().toISOString();
    await saveProject(currentProject);
    renderMemosView();
    syncProjectMemosToWindow();
  } catch (error) {
    console.error("[litra] failed to update project memo:", error);
  }
}

async function handleDeleteProjectMemo(id: string): Promise<void> {
  if (!currentProject) return;
  try {
    await deleteProjectMemo(currentProject.id, id);
    projectMemos = projectMemos.filter((m) => m.id !== id);
    if (currentMemoId === id) {
      currentMemoId = projectMemos[0]?.id ?? null;
    }
    currentProject.updatedAt = new Date().toISOString();
    await saveProject(currentProject);
    renderMemosView();
    syncProjectMemosToWindow();
  } catch (error) {
    console.error("[litra] failed to delete project memo:", error);
    window.alert(`メモの削除に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function handleSelectProjectMemo(id: string | null): void {
  currentMemoId = id;
  renderMemosView();
  syncProjectMemosToWindow();
}

function buildSettingsContext(currentEpisodeId?: string, settings: AiSettings = currentSettings): string {
  const budgets = getPromptContextBudgets(settings);
  const recentConversation = state.chatMessages
    .filter((message) => !isToolResultLog(message.content))
    .slice(-4)
    .map((message) => message.content)
    .join("\n");
  const relevanceText = `${state.editorText}\n${recentConversation}`;

  function scoreTerms(terms: (string | undefined | null)[]): number {
    return terms.reduce((score, raw) => {
      const term = raw?.trim();
      if (!term || !relevanceText.includes(term)) return score;
      return score + (term.length >= 2 ? 10 : 3);
    }, 0);
  }

  const relevantCharacters = (characters ?? [])
    .map((character, index) => ({
      character,
      index,
      score: scoreTerms([character.name, character.reading, character.alias]),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ character }) => character);

  const relevantWorldEntries = (worldEntries ?? [])
    .map((entry, index) => ({
      entry,
      index,
      score: scoreTerms([entry.name, entry.category]),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ entry }) => entry);

  function formatFields(entries: [string, string | undefined][]): string {
    return entries
      .map(([label, value]): [string, string] | null => {
        const trimmed = value?.trim();
        if (!trimmed) return null;
        return [label, limitPromptText(trimmed, budgets.settingsField, "head")];
      })
      .filter((entry): entry is [string, string] => entry != null)
      .map(([label, value]) => `  - ${label}: ${value}`)
      .join("\n");
  }

  const charLinesRaw = relevantCharacters
    .map((c) => {
      const fixed: [string, string][] = [
        ["名前", c.name],
        ["よみがな", c.reading],
        ["別名", c.alias],
        ["役割", c.role],
        ["性別", c.gender],
        ["年齢", c.age],
        ["誕生日", c.birthday],
        ["血液型", c.bloodType],
        ["身長", c.height],
        ["体重", c.weight],
        ["見た目", c.appearance],
        ["性格", c.personality],
        ["個性", c.individuality],
        ["能力・スキル", c.skills],
        ["特技", c.specialSkills],
        ["生い立ち", c.upbringing],
        ["背景", c.background],
        ["メモ", c.notes],
        ...(c.customFields ?? []).map((f): [string, string] => [f.label || "カスタム", f.value]),
      ];
      const details = formatFields(fixed);
      return details ? `■ ${c.name || "（無題）"}\n${details}` : `■ ${c.name || "（無題）"}`;
    })
    .join("\n\n");
  const charLines = limitPromptText(charLinesRaw, budgets.settingsSection, "head");

  const worldLinesRaw = relevantWorldEntries
    .map((e) => {
      const fixed: [string, string][] = [
        ["名前", e.name],
        ["カテゴリ", e.category],
        ["時代", e.era],
        ["地理・場所", e.geography],
        ["気候", e.climate],
        ["人口", e.population],
        ["政治", e.politics],
        ["法律", e.laws],
        ["経済", e.economy],
        ["軍事", e.military],
        ["宗教", e.religion],
        ["言語", e.language],
        ["文化", e.culture],
        ["歴史", e.history],
        ["技術・魔術体系", e.technology],
        ["メモ", e.notes],
        ...(e.customFields ?? []).map((f): [string, string] => [f.label || "カスタム", f.value]),
      ];
      const details = formatFields(fixed);
      return details ? `■ ${e.name || "（無題）"}\n${details}` : `■ ${e.name || "（無題）"}`;
    })
    .join("\n\n");
  const worldLines = limitPromptText(worldLinesRaw, budgets.settingsSection, "head");

  const currentOrder = episodes.find((episode) => episode.id === currentEpisodeId)?.order ?? 0;
  const relationshipLinesRaw = [...(relationshipsMap.groups ?? [])]
    .sort((a, b) => {
      const rank = (episodeId: string | undefined): number => {
        if (episodeId === currentEpisodeId) return 0;
        if (!episodeId) return 1;
        const order = episodes.find((episode) => episode.id === episodeId)?.order ?? currentOrder;
        return 2 + Math.abs(order - currentOrder);
      };
      return rank(a.episodeId) - rank(b.episodeId);
    })
    .map((group) => {
      const episode = episodes.find((candidate) => candidate.id === group.episodeId);
      const groupTitle = group.episodeId ? `■ ${episode?.title || "（無題）"}` : "■ 全体（全話共通）";
      const lines = [...group.relationships]
        .map((relationship, index) => {
          const charA = characters.find((character) => character.id === relationship.characterAId)?.name || "（不明）";
          const charB = characters.find((character) => character.id === relationship.characterBId)?.name || "（不明）";
          return {
            relationship,
            index,
            charA,
            charB,
            score: scoreTerms([charA, charB]),
          };
        })
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map(({ relationship, charA, charB }) => {
          const arrow = relationship.direction === "a-to-b" ? "→" : relationship.direction === "b-to-a" ? "←" : "↔";
          return `  - ${charA} ${arrow} ${charB}: ${relationship.description || "（説明なし）"}`;
        })
        .join("\n");
      return `${groupTitle}\n${lines}`;
    })
    .join("\n\n");
  const relationshipLines = limitPromptText(relationshipLinesRaw, budgets.settingsSection, "head");

  const contextParts: string[] = [
    `【世界観設定】\n${worldLines || "（未登録）"}`,
    `【キャラクター設定】\n${charLines || "（未登録）"}`,
    `【人間関係】\n${relationshipLines || "（未登録）"}`,
  ];

  const projectMemoLines = limitPromptText(
    projectMemos
      .map((memo) => `■ ${memo.title || "（無題）"}\n${memo.content}`)
      .join("\n\n"),
    budgets.projectMemos,
    "head",
  );
  if (projectMemoLines) {
    contextParts.push(`【作品メモ】\n${projectMemoLines}`);
  }

  if (currentEpisodeId) {
    const previousEpisodes = episodes
      .filter((ep) => ep.order < currentOrder)
      .sort((a, b) => a.order - b.order)
      .slice(-3);

    const summaryLines = previousEpisodes
      .map((ep) => {
        const summary = episodeSummaries.summaries[ep.id]?.content?.trim();
        return summary ? `■ ${ep.title || "（無題）"}\n${limitPromptText(summary, budgets.previousSummary, "head")}` : null;
      })
      .filter((line): line is string => line != null)
      .join("\n\n");

    if (summaryLines) {
      contextParts.push(`【直近3話のあらすじ】\n${summaryLines}`);
    }

    const currentMemo = episodeMemos.memos[currentEpisodeId]?.content?.trim();
    if (currentMemo) {
      contextParts.push(`【本章の覚え書き】\n${limitPromptText(currentMemo, budgets.currentMemo, "head")}`);
    }
  }

  return contextParts.join("\n\n");
}

async function refreshProjectList(): Promise<void> {
  try {
    const projects = await listProjects();
    renderProjectList(projects, projectModalActions, currentProject?.id);
  } catch (error) {
    console.error("refreshProjectList error:", error);
    window.alert(`プロジェクト一覧の取得に失敗しました: ${error instanceof Error ? error.message : error}`);
  }
}

async function handleCreateProject(): Promise<void> {
  const title = getNewProjectTitle();
  if (!title) {
    window.alert("プロジェクト名を入力してください。");
    return;
  }

  try {
    const project = await createProject(title);
    clearNewProjectTitle();
    await refreshProjectList();
    await loadProjectData(project);
  } catch (error) {
    console.error("handleCreateProject error:", error);
    window.alert(`プロジェクトの作成に失敗しました: ${error instanceof Error ? error.message : error}`);
  }
}

async function handleOpenProject(projectId: string): Promise<void> {
  try {
    const project = await loadProject(projectId);
    await loadProjectData(project);
    await refreshProjectList();
  } catch (error) {
    console.error("handleOpenProject error:", error);
    window.alert(`プロジェクトを開けませんでした: ${error instanceof Error ? error.message : error}`);
  }
}

async function handleDeleteProject(projectId: string): Promise<void> {
  try {
    await deleteProject(projectId);

    if (currentProject?.id === projectId) {
      currentProject = null;
      state.currentProject = null;
      episodes = [];
      characters = [];
      worldEntries = [];
      episodeSummaries = { summaries: {} };
      episodeMemos = { memos: {} };
      getElements().editor.value = "";
      state.editorText = "";
      state.currentEpisodeId = null;
      renderMessages([]);
      renderEpisodeSummary(null, undefined, handleUpdateSummary, handleGenerateSummary);
      renderEpisodeMemo(null, undefined, handleUpdateMemo);
      updateToolbarTitle("");
      setEditorEnabled(false);
    }

    await refreshProjectList();
  } catch (error) {
    console.error("handleDeleteProject error:", error);
    window.alert(`プロジェクトの削除に失敗しました: ${error instanceof Error ? error.message : error}`);
  }
}

function closeProjectModal(): void {
  hideProjectModal();
}

const projectModalActions = {
  onCreate: () => void handleCreateProject(),
  onOpen: (projectId: string) => void handleOpenProject(projectId),
  onDelete: (projectId: string) => void handleDeleteProject(projectId),
};

const projectNavActions: ProjectNavActions = {
  onSelectEpisode: (id) => void selectEpisode(id),
  onNewEpisode: () => void handleNewEpisode(),
  onDeleteEpisode: (id) => void handleDeleteEpisode(id),
  onUpdateEpisodeTitle: (id, title) => void handleUpdateEpisodeTitle(id, title),
  onMoveEpisode: (id, direction) => void handleMoveEpisode(id, direction),
  onSelectView: (view) => {
    state.currentView = view;
    setView(view);
    if (view === "memos") {
      if (state.memosDetached) {
        void WebviewWindow.getByLabel("projectMemos").then((win) => win?.setFocus());
      } else {
        renderMemosView();
      }
    } else {
      renderSettingsView();
      syncSettingsToWindow();
    }
  },
  onGenerateSummary: (id) => void handleGenerateSummary(id),
};

const settingsActions: SettingsEditorActions = {
  onCreateCharacter: (name) => void handleCreateCharacter(name),
  onUpdateCharacter: (character) => void handleUpdateCharacter(character),
  onDeleteCharacter: (id) => void handleDeleteCharacter(id),
  onSelectCharacter: (id) => void handleSelectCharacter(id),
  onCreateWorldEntry: (name, category) => void handleCreateWorldEntry(name, category),
  onUpdateWorldEntry: (entry) => void handleUpdateWorldEntry(entry),
  onDeleteWorldEntry: (id) => void handleDeleteWorldEntry(id),
  onSelectWorldEntry: (id) => void handleSelectWorldEntry(id),
  onUpdateRelationships: (map) => void handleUpdateRelationships(map),
};

async function handleCreateCharacter(name: string): Promise<void> {
  if (!currentProject) return;
  const character = await createCharacter(currentProject.id, name);
  characters = (await loadCharacters(currentProject.id)).characters;
  state.currentCharacterId = character.id;
  renderSettingsView();
  syncSettingsToWindow();
}

async function handleUpdateCharacter(character: Character): Promise<void> {
  if (!currentProject) return;
  await updateCharacter(currentProject.id, character);
  characters = (await loadCharacters(currentProject.id)).characters;
  syncSettingsToWindow();
}

async function handleDeleteCharacter(id: string): Promise<void> {
  if (!currentProject) return;
  await deleteCharacter(currentProject.id, id);
  characters = (await loadCharacters(currentProject.id)).characters;
  removeCharacterRelationships(relationshipsMap, id);
  await saveRelationships(currentProject.id, relationshipsMap);
  if (state.currentCharacterId === id) {
    state.currentCharacterId = characters.length > 0 ? characters[0].id : null;
  }
  renderSettingsView();
  syncSettingsToWindow();
}

async function handleSelectCharacter(id: string): Promise<void> {
  state.currentCharacterId = id;
  renderSettingsView();
  syncSettingsToWindow();
}

async function handleUpdateRelationships(map: CharacterRelationshipMap): Promise<void> {
  if (!currentProject) return;
  relationshipsMap = map;
  await saveRelationships(currentProject.id, relationshipsMap);
}

async function handleCreateWorldEntry(name: string, category: string): Promise<void> {
  if (!currentProject) return;
  const entry = await createWorldEntry(currentProject.id, name, category);
  worldEntries = (await loadWorldEntries(currentProject.id)).entries;
  state.currentWorldEntryId = entry.id;
  renderSettingsView();
  syncSettingsToWindow();
}

async function handleUpdateWorldEntry(entry: WorldEntry): Promise<void> {
  if (!currentProject) return;
  await updateWorldEntry(currentProject.id, entry);
  worldEntries = (await loadWorldEntries(currentProject.id)).entries;
  syncSettingsToWindow();
}

async function handleDeleteWorldEntry(id: string): Promise<void> {
  if (!currentProject) return;
  await deleteWorldEntry(currentProject.id, id);
  worldEntries = (await loadWorldEntries(currentProject.id)).entries;
  if (state.currentWorldEntryId === id) {
    state.currentWorldEntryId = worldEntries.length > 0 ? worldEntries[0].id : null;
  }
  renderSettingsView();
  syncSettingsToWindow();
}

async function handleSelectWorldEntry(id: string): Promise<void> {
  state.currentWorldEntryId = id;
  renderSettingsView();
  syncSettingsToWindow();
}

// 続き生成の直前本文に登場する人物を文字列照合で検出し、既存の全文検索インデックスから
// その人物の過去の登場場面を短く抜粋する(LLM呼び出しは増やさない)。
// 検索・照合の失敗は続き生成全体を止めてはならないため、ここで完全に吸収する。
async function buildContinuationRelatedScenes(context: string): Promise<string | undefined> {
  if (!currentProject) return undefined;
  try {
    const relatedScenes = await buildRelatedScenesBlock({
      projectId: currentProject.id,
      currentEpisodeId: state.currentEpisodeId ?? undefined,
      characters,
      tailContext: context,
    });
    if (relatedScenes) {
      console.log("[litra] related scenes injected:", relatedScenes.slice(0, 200));
    }
    return relatedScenes;
  } catch (error) {
    console.warn("[litra] related scenes lookup failed; continuing without", error);
    return undefined;
  }
}

const CONTINUATION_STAGE_LABELS = {
  plan: "構想中…",
  draft: "執筆中…",
  review: "レビュー中…",
  revise: "修正中…",
} as const;

// ボタン表示用にモデルラベルを切り詰める(長いモデルIDでツールバーが崩れるのを防ぐ)
function truncateModelLabel(label: string, maxChars = 20): string {
  return label.length <= maxChars ? label : `${label.slice(0, maxChars)}…`;
}

// ステージ表示に併記するモデルラベルを解決済み設定から取る
function stageModelLabel(settings: AiSettings): string {
  const entry = getProviderEntry(providerConfig, settings.provider);
  return truncateModelLabel(getProviderModelDefaults(entry, settings.model)?.label ?? settings.model);
}

// 現エピソードの直前のエピソード本文を返す(文体指紋の計測材料が短すぎる場合の補完用)。
// 取得失敗は文体指紋の質が落ちるだけで続き生成全体を止めてはならないため、ここで吸収する。
async function findPreviousEpisodeContent(): Promise<string | undefined> {
  if (!currentProject) return undefined;
  const current = episodes.find((ep) => ep.id === state.currentEpisodeId);
  if (!current) return undefined;
  const previous = episodes
    .filter((ep) => ep.order < current.order)
    .sort((a, b) => b.order - a.order)[0];
  if (!previous) return undefined;
  try {
    const result = await invoke<{ content: string }>("retrieve_episode_content", {
      req: { projectId: currentProject.id, episodeId: previous.id, contentType: "fullText" },
    });
    return result.content;
  } catch (error) {
    console.warn("[litra] failed to load previous episode content for style fingerprint", error);
    return undefined;
  }
}

async function handleContinue(): Promise<void> {
  if (!validateEpisode() || !(await validateSettings())) return;

  await saveCurrentEpisode();

  const { start } = getSelection();
  const text = getElements().editor.value;
  const context = buildContinuationContext(text, start);
  const relatedScenes = await buildContinuationRelatedScenes(context);
  const styleFingerprint = measureStyleFingerprint(
    composeStyleSampleText(text, await findPreviousEpisodeContent()),
  );
  const characterVoiceInput = {
    names: findMentionedCharacterNames(characters, context),
    excerpts: relatedScenes ?? "",
  };

  const btnContinue = getElements().btnContinue;
  const originalLabel = btnContinue.textContent;

  const controller = startGeneration();
  try {
    // 執筆系・判断系の設定は生成開始時に一度だけ解決し、ステージ表示のモデル名併記にも使う
    const writingRun = resolveWritingRunSettings(currentSettings);
    const judgmentRun = resolveJudgmentRunSettings(currentSettings);
    const run = await streamContinuation({
      settings: writingRun,
      context,
      settingsContext: buildSettingsContext(state.currentEpisodeId ?? undefined),
      relatedScenes,
      // continuePassage はチャットからこのパイプラインを起動するための入口。
      // 本パイプライン自身には渡さず、生成チャンクを直接エディタへ流す。
      tools: createAiTools({ includeContinuePassage: false }),
      episodeId: state.currentEpisodeId ?? undefined,
      characterVoiceInput,
      onChunk: (chunk) => {
        insertAtCursor(chunk);
      },
      onToolEvent: (event) => handleToolEvent(event, writingRun),
      onStage: (stage) => {
        // 構想・査読は判断系モデル、ドラフト・修正は執筆系モデルが実行する
        const stageSettings = stage === "plan" || stage === "review" ? judgmentRun : writingRun;
        btnContinue.textContent = `${CONTINUATION_STAGE_LABELS[stage]}〔${stageModelLabel(stageSettings)}〕`;
      },
      getJudgmentSettings: () => judgmentRun,
      styleFingerprint,
      abortSignal: controller.signal,
    });
    finalizeToolRun(run);
  } catch (error) {
    if (error instanceof Error && error.name !== "AbortError") {
      window.alert(`エラー: ${error.message}`);
    }
  } finally {
    setGenerating(false);
    btnContinue.textContent = originalLabel;
    await saveCurrentEpisode();
  }
}

async function handleRewrite(): Promise<void> {
  if (!validateEpisode() || !(await validateSettings())) return;

  const { start, end, text: selection } = getSelection();
  if (start === end) {
    window.alert("書き直す文章を選択してください。");
    return;
  }

  const editorText = getElements().editor.value;
  const context = buildRewriteContext(editorText, start, end);

  const controller = startGeneration();
  try {
    await streamRewrite({
      settings: resolveWritingRunSettings(currentSettings),
      judgmentSettings: resolveJudgmentRunSettings(currentSettings),
      selection,
      context,
      settingsContext: buildSettingsContext(state.currentEpisodeId ?? undefined),
      onChunk: (chunk) => {
        replaceSelection(chunk);
      },
      abortSignal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name !== "AbortError") {
      window.alert(`エラー: ${error.message}`);
    }
  } finally {
    setGenerating(false);
    await saveCurrentEpisode();
  }
}

async function handleFeedback(): Promise<void> {
  if (!validateEpisode() || !(await validateSettings())) return;

  const { start, end, text: selection } = getSelection();
  if (start === end) {
    window.alert("フィードバックを受けたい文章を選択してください。");
    return;
  }

  appendMessage("user", `選択部分へのフィードバックをお願いします。\n\n${selection}`);
  const controller = startGeneration();
  try {
    const run = await streamFeedback({
      settings: resolveJudgmentRunSettings(currentSettings),
      selection,
      settingsContext: buildSettingsContext(state.currentEpisodeId ?? undefined),
      onChunk: (chunk) => {
        appendAssistantChunk(chunk);
      },
      onReasoning: (chunk) => {
        appendAssistantThinking(chunk);
      },
      abortSignal: controller.signal,
    });
    annotateLastAssistantRun(run, currentSettings, "feedback");
    await saveCurrentChat();
  } catch (error) {
    if (error instanceof Error && error.name !== "AbortError") {
      window.alert(`エラー: ${error.message}`);
    }
  } finally {
    setGenerating(false);
  }
}

async function handleChatMessage(): Promise<void> {
  if (chatMessageInFlight) return;
  chatMessageInFlight = true;
  const chatSettings = resolveChatRunSettings(currentSettings);
  console.log(
    "[litra] handleChatMessage start",
    JSON.stringify({
      provider: chatSettings.provider,
      model: chatSettings.model,
      baseUrl: chatSettings.baseUrl,
      maxTokens: chatSettings.maxTokens,
      maxContextTokens: chatSettings.maxContextTokens,
      openaiReasoningEffort: chatSettings.openaiReasoningEffort,
    }),
  );
  const controller = startGeneration();
  try {
    // 空応答の場合でも UI に何か表示できるよう、事前に空のアシスタント返答枠を用意する
    const lastMsg = state.chatMessages[state.chatMessages.length - 1];
    if (
      !lastMsg ||
      lastMsg.role !== "assistant" ||
      lastMsg.content.trim().length > 0 ||
      (lastMsg.thinking?.trim().length ?? 0) > 0
    ) {
      appendMessage("assistant", "");
    }

    const messages = buildChatMessagesForModel(chatSettings);
    console.log("[litra] streaming chat with messages:", messages.length);

    const run = await streamChatWithAutoContinuation(messages, controller, chatSettings);
    if (run.stoppedAfterToolActivity) {
      appendToolInterruptedFallback();
    }
    annotateLastAssistantRun(run, chatSettings, "chat");

    const lastMessage = state.chatMessages[state.chatMessages.length - 1];
    if (lastMessage?.role === "assistant" && lastMessage.content.trim().length === 0) {
      lastMessage.content = "（応答がありませんでした）";
      const container = getElements().chatMessages;
      const lastEl = container.querySelector<HTMLElement>(".chat-message.assistant:last-child");
      if (lastEl) {
        renderChatMessageHtml(lastEl, lastMessage.content, lastMessage.thinking);
      }
      syncChatToWindow();
      await saveCurrentChat();
    }

    await saveCurrentChat();
    console.log("[litra] handleChatMessage finished");
  } catch (error) {
    console.error("[litra] chat error:", error);
    removeLastEmptyAssistantMessage();
    if (!(error instanceof Error && error.name === "AbortError")) {
      const message = formatAiErrorMessage(error);
      appendMessage("assistant", `⚠️ **エラーが発生しました**\n\n${message}`, true);
    }
  } finally {
    chatMessageInFlight = false;
    setGenerating(false);
  }
}

async function handleChatCommand(message: string): Promise<boolean> {
  if (message === "/clear") {
    clearChatDisplay();
    await emit("chat-clear-display", {});
    return true;
  }

  if (message === "/new") {
    stopGeneration();
    clearChat();
    await saveCurrentChat();
    return true;
  }

  return false;
}

async function handleChatSubmit(): Promise<void> {
  if (!validateProject() || !(await validateChatSettings())) return;
  if (state.isGenerating || chatMessageInFlight) return;

  if (state.currentEpisodeId) {
    await saveCurrentEpisode();
  }

  const { chatInput } = getElements();
  const message = chatInput.value.trim();
  if (!message) return;

  chatInput.value = "";
  resetChatInputHeight?.();
  if (await handleChatCommand(message)) return;
  appendMessage("user", message);
  await handleChatMessage();
}

function renderChatProviderOptions(): void {
  const { chatProviderSelect } = getElements();
  populateChatProviderOptions(chatProviderSelect, providerConfig);
}

function renderChatModelOptions(providerId: Provider): void {
  const { chatModelSelect } = getElements();
  populateChatModelOptions(chatModelSelect, providerConfig, providerId);
}

function updateChatSelectorsFromSettings(): void {
  const { chatProviderSelect, chatModelSelect } = getElements();
  const provider = currentSettings.chatProvider ?? currentSettings.provider;
  const model = currentSettings.chatModel ?? getProviderSpecificSettings(currentSettings, provider).model;

  if (chatProviderSelect.value !== provider) {
    renderChatModelOptions(provider);
  }
  chatProviderSelect.value = provider;
  chatModelSelect.value = model;
}

async function handleChatProviderChange(): Promise<void> {
  const { chatProviderSelect, chatModelSelect } = getElements();
  const provider = chatProviderSelect.value as Provider;
  currentSettings.chatProvider = provider;
  renderChatModelOptions(provider);
  const model = getProviderSpecificSettings(currentSettings, provider).model;
  currentSettings.chatModel = model;
  chatModelSelect.value = model;
  await saveSettings(currentSettings);
  syncChatSettingsToWindow();
}

async function handleChatModelChange(): Promise<void> {
  const { chatModelSelect } = getElements();
  currentSettings.chatModel = chatModelSelect.value;
  await saveSettings(currentSettings);
  syncChatSettingsToWindow();
}

function bindChatSettingsSelectors(): void {
  const { chatProviderSelect, chatModelSelect } = getElements();
  chatProviderSelect.addEventListener("change", () => void handleChatProviderChange());
  chatModelSelect.addEventListener("change", () => void handleChatModelChange());
}

function syncChatSettingsToWindow(): void {
  const provider = currentSettings.chatProvider ?? currentSettings.provider;
  const model = currentSettings.chatModel ?? getProviderSpecificSettings(currentSettings, provider).model;
  void emit("chat-settings-sync", { provider, model, chatSubmitShortcut: currentSettings.chatSubmitShortcut });
}

function openSettings(): void {
  renderProviderOptions(providerConfig);
  renderSettings(currentSettings, providerConfig);
  populateModelList(getProviderModelIds(getProviderEntry(providerConfig, currentSettings.provider)));
  showSettingsModal();
}

async function saveAndCloseSettings(settings: AiSettings): Promise<void> {
  // chatProvider/chatModel は設定モーダルから返されないため、未指定時は
  // currentSettings の値を維持する。backgroundProvider/backgroundModel は
  // モーダルから返されるが、明示的な undefined(チャット欄に同期) を尊重して
  // クリアできるようにするため、in 演算子で「存在するが undefined」と
  // 「そもそも存在しない」を区別する pickDefinedOrFallback を使う。
  const merged: AiSettings = {
    ...settings,
    chatProvider: settings.chatProvider ?? currentSettings.chatProvider,
    chatModel: settings.chatModel ?? currentSettings.chatModel,
    backgroundProvider: pickDefinedOrFallback(settings, currentSettings, "backgroundProvider"),
    backgroundModel: pickDefinedOrFallback(settings, currentSettings, "backgroundModel"),
  };
  currentSettings = merged;
  await saveSettings(merged);
  await saveWebDavSyncConfig(readWebDavSyncConfigFromModal());
  await saveExaApiKey(readExaApiKeyFromModal());
  renderChatProviderOptions();
  updateChatSelectorsFromSettings();
  syncChatSettingsToWindow();
  hideSettingsModal();
}

function cancelSettings(): void {
  hideSettingsModal();
}

async function handleInitializeSettings(): Promise<void> {
  const confirmed = confirm(
    "すべての設定（AI プロバイダー、モデル、API キー、レイアウト、ウィンドウ状態）を削除して初期状態に戻します。\nプロジェクトデータは削除されません。\nよろしいですか？",
  );
  if (!confirmed) return;

  await resetAllSettings();
  currentSettings = await loadSettings();
  providerConfig = await loadProviderConfig();
  renderChatProviderOptions();
  updateChatSelectorsFromSettings();
  syncChatSettingsToWindow();
  hideSettingsModal();
}

async function handleSelectImportFolder(): Promise<void> {
  const input = getElements().folderImportInput;
  if (!input.files || input.files.length === 0) {
    renderImportModeSelection();
    showImportPreviewModal();
    return;
  }

  if (!(await validateSettings())) {
    return;
  }

  pendingImportFiles = Array.from(input.files);
  input.value = "";
  pendingImportCandidates = [];
  pendingImportContentMode = getImportContentMode();

  renderImportLoading(
    pendingImportContentMode === "settingsOnly"
      ? "AI でファイルを分類中...（設定のみ）"
      : "AI でファイルを分類中...",
  );
  showImportPreviewModal();

  try {
    const candidates = await classifyFilesWithAI(pendingImportFiles, currentSettings, {
      contentMode: pendingImportContentMode,
    });
    pendingImportCandidates = candidates;
    renderImportPreview(candidates, pendingImportContentMode);
  } catch (error) {
    console.error("[litra:import] classification failed", error);
    window.alert(`ファイル分類に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    hideImportPreviewModal();
  }
}

function getImportContentMode(): ImportContentMode {
  const { radioImportSettingsOnly } = getElements();
  return radioImportSettingsOnly.checked ? "settingsOnly" : "bodyAndSettings";
}

async function handleImportModeChange(): Promise<void> {
  const nextMode = getImportContentMode();
  if (pendingImportFiles.length > 0 && pendingImportContentMode !== nextMode) {
    pendingImportContentMode = nextMode;
    pendingImportCandidates = [];
    renderImportLoading(
      nextMode === "settingsOnly"
        ? "AI でファイルを再分類中...（設定のみ）"
        : "AI でファイルを再分類中...",
    );
    try {
      const candidates = await classifyFilesWithAI(pendingImportFiles, currentSettings, {
        contentMode: nextMode,
      });
      pendingImportCandidates = candidates;
      renderImportPreview(candidates, nextMode);
    } catch (error) {
      console.error("[litra:import] reclassification failed", error);
      window.alert(`ファイル再分類に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
      hideImportPreviewModal();
    }
    return;
  }
  if (pendingImportCandidates.length > 0) {
    renderImportPreview(pendingImportCandidates, nextMode);
  }
}

async function handleConfirmImport(): Promise<void> {
  if (!currentProject) {
    window.alert("プロジェクトを開いた状態で取り込んでください。");
    return;
  }
  if (pendingImportFiles.length === 0 && pendingImportCandidates.length === 0) {
    const input = getElements().folderImportInput;
    input.value = "";
    input.click();
    return;
  }
  if (pendingImportFiles.length === 0 || pendingImportCandidates.length === 0) {
    hideImportPreviewModal();
    return;
  }

  const { chkImportDoubleCheck } = getElements();
  const enableDoubleCheck = chkImportDoubleCheck.checked;
  const contentMode = getImportContentMode();
  const modeLabel = contentMode === "settingsOnly" ? "設定のみ" : "本文 + 設定";

  renderImportLoading(
    enableDoubleCheck
      ? `取り込み中...（${modeLabel} / 整合性チェックあり）`
      : `取り込み中...（${modeLabel}）`,
  );

  try {
    const result = await applyImport(currentProject.id, pendingImportCandidates, pendingImportFiles, currentSettings, {
      contentMode,
    });

    if (enableDoubleCheck) {
      renderImportLoading("整合性チェック中...");
      const { reviewAndFixImportedData } = await import("./project/import-review.ts");
      const summary = [
        `キャラクター: ${result.characters} 件`,
        `世界観: ${result.worldEntries} 件`,
        `エピソード: ${result.episodes} 件`,
        `覚え書き: ${result.memos} 件`,
        `作品メモ: ${result.projectMemos} 件`,
        `人間関係: ${result.relationships} 件`,
      ].join("\n");
      const reviewResult = await reviewAndFixImportedData(currentProject.id, currentSettings, summary);
      renderImportResultWithReview(result, reviewResult);
    } else {
      renderImportResult(result);
    }

    pendingImportFiles = [];
    pendingImportCandidates = [];

    // 3秒後にプロジェクトデータを再読み込みしてプレビューを閉じる
    setTimeout(() => {
      void loadProjectData(currentProject!);
      hideImportPreviewModal();
    }, 3000);
  } catch (error) {
    console.error("[litra:import] import failed", error);
    window.alert(`取り込みに失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    hideImportPreviewModal();
  }
}

function handleCancelImport(): void {
  pendingImportFiles = [];
  pendingImportCandidates = [];
  pendingImportContentMode = "bodyAndSettings";
  hideImportPreviewModal();
}

function handleProviderChange(providerId: string) {
  return getProviderEntry(providerConfig, providerId);
}

async function handleFetchModels(settings: AiSettings): Promise<void> {
  const { btnFetchModels } = getElements();
  btnFetchModels.disabled = true;
  btnFetchModels.textContent = "取得中...";

  try {
    const result = await fetchAvailableModels(settings);
    if (result.error) {
      window.alert(`モデル取得に失敗しました: ${result.error}`);
      return;
    }

    const configuredModels = getProviderModelIds(getProviderEntry(providerConfig, settings.provider));
    const models = Array.from(new Set([...configuredModels, ...result.models])).sort();
    populateModelList(models);
    if (result.models.length === 0) {
      window.alert("利用可能なモデルが見つかりませんでした。");
    }

    // Copilot のモデル取得後、キャッシュされた能力情報に基づいて UI を再描画する
    if (settings.provider === "github-copilot") {
      updateAdvancedVisibility(settings.provider, settings.model);
    }
  } finally {
    btnFetchModels.disabled = false;
    btnFetchModels.textContent = "取得";
  }
}

async function openProjectManager(): Promise<void> {
  await refreshProjectList();
  showProjectModal();
}

async function loadInitialProject(): Promise<void> {
  try {
    const projects = await listProjects();
    if (projects.length > 0) {
      const latest = await loadProject(projects[0].id);
      await loadProjectData(latest);
    }
  } catch (error) {
    console.error("loadInitialProject error:", error);
  }
}

// --- WebDav 同期オーバーレイ -------------------------------------------------

function createSyncOverlay(): HTMLDivElement {
  const overlay = document.createElement("div");
  overlay.id = "litra-sync-overlay";
  overlay.style.cssText =
    "position: fixed; top: 0; left: 0; width: 100%; height: 100%;" +
    " background: rgba(0, 0, 0, 0.5); display: none;" +
    " align-items: center; justify-content: center; z-index: 99999;" +
    " font-family: sans-serif;";
  overlay.innerHTML =
    '<div style="background: #1e1e2e; color: #cdd6f4; padding: 32px 48px;' +
    ' border-radius: 12px; text-align: center; min-width: 320px;">' +
    '<div id="litra-sync-message" style="font-size: 16px; margin-bottom: 16px;">同期中...</div>' +
    '<div style="background: #313244; border-radius: 8px; height: 8px; overflow: hidden;">' +
    '<div id="litra-sync-progress-bar" style="background: #89b4fa; height: 100%; width: 0%;' +
    ' transition: width 0.2s;"></div>' +
    '</div>' +
    '<div id="litra-sync-count" style="font-size: 13px; color: #a6adc8; margin-top: 8px;"></div>' +
    "</div>";
  document.body.appendChild(overlay);
  return overlay;
}

function showSyncOverlay(message: string): void {
  const overlay = document.getElementById("litra-sync-overlay");
  if (!overlay) return;
  overlay.style.display = "flex";
  const msg = document.getElementById("litra-sync-message");
  if (msg) msg.textContent = message;
  const bar = document.getElementById("litra-sync-progress-bar");
  if (bar) bar.style.width = "0%";
  const count = document.getElementById("litra-sync-count");
  if (count) count.textContent = "";
}

function updateSyncOverlay(progress: SyncProgressPayload): void {
  const msg = document.getElementById("litra-sync-message");
  if (msg) {
    msg.textContent =
      progress.phase === "pull" ? "WebDavから同期中..." : "WebDavに同期中...";
  }
  const bar = document.getElementById("litra-sync-progress-bar");
  if (bar) {
    const pct = progress.total > 0 ? (progress.current / progress.total) * 100 : 0;
    bar.style.width = `${pct}%`;
  }
  const count = document.getElementById("litra-sync-count");
  if (count) {
    count.textContent =
      progress.total > 0
        ? `${progress.current} / ${progress.total}`
        : `${progress.current}`;
  }
}

function hideSyncOverlay(): void {
  const overlay = document.getElementById("litra-sync-overlay");
  if (overlay) overlay.style.display = "none";
}

async function shouldRunWebDavSync(): Promise<boolean> {
  try {
    const config = await loadWebDavSyncConfig();
    return config.enabled && config.baseUrl.trim().length > 0;
  } catch (error) {
    console.error("[litra] failed to load WebDav sync config:", error);
    return false;
  }
}

function bindUiEvents(): void {
  getElements();
  initEditor();
  setEditorInputCallback((text) => void autosaveEpisode(text));
  setEditorEnabled(false);

  bindToolbarActions({
    onContinue: () => void handleContinue(),
    onRewrite: () => void handleRewrite(),
    onFeedback: () => void handleFeedback(),
    onOpenSettings: openSettings,
    onOpenProjects: () => void openProjectManager(),
    onImport: () => void handleSelectImportFolder(),
  });

  getElements().chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void handleChatSubmit();
  });

  bindChatSubmitShortcut(getElements().chatInput, getElements().chatForm, () => currentSettings.chatSubmitShortcut);

  getElements().btnCancel.addEventListener("click", stopGeneration);

  bindSettingsActions({
    onSave: (settings) => void saveAndCloseSettings(settings),
    onCancel: cancelSettings,
    onInitialize: () => void handleInitializeSettings(),
  });

  bindModelFetchAction({
    onFetch: (settings) => void handleFetchModels(settings),
  });

  bindProviderChangeAction({
    onChange: handleProviderChange,
  });

  bindBackgroundProviderChangeAction();
  bindJudgmentModelControls();

  bindAdvancedSettingsToggle();
  bindChatSettingsSelectors();

  bindProjectModalActions(projectModalActions);
  bindProjectModalClose(closeProjectModal);
  bindFolderImportActions({
    onSelect: () => void handleSelectImportFolder(),
    onConfirm: () => void handleConfirmImport(),
    onCancel: () => void handleCancelImport(),
    onModeChange: () => void handleImportModeChange(),
  });
  bindProjectNavActions(projectNavActions);

  getElements().btnToggleMemo.addEventListener("click", toggleMemo);
  getElements().btnToggleChat.addEventListener("click", toggleChat);
  getElements().btnPopoutMemo.addEventListener("click", () => void openMemoWindow());
  getElements().btnPopoutChat.addEventListener("click", () => void openChatWindow());
  getElements().btnPopoutSummary.addEventListener("click", () => void openSummaryWindow());
  getElements().btnPopoutSettings.addEventListener("click", () => void openSettingsWindow());
  getElements().btnPopoutMemos.addEventListener("click", () => void openProjectMemosWindow());
  getElements().btnGenreLibrary.addEventListener("click", () => void openGenreLibraryWindow());
  applyPanelVisibility();

  setChatSyncCallback((messages, isGenerating) => {
    emit("chat-sync", { messages, isGenerating });
  });
}

async function init(): Promise<void> {
  console.log("[litra] init started");
  bindUiEvents();
  resetChatInputHeight = bindAutoResize(getElements().chatInput, 15);
  console.log("[litra] UI events bound");

  // WebDav 同期オーバーレイを準備
  createSyncOverlay();

  // 進捗イベントリスナーを登録
  try {
    await onSyncProgress((payload) => {
      updateSyncOverlay(payload);
    });
  } catch (error) {
    console.error("[litra] failed to subscribe sync progress:", error);
  }

  // 起動時に WebDav から pull
  if (await shouldRunWebDavSync()) {
    try {
      showSyncOverlay("WebDavから同期中...");
      const summary = await pullWebDavAll();
      console.log("[litra] WebDav pull complete:", summary);
    } catch (error) {
      console.error("[litra] WebDav pull failed:", error);
    } finally {
      hideSyncOverlay();
    }
  }

  try {
    await initResizablePanels();
    console.log("[litra] resizable panels initialized");
  } catch (error) {
    console.error("[litra] failed to initialize resizable panels:", error);
  }

  try {
    providerConfig = await loadProviderConfig();
    console.log("[litra] provider config loaded");
  } catch (error) {
    console.error("[litra] failed to load provider config:", error);
    window.alert(`プロバイダー設定の読み込みに失敗しました: ${error instanceof Error ? error.message : error}`);
    providerConfig = { providers: [] };
  }

  try {
    currentSettings = await loadSettings();
    console.log("[litra] settings loaded");
  } catch (error) {
    console.error("[litra] failed to load settings:", error);
    window.alert(`設定の読み込みに失敗しました: ${error instanceof Error ? error.message : error}`);
    currentSettings = {
      provider: "openai",
      apiKey: "",
      baseUrl: "",
      model: "",
      providerConfigs: {
        openai: { apiKey: "", baseUrl: "", model: "" },
        anthropic: { apiKey: "", baseUrl: "", model: "" },
        deepseek: { apiKey: "", baseUrl: "", model: "" },
        google: { apiKey: "", baseUrl: "", model: "" },
        llamacpp: { apiKey: "", baseUrl: "", model: "" },
        sakura: { apiKey: "", baseUrl: "", model: "" },
        plamo: { apiKey: "", baseUrl: "", model: "" },
        opencode: { apiKey: "", baseUrl: "", model: "" },
        codex: { apiKey: "", baseUrl: "", model: "" },
        "github-copilot": { apiKey: "", baseUrl: "", model: "" },
      },
      temperature: 0.7,
      maxTokens: 8192,
      maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
      chatSubmitShortcut: "ctrlEnter",
    };
  }

  try {
    const migrated = await invoke("migrate_legacy_app_data");
    console.log("[litra] legacy data migration checked", migrated);
  } catch (error) {
    console.warn("[litra] failed to check legacy data migration:", error);
  }

  renderChatProviderOptions();
  updateChatSelectorsFromSettings();

  listen<{ episodeId: string; content: string }>("memo-update", (event) => {
    const { episodeId, content } = event.payload;
    if (!currentProject) return;
    void saveEpisodeMemo(currentProject.id, episodeId, content);
    episodeMemos.memos[episodeId] = {
      content,
      updatedAt: new Date().toISOString(),
    };
    if (episodeId === state.currentEpisodeId) {
      getElements().episodeMemo.value = content;
    }
  });

  listen("memo-ready", () => {
    syncMemoToWindow();
  });

  listen<{ content: string }>("chat-send", async (event) => {
    if (!validateProject() || !(await validateChatSettings())) return;
    if (state.isGenerating || chatMessageInFlight) return;
    const content = typeof event.payload.content === "string" ? event.payload.content.trim() : "";
    if (!content) return;
    if (await handleChatCommand(content)) return;
    appendMessage("user", content);
    void handleChatMessage();
  });

  listen("chat-stop", () => {
    stopGeneration();
  });

  listen("chat-ready", () => {
    syncChatToWindow();
    syncChatSettingsToWindow();
  });

  listen<{ provider: Provider; model: string }>("chat-settings-change", (event) => {
    currentSettings.chatProvider = event.payload.provider;
    currentSettings.chatModel = event.payload.model;
    void saveSettings(currentSettings);
    updateChatSelectorsFromSettings();
  });

  listen<{ episodeId: string; content: string }>("summary-update", (event) => {
    const { episodeId, content } = event.payload;
    if (!currentProject) return;
    void saveEpisodeSummary(currentProject.id, episodeId, content);
    const existing = episodeSummaries.summaries[episodeId];
    episodeSummaries.summaries[episodeId] = {
      content,
      oneLiner: existing?.oneLiner ?? "",
      updatedAt: new Date().toISOString(),
    };
    if (episodeId === state.currentEpisodeId) {
      getElements().episodeSummary.value = content;
    }
  });

  listen("summary-ready", () => {
    syncSummaryToWindow();
  });

  listen("project-memos-ready", () => {
    syncProjectMemosToWindow();
  });

  listen<{ id: string; title?: string; content?: string }>("project-memos-update", (event) => {
    if (!currentProject) return;
    void handleUpdateProjectMemo(event.payload.id, {
      title: event.payload.title,
      content: event.payload.content,
    });
  });

  listen<{ id: string }>("project-memos-select", (event) => {
    handleSelectProjectMemo(event.payload.id);
  });

  listen<{ title: string }>("project-memos-create", (event) => {
    if (!currentProject) return;
    void handleCreateProjectMemo(event.payload.title);
  });

  listen<{ id: string }>("project-memos-delete", (event) => {
    if (!currentProject) return;
    void handleDeleteProjectMemo(event.payload.id);
  });

  listen<{ episodeId: string }>("summary-generate", (event) => {
    if (!currentProject) return;
    void handleGenerateSummary(event.payload.episodeId);
  });

  listen("settings-ready", () => {
    syncSettingsToWindow();
  });

  listen<{ view: "characters" | "world" | "relationships" }>("settings-select-view", (event) => {
    state.currentView = event.payload.view;
    setView(state.currentView);
    renderSettingsView();
    syncSettingsToWindow();
  });

  listen<{ name: string }>("settings-create-character", (event) => {
    void handleCreateCharacter(event.payload.name);
  });

  listen<{ character: Character }>("settings-update-character", (event) => {
    void handleUpdateCharacter(event.payload.character);
  });

  listen<{ id: string }>("settings-delete-character", (event) => {
    void handleDeleteCharacter(event.payload.id);
  });

  listen<{ id: string }>("settings-select-character", (event) => {
    void handleSelectCharacter(event.payload.id);
  });

  listen<{ name: string; category: string }>("settings-create-world", (event) => {
    void handleCreateWorldEntry(event.payload.name, event.payload.category);
  });

  listen<{ entry: WorldEntry }>("settings-update-world", (event) => {
    void handleUpdateWorldEntry(event.payload.entry);
  });

  listen<{ id: string }>("settings-delete-world", (event) => {
    void handleDeleteWorldEntry(event.payload.id);
  });

  listen<{ id: string }>("settings-select-world", (event) => {
    void handleSelectWorldEntry(event.payload.id);
  });

  listen<{ map: CharacterRelationshipMap }>("settings-update-relationships", (event) => {
    void handleUpdateRelationships(event.payload.map);
  });

  const mainWindow = getCurrentWindow();
  void applyWindowBounds(mainWindow, "main");
  trackWindowBounds(mainWindow, "main");

  mainWindow.onCloseRequested(async (event) => {
    if (isMainClosing) return;
    event.preventDefault();
    isMainClosing = true;

    // 未確定のデバウンス保存があれば push 前にディスクへ反映する
    try {
      await flushPendingAutosave();
    } catch (error) {
      console.error("[litra] failed to flush pending autosave:", error);
    }

    // 終了時に WebDav full push
    if (await shouldRunWebDavSync()) {
      try {
        showSyncOverlay("WebDavに同期中...");
        const summary = await pushWebDavAll();
        console.log("[litra] WebDav push complete:", summary);
      } catch (error) {
        console.error("[litra] WebDav push failed:", error);
      } finally {
        hideSyncOverlay();
      }
    }

    try {
      const windows = await getAllWebviewWindows();
      for (const win of windows) {
        if (win.label !== mainWindow.label) {
          await win.destroy();
        }
      }
    } catch (error) {
      console.error("[litra] failed to close child windows:", error);
    }

    await mainWindow.destroy();
  }).catch((error) => {
    console.error("[litra] failed to listen main window close:", error);
  });

  try {
    await loadInitialProject();
    console.log("[litra] initial project loaded");
  } catch (error) {
    console.error("[litra] failed to load initial project:", error);
  }

  await restoreDetachedWindows();
}

async function initResizablePanels(): Promise<void> {
  const main = document.querySelector<HTMLElement>(".main");
  if (!main) return;

  const els = getElements();

  await applyStoredRatio(main, "--project-nav-width", "projectNav", 0.18);
  await applyStoredRatio(main, "--chat-panel-width", "chatPanel", 0.25);

  createVerticalResizer({
    container: main,
    propertyName: "--project-nav-width",
    position: "left",
    saveKey: "projectNav",
  });

  createVerticalResizer({
    container: main,
    propertyName: "--chat-panel-width",
    position: "right",
    saveKey: "chatPanel",
    disabled: () => els.chatPanel.classList.contains("collapsed") || els.chatPanel.classList.contains("detached"),
  });
}

function startApp(): void {
  void init().catch((error) => {
    console.error("[litra] unhandled init error:", error);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startApp);
} else {
  startApp();
}
