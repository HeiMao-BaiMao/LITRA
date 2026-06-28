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
  resolveChatSettings,
  getProviderSpecificSettings,
} from "./settings.ts";
import { applyImport, classifyFilesWithAI, type AiImportCandidate } from "./project/import.ts";
import { state, type ChatTransportMetadata, type ProjectView } from "./state.ts";
import {
  streamChat,
  streamContinuation,
  streamFeedback,
  streamRewrite,
  type StreamRunResult,
  type StreamToolEvent,
} from "./ai/service.ts";
import { buildSummaryPrompt, limitPromptText, parseSummaryOutput, samplePromptText } from "./ai/prompts.ts";
import {
  createCheckConsistencyTool,
  createCreateCharacterTool,
  createCreateProjectMemoTool,
  createCreateWorldEntryTool,
  createEditEpisodeBatchTool,
  createEditEpisodeTool,
  createFindEpisodeLinesTool,
  createGetEpisodeLinesTool,
  createCreateRelationshipTool,
  createDeleteRelationshipTool,
  createGetEpisodeMemoTool,
  createGetProjectMemoTool,
  createListCharactersTool,
  createListEpisodeMemosTool,
  createListEpisodesTool,
  createListProjectMemosTool,
  createListRelationshipsTool,
  createListWorldEntriesTool,
  createRebuildSearchIndexTool,
  createRetrieveEpisodeTool,
  createSaveEpisodeMemoTool,
  createSaveEpisodeOneLinerTool,
  createSaveEpisodeSummaryAndOneLinerTool,
  createSaveEpisodeSummaryTool,
  createSearchEpisodesTool,
  createUpdateCharacterTool,
  createUpdateProjectMemoTool,
  createUpdateRelationshipTool,
  createUpdateWorldEntryTool,
} from "./ai/tools.ts";
import { getElements } from "./ui/layout.ts";
import {
  initEditor,
  setEditorInputCallback,
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
import { renderChatMessageHtml } from "./markdown.ts";
import { bindToolbarActions } from "./ui/toolbar.ts";
import {
  bindAdvancedSettingsToggle,
  bindModelFetchAction,
  bindProviderChangeAction,
  bindSettingsActions,
  hideSettingsModal,
  populateModelList,
  renderProviderOptions,
  renderSettings,
  showSettingsModal,
} from "./ui/settings-modal.ts";
import {
  bindFolderImportActions,
  bindProjectModalActions,
  bindProjectModalClose,
  clearNewProjectTitle,
  getNewProjectTitle,
  hideImportPreviewModal,
  hideProjectModal,
  renderImportLoading,
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
  type ProviderModelDefaults,
  type ProviderConfig,
} from "./providers/config.ts";
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
let resetChatInputHeight: (() => void) | undefined;

const DEFAULT_MAX_CONTEXT_TOKENS = 65536;
const CONTEXT_CHAR_PER_TOKEN = 1.6;
const CONTEXT_OVERHEAD_TOKENS = 2048;
const TOOL_DISPLAY_INPUT_MAX_CHARS = 4000;
const TOOL_DISPLAY_OUTPUT_MAX_CHARS = 12000;
const CHAT_LENGTH_CONTINUATION_PROMPT =
  "前の応答は出力上限で途中で切れています。すでに書いた内容を繰り返さず、直前の文から自然に続きを書いてください。前置き、見出し、注釈は不要です。";
const CHAT_TOOL_CALL_RETRY_LIMIT = 3;
const CHAT_TOOL_CALL_RETRY_PROMPT =
  "直前の応答は、必要なツール呼び出しに到達しないまま説明文で終わっています。説明、手順、expectedText/replacementText の表示を続けず、直ちに必要なツールを呼び出してください。本文編集では findEpisodeLines または getEpisodeLines で確認し、単一範囲なら editEpisode、複数の離れた範囲なら editEpisodeBatch を呼び出してください。ユーザーへの文章回答はツール実行後だけにしてください。";

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
    settingsField: scaled(0.015, 800, 6000),
    settingsSection: scaled(0.12, 8000, 42000),
    projectMemos: scaled(0.08, 5000, 26000),
    previousSummary: scaled(0.035, 2200, 10000),
    currentMemo: scaled(0.06, 3500, 18000),
    summarySource: scaled(0.72, 24000, 180000),
    continuationContext: scaled(0.45, 12000, 100000),
    rewriteContextSide: scaled(0.18, 5000, 45000),
    chatHistoryMessages: Number.MAX_SAFE_INTEGER,
    chatMessage: scaled(0.14, 4000, 36000),
    chatHistory: scaled(0.35, 10000, 90000),
  };
}

function applyRuntimeModelDefaults(settings: AiSettings, defaults: ProviderModelDefaults | undefined): AiSettings {
  if (!defaults) return settings;

  return {
    ...settings,
    temperature: defaults.temperature ?? settings.temperature,
    maxTokens: defaults.maxTokens ?? settings.maxTokens,
    maxContextTokens: defaults.maxContextTokens ?? settings.maxContextTokens,
    topP: defaults.topP,
    topK: defaults.topK,
    frequencyPenalty: defaults.frequencyPenalty,
    presencePenalty: defaults.presencePenalty,
    openaiReasoningEffort: settings.provider === "openai" ? defaults.openaiReasoningEffort : undefined,
    deepseekReasoningEffort: settings.provider === "deepseek" ? defaults.deepseekReasoningEffort : undefined,
    anthropicThinkingEnabled: settings.provider === "anthropic" ? defaults.anthropicThinkingEnabled : undefined,
    anthropicThinkingBudget: settings.provider === "anthropic" ? defaults.anthropicThinkingBudget : undefined,
  };
}

function resolveChatRunSettings(settings: AiSettings): AiSettings {
  const resolved = resolveChatSettings(settings);
  const entry = getProviderEntry(providerConfig, resolved.provider);
  return applyRuntimeModelDefaults(resolved, getProviderModelDefaults(entry, resolved.model));
}

function getProviderProtocol(settings: AiSettings): string {
  switch (settings.provider) {
    case "sakura":
    case "openai":
    case "llamacpp":
      return "responses";
    case "plamo":
    case "deepseek":
      return "chat-completions";
    case "anthropic":
    case "google":
      return settings.provider;
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
    chatInput,
  } = getElements();

  const disabled = generating;
  btnSend.disabled = disabled;
  btnContinue.disabled = disabled;
  btnRewrite.disabled = disabled;
  btnFeedback.disabled = disabled;
  btnSettings.disabled = disabled;
  chatInput.disabled = disabled;

  if (generating) {
    btnCancel.classList.remove("hidden");
    btnCancel.disabled = false;
  } else {
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

function validateSettings(): boolean {
  const entry = getProviderEntry(providerConfig, currentSettings.provider);
  if (providerRequiresApiKey(entry) && !currentSettings.apiKey) {
    window.alert("API キーを設定してください。");
    openSettings();
    return false;
  }
  if (!currentSettings.model.trim()) {
    window.alert("モデル名を設定してください。");
    openSettings();
    return false;
  }
  return true;
}

function validateChatSettings(): boolean {
  const chatSettings = resolveChatRunSettings(currentSettings);
  const entry = getProviderEntry(providerConfig, chatSettings.provider);
  if (providerRequiresApiKey(entry) && !chatSettings.apiKey) {
    window.alert(`${entry?.name ?? chatSettings.provider} の API キーを設定してください。`);
    openSettings();
    return false;
  }
  if (!chatSettings.model.trim()) {
    window.alert("モデル名を設定してください。");
    openSettings();
    return false;
  }
  return true;
}

function createAiTools(): ToolSet | undefined {
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
    checkConsistency: createCheckConsistencyTool({
      projectId: currentProject.id,
      settings: currentSettings,
      currentEpisodeId: state.currentEpisodeId ?? undefined,
    }),
  };

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

function upsertToolLog(next: Omit<ToolLogState, "messageIndex">): void {
  const existing = toolLogStates.get(next.toolCallId);
  if (existing) {
    const updated: ToolLogState = { ...existing, ...next };
    toolLogStates.set(next.toolCallId, updated);
    if (!updateMessageContent(existing.messageIndex, formatToolLog(updated))) {
      toolLogStates.delete(next.toolCallId);
      upsertToolLog(next);
    }
    return;
  }

  removeLastEmptyAssistantMessage();
  const messageIndex = state.chatMessages.length;
  const created: ToolLogState = { ...next, messageIndex };
  appendMessage("assistant", formatToolLog(created));
  toolLogStates.set(next.toolCallId, created);
}

function handleToolEvent(event: StreamToolEvent): void {
  switch (event.type) {
    case "input-start":
      upsertToolLog({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: "input",
      });
      break;
    case "call":
      upsertToolLog({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: "running",
        input: event.input,
      });
      break;
    case "result":
      upsertToolLog({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: isFailureToolOutput(event.output) ? "failure" : "success",
        input: event.input,
        output: event.output,
      });
      break;
    case "error":
      upsertToolLog({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: "failure",
        input: event.input,
        output: { error: event.error },
      });
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
    tools: allowTools ? createAiTools() : undefined,
    onChunk: (chunk) => {
      appendAssistantChunk(chunk);
    },
    onReasoning: (chunk) => {
      appendAssistantThinking(chunk);
    },
    onToolEvent: allowTools ? handleToolEvent : undefined,
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
  let run = await streamChatOnce(messages, controller, true, settings);
  finalizeToolRun(run);

  while (!controller.signal.aborted) {
    if (shouldRetryMissingToolCall(messages, run)) {
      if (toolCallRetryCount >= CHAT_TOOL_CALL_RETRY_LIMIT) {
        appendMissingToolFallback();
        break;
      }

      toolCallRetryCount++;
      console.warn("[phenex] model did not emit a tool call; retrying with tool-call directive", {
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

    if (run.finishReason !== "length" || run.textCharCount <= 0) {
      break;
    }

    console.warn("[phenex] chat output hit maxOutputTokens; auto-continuing");
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

async function openMemoWindow(): Promise<void> {
  const existing = await WebviewWindow.getByLabel("memo");
  if (existing) {
    await existing.setFocus();
    return;
  }

  memoCollapsedBeforeDetach = state.memoCollapsed;
  state.memoDetached = true;
  applyPanelVisibility();
  void saveWindowDetached("memo", true);

  const webview = new WebviewWindow("memo", {
    url: "memo-window.html",
    title: "覚え書き - Phenex",
    width: 420,
    height: 640,
    minWidth: 280,
    minHeight: 320,
    dragDropEnabled: false,
  });

  webview.once("tauri://created", () => {
    setTimeout(() => syncMemoToWindow(), 500);
    void applyWindowBounds(webview, "memo");
    trackWindowBounds(webview, "memo");
  });

  webview.once("tauri://destroyed", () => {
    if (!isMainClosing) {
      state.memoDetached = false;
      state.memoCollapsed = memoCollapsedBeforeDetach;
      applyPanelVisibility();
      void saveWindowDetached("memo", false);
    }
  });
}

async function openChatWindow(): Promise<void> {
  const existing = await WebviewWindow.getByLabel("chat");
  if (existing) {
    await existing.setFocus();
    return;
  }

  chatCollapsedBeforeDetach = state.chatCollapsed;
  state.chatDetached = true;
  applyPanelVisibility();
  void saveWindowDetached("chat", true);

  const webview = new WebviewWindow("chat", {
    url: "chat-window.html",
    title: "AI チャット - Phenex",
    width: 480,
    height: 640,
    minWidth: 200,
    minHeight: 320,
    dragDropEnabled: false,
  });

  webview.once("tauri://created", () => {
    setTimeout(() => {
      syncChatToWindow();
      syncChatSettingsToWindow();
    }, 500);
    void applyWindowBounds(webview, "chat");
    trackWindowBounds(webview, "chat");
  });

  webview.once("tauri://destroyed", () => {
    if (!isMainClosing) {
      state.chatDetached = false;
      state.chatCollapsed = chatCollapsedBeforeDetach;
      applyPanelVisibility();
      void saveWindowDetached("chat", false);
    }
  });
}

async function openSummaryWindow(): Promise<void> {
  const existing = await WebviewWindow.getByLabel("summary");
  if (existing) {
    await existing.setFocus();
    return;
  }

  state.summaryDetached = true;
  applyPanelVisibility();
  void saveWindowDetached("summary", true);

  const webview = new WebviewWindow("summary", {
    url: "summary-window.html",
    title: "エピソード要約 - Phenex",
    width: 420,
    height: 640,
    minWidth: 280,
    minHeight: 320,
    dragDropEnabled: false,
  });

  webview.once("tauri://created", () => {
    setTimeout(() => syncSummaryToWindow(), 500);
    void applyWindowBounds(webview, "summary");
    trackWindowBounds(webview, "summary");
  });

  webview.once("tauri://destroyed", () => {
    if (!isMainClosing) {
      state.summaryDetached = false;
      applyPanelVisibility();
      void saveWindowDetached("summary", false);
    }
  });
}

async function openSettingsWindow(): Promise<void> {
  const existing = await WebviewWindow.getByLabel("settings");
  if (existing) {
    await existing.setFocus();
    return;
  }

  state.settingsDetached = true;
  applyPanelVisibility();
  void saveWindowDetached("settings", true);

  if (state.currentView === "episode") {
    state.currentView = "characters";
  }
  setView(state.currentView);
  renderSettingsView();
  syncSettingsToWindow();

  const webview = new WebviewWindow("settings", {
    url: "settings-window.html",
    title: "設定 - Phenex",
    width: 640,
    height: 700,
    minWidth: 420,
    minHeight: 420,
    dragDropEnabled: false,
  });

  webview.once("tauri://created", () => {
    setTimeout(() => syncSettingsToWindow(), 500);
    void applyWindowBounds(webview, "settings");
    trackWindowBounds(webview, "settings");
  });

  webview.once("tauri://destroyed", () => {
    if (!isMainClosing) {
      state.settingsDetached = false;
      applyPanelVisibility();
      setView(state.currentView);
      renderSettingsView();
      void saveWindowDetached("settings", false);
    }
  });
}

function syncProjectMemosToWindow(): void {
  emit("project-memos-sync", { memos: projectMemos, currentMemoId });
}

async function openProjectMemosWindow(): Promise<void> {
  const existing = await WebviewWindow.getByLabel("projectMemos");
  if (existing) {
    await existing.setFocus();
    return;
  }

  state.memosDetached = true;
  applyPanelVisibility();
  renderMemosView();
  void saveWindowDetached("projectMemos", true);

  const webview = new WebviewWindow("projectMemos", {
    url: "project-memo-window.html",
    title: "メモ - Phenex",
    width: 480,
    height: 640,
    minWidth: 280,
    minHeight: 320,
    dragDropEnabled: false,
  });

  webview.once("tauri://created", () => {
    setTimeout(() => syncProjectMemosToWindow(), 500);
    void applyWindowBounds(webview, "projectMemos");
    trackWindowBounds(webview, "projectMemos");
  });

  webview.once("tauri://destroyed", () => {
    if (!isMainClosing) {
      state.memosDetached = false;
      applyPanelVisibility();
      renderMemosView();
      void saveWindowDetached("projectMemos", false);
    }
  });
}

async function openGenreLibraryWindow(): Promise<void> {
  const existing = await WebviewWindow.getByLabel("genre-library");
  if (existing) {
    await existing.setFocus();
    return;
  }

  const webview = new WebviewWindow("genre-library", {
    url: "genre-library.html",
    title: "ジャンルライブラリ - Phenex",
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

  webview.once("tauri://created", () => {
    void applyWindowBounds(webview, "genre-library");
    trackWindowBounds(webview, "genre-library");
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
      console.error(`[phenex] failed to restore ${label} window:`, error);
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
  if (!currentProject || !validateSettings()) return;

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

    const isDeepSeek = currentSettings.provider === "deepseek";
    const run = await streamChat({
      settings: currentSettings,
      messages,
      tools: summaryTools,
      toolChoice: isDeepSeek ? "auto" : "required",
      stopWhen: hasToolCall("saveEpisodeSummaryAndOneLiner"),
      onChunk: (chunk) => {
        appendAssistantChunk(chunk);
      },
      onReasoning: (chunk) => {
        appendAssistantThinking(chunk);
      },
      onToolEvent: handleToolEvent,
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
          console.warn("[phenex] failed to rebuild search index after summary update:", error);
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
    console.error("[phenex] failed to rebuild search index:", error);
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
    console.error("[phenex] failed to create project memo:", error);
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
    console.error("[phenex] failed to update project memo:", error);
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
    console.error("[phenex] failed to delete project memo:", error);
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

  function scoreTerms(terms: string[]): number {
    return terms.reduce((score, raw) => {
      const term = raw.trim();
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

async function handleContinue(): Promise<void> {
  if (!validateEpisode() || !validateSettings()) return;

  await saveCurrentEpisode();

  const { start } = getSelection();
  const text = getElements().editor.value;
  const context = buildContinuationContext(text, start);

  const controller = startGeneration();
  try {
    const run = await streamContinuation({
      settings: currentSettings,
      context,
      settingsContext: buildSettingsContext(state.currentEpisodeId ?? undefined),
      tools: createAiTools(),
      onChunk: (chunk) => {
        insertAtCursor(chunk);
      },
      onToolEvent: handleToolEvent,
      abortSignal: controller.signal,
    });
    finalizeToolRun(run);
  } catch (error) {
    if (error instanceof Error && error.name !== "AbortError") {
      window.alert(`エラー: ${error.message}`);
    }
  } finally {
    setGenerating(false);
    await saveCurrentEpisode();
  }
}

async function handleRewrite(): Promise<void> {
  if (!validateEpisode() || !validateSettings()) return;

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
      settings: currentSettings,
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
  if (!validateEpisode() || !validateSettings()) return;

  const { start, end, text: selection } = getSelection();
  if (start === end) {
    window.alert("フィードバックを受けたい文章を選択してください。");
    return;
  }

  appendMessage("user", `選択部分へのフィードバックをお願いします。\n\n${selection}`);
  const controller = startGeneration();
  try {
    const run = await streamFeedback({
      settings: currentSettings,
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
    "[phenex] handleChatMessage start",
    JSON.stringify({
      provider: chatSettings.provider,
      model: chatSettings.model,
      baseUrl: chatSettings.baseUrl,
      maxTokens: chatSettings.maxTokens,
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
    console.log("[phenex] streaming chat with messages:", messages.length);

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
    console.log("[phenex] handleChatMessage finished");
  } catch (error) {
    console.error("[phenex] chat error:", error);
    if (error instanceof Error && error.name !== "AbortError") {
      window.alert(`エラー: ${error.message}`);
    } else if (!(error instanceof Error) || error.name !== "AbortError") {
      window.alert(`エラー: ${String(error)}`);
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
  if (!validateProject() || !validateChatSettings()) return;
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
  chatProviderSelect.innerHTML = "";
  for (const provider of providerConfig.providers) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.name;
    chatProviderSelect.appendChild(option);
  }
}

function renderChatModelOptions(providerId: Provider): void {
  const { chatModelSelect } = getElements();
  const entry = getProviderEntry(providerConfig, providerId);
  chatModelSelect.innerHTML = "";
  for (const model of entry?.models ?? []) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.label ?? model.id;
    chatModelSelect.appendChild(option);
  }
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
  void emit("chat-settings-sync", { provider, model });
}

function openSettings(): void {
  renderProviderOptions(providerConfig);
  renderSettings(currentSettings, providerConfig);
  populateModelList(getProviderModelIds(getProviderEntry(providerConfig, currentSettings.provider)));
  showSettingsModal();
}

async function saveAndCloseSettings(settings: AiSettings): Promise<void> {
  currentSettings = settings;
  await saveSettings(settings);
  renderChatProviderOptions();
  updateChatSelectorsFromSettings();
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
  hideSettingsModal();
}

async function handleSelectImportFolder(): Promise<void> {
  const input = getElements().folderImportInput;
  if (!input.files || input.files.length === 0) {
    input.click();
    return;
  }

  if (!validateSettings()) {
    return;
  }

  pendingImportFiles = Array.from(input.files);
  input.value = "";
  pendingImportCandidates = [];

  renderImportLoading();
  showImportPreviewModal();

  try {
    const candidates = await classifyFilesWithAI(pendingImportFiles, currentSettings);
    pendingImportCandidates = candidates;
    renderImportPreview(candidates);
  } catch (error) {
    console.error("[phenex:import] classification failed", error);
    window.alert(`ファイル分類に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    hideImportPreviewModal();
  }
}

async function handleConfirmImport(): Promise<void> {
  if (!currentProject) {
    window.alert("プロジェクトを開いた状態で取り込んでください。");
    return;
  }
  if (pendingImportFiles.length === 0 || pendingImportCandidates.length === 0) {
    hideImportPreviewModal();
    return;
  }

  const { chkImportDoubleCheck } = getElements();
  const enableDoubleCheck = chkImportDoubleCheck.checked;

  renderImportLoading(enableDoubleCheck ? "取り込み中...（整合性チェックあり）" : "取り込み中...");

  try {
    const result = await applyImport(currentProject.id, pendingImportCandidates, pendingImportFiles, currentSettings);

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
    console.error("[phenex:import] import failed", error);
    window.alert(`取り込みに失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    hideImportPreviewModal();
  }
}

function handleCancelImport(): void {
  pendingImportFiles = [];
  pendingImportCandidates = [];
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

  getElements().chatInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      getElements().chatForm.requestSubmit();
    }
  });

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

  bindAdvancedSettingsToggle();
  bindChatSettingsSelectors();

  bindProjectModalActions(projectModalActions);
  bindProjectModalClose(closeProjectModal);
  bindFolderImportActions({
    onSelect: () => void handleSelectImportFolder(),
    onConfirm: () => void handleConfirmImport(),
    onCancel: () => void handleCancelImport(),
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
  console.log("[phenex] init started");
  bindUiEvents();
  resetChatInputHeight = bindAutoResize(getElements().chatInput, 15);
  console.log("[phenex] UI events bound");

  try {
    await initResizablePanels();
    console.log("[phenex] resizable panels initialized");
  } catch (error) {
    console.error("[phenex] failed to initialize resizable panels:", error);
  }

  try {
    providerConfig = await loadProviderConfig();
    console.log("[phenex] provider config loaded");
  } catch (error) {
    console.error("[phenex] failed to load provider config:", error);
    window.alert(`プロバイダー設定の読み込みに失敗しました: ${error instanceof Error ? error.message : error}`);
    providerConfig = { providers: [] };
  }

  try {
    currentSettings = await loadSettings();
    console.log("[phenex] settings loaded");
  } catch (error) {
    console.error("[phenex] failed to load settings:", error);
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
      },
      temperature: 0.7,
      maxTokens: 8192,
      maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
    };
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
    if (!validateProject() || !validateChatSettings()) return;
    if (state.isGenerating || chatMessageInFlight) return;
    const content = event.payload.content.trim();
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

    try {
      const windows = await getAllWebviewWindows();
      for (const win of windows) {
        if (win.label !== mainWindow.label) {
          await win.destroy();
        }
      }
    } catch (error) {
      console.error("[phenex] failed to close child windows:", error);
    }

    await mainWindow.destroy();
  }).catch((error) => {
    console.error("[phenex] failed to listen main window close:", error);
  });

  try {
    await loadInitialProject();
    console.log("[phenex] initial project loaded");
  } catch (error) {
    console.error("[phenex] failed to load initial project:", error);
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
    console.error("[phenex] unhandled init error:", error);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startApp);
} else {
  startApp();
}
