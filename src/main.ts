import { loadSettings, saveSettings, type AiSettings } from "./settings.ts";
import { state, type ProjectView } from "./state.ts";
import {
  streamChat,
  streamContinuation,
  streamFeedback,
  streamRewrite,
} from "./ai/service.ts";
import { getElements } from "./ui/layout.ts";
import {
  initEditor,
  setEditorInputCallback,
  getSelection,
  insertAtCursor,
  replaceSelection,
} from "./ui/editor.ts";
import { appendMessage, renderMessages, updateLastAssistantChunk } from "./ui/chat.ts";
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
  bindProjectModalActions,
  bindProjectModalClose,
  clearNewProjectTitle,
  getNewProjectTitle,
  hideProjectModal,
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
import { fetchAvailableModels } from "./ai/model-list.ts";
import {
  getProviderEntry,
  loadProviderConfig,
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
import {
  createEpisode,
  deleteEpisode,
  loadEpisode,
  loadEpisodeList,
  migrateFromManuscript,
  saveEpisode,
} from "./project/episodes.ts";
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
import { loadSummaries, saveEpisodeSummary } from "./project/summaries.ts";
import { loadMemos, saveEpisodeMemo } from "./project/memos.ts";
import type { Character, Episode, EpisodeMemoMap, EpisodeSummaryMap, WorldEntry } from "./project/schema.ts";
import type { ModelMessage } from "ai";

let currentSettings: AiSettings;
let providerConfig: ProviderConfig;
let currentProject: Project | null = null;
let episodes: Episode[] = [];
let characters: Character[] = [];
let worldEntries: WorldEntry[] = [];
let episodeSummaries: EpisodeSummaryMap = { summaries: {} };
let episodeMemos: EpisodeMemoMap = { memos: {} };

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
}

function startGeneration(): AbortController {
  const controller = new AbortController();
  state.abortController = controller;
  setGenerating(true);
  return controller;
}

function stopGeneration(): void {
  state.abortController?.abort();
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
  if (!currentSettings.apiKey) {
    window.alert("API キーを設定してください。");
    showSettingsModal();
    return false;
  }
  return true;
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
  const { editorSection, settingsPanel } = getElements();

  if (view === "episode") {
    editorSection.classList.remove("hidden");
    settingsPanel.classList.add("hidden");
  } else {
    editorSection.classList.add("hidden");
    settingsPanel.classList.remove("hidden");
  }

  setActiveNav(view);
}

function renderProjectNavigation(): void {
  renderEpisodeList(episodes, state.currentEpisodeId, {
    onSelectEpisode: (id) => void selectEpisode(id),
    onDeleteEpisode: (id) => void handleDeleteEpisode(id),
  });
  setActiveNav(state.currentView);
}

function renderSettingsView(): void {
  if (state.currentView === "episode") return;
  renderSettingsEditor(
    state.currentView,
    characters,
    worldEntries,
    state.currentCharacterId,
    state.currentWorldEntryId,
    settingsActions,
  );
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
  episodeSummaries.summaries[state.currentEpisodeId] = {
    content: text,
    updatedAt: new Date().toISOString(),
  };
}

async function handleUpdateSummary(episodeId: string, text: string): Promise<void> {
  if (!currentProject) return;
  await saveEpisodeSummary(currentProject.id, episodeId, text);
  episodeSummaries.summaries[episodeId] = {
    content: text,
    updatedAt: new Date().toISOString(),
  };
}

async function saveCurrentMemo(): Promise<void> {
  if (!currentProject || !state.currentEpisodeId) return;
  const text = getElements().episodeMemo.value;
  await saveEpisodeMemo(currentProject.id, state.currentEpisodeId, text);
  episodeMemos.memos[state.currentEpisodeId] = {
    content: text,
    updatedAt: new Date().toISOString(),
  };
}

async function handleUpdateMemo(episodeId: string, text: string): Promise<void> {
  if (!currentProject) return;
  await saveEpisodeMemo(currentProject.id, episodeId, text);
  episodeMemos.memos[episodeId] = {
    content: text,
    updatedAt: new Date().toISOString(),
  };
}

async function selectEpisode(episodeId: string): Promise<void> {
  if (!currentProject) return;
  await saveCurrentEpisode();
  await saveCurrentSummary();
  await saveCurrentMemo();

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
  renderEpisodeSummary(episode.id, episodeSummaries.summaries[episode.id]?.content, handleUpdateSummary);
  renderEpisodeMemo(episode.id, episodeMemos.memos[episode.id]?.content, handleUpdateMemo);
}

async function ensureEpisodeExists(): Promise<void> {
  if (!currentProject) return;
  if (episodes.length === 0) {
    const episode = await createEpisode(currentProject.id, "第1話");
    episodes.push(episode);
  }
  if (!state.currentEpisodeId) {
    state.currentEpisodeId = episodes[0].id;
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

  if (state.currentEpisodeId === episodeId) {
    state.currentEpisodeId = episodes.length > 0 ? episodes[0].id : null;
    if (state.currentEpisodeId) {
      await selectEpisode(state.currentEpisodeId);
    } else {
      getElements().editor.value = "";
      state.editorText = "";
      await handleNewEpisode();
    }
  }

  renderProjectNavigation();
}

async function loadProjectData(project: Project): Promise<void> {
  currentProject = project;
  state.currentProject = { id: project.id, title: project.title };

  await migrateFromManuscript(project.id);

  const [episodeList, characterList, worldList, messages, summaries, memos] = await Promise.all([
    loadEpisodeList(project.id),
    loadCharacters(project.id),
    loadWorldEntries(project.id),
    loadChat(project.id),
    loadSummaries(project.id),
    loadMemos(project.id),
  ]);

  episodes = episodeList.episodes;
  characters = characterList.characters;
  worldEntries = worldList.entries;
  episodeSummaries = summaries;
  episodeMemos = memos;

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
  );
  renderEpisodeMemo(
    state.currentEpisodeId,
    state.currentEpisodeId ? episodeMemos.memos[state.currentEpisodeId]?.content : undefined,
    handleUpdateMemo,
  );
  hideProjectModal();
}

async function saveCurrentChat(): Promise<void> {
  if (!currentProject) return;
  await saveChat(currentProject.id, state.chatMessages);
}

function buildSettingsContext(currentEpisodeId?: string): string {
  function formatFields(entries: [string, string][]): string {
    return entries
      .filter(([, value]) => value.trim().length > 0)
      .map(([label, value]) => `  - ${label}: ${value}`)
      .join("\n");
  }

  const charLines = characters
    .map((c) => {
      const fixed: [string, string][] = [
        ["名前", c.name],
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
        ...c.customFields.map((f): [string, string] => [f.label || "カスタム", f.value]),
      ];
      const details = formatFields(fixed);
      return details ? `■ ${c.name || "（無題）"}\n${details}` : `■ ${c.name || "（無題）"}`;
    })
    .join("\n\n");

  const worldLines = worldEntries
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
        ...e.customFields.map((f): [string, string] => [f.label || "カスタム", f.value]),
      ];
      const details = formatFields(fixed);
      return details ? `■ ${e.name || "（無題）"}\n${details}` : `■ ${e.name || "（無題）"}`;
    })
    .join("\n\n");

  const contextParts: string[] = [
    `【世界観設定】\n${worldLines || "（未登録）"}`,
    `【キャラクター設定】\n${charLines || "（未登録）"}`,
  ];

  if (currentEpisodeId) {
    const currentOrder = episodes.find((ep) => ep.id === currentEpisodeId)?.order ?? -1;
    const previousEpisodes = episodes
      .filter((ep) => ep.order < currentOrder)
      .sort((a, b) => a.order - b.order)
      .slice(-3);

    const summaryLines = previousEpisodes
      .map((ep) => {
        const summary = episodeSummaries.summaries[ep.id]?.content?.trim();
        return summary ? `■ ${ep.title || "（無題）"}\n${summary}` : null;
      })
      .filter((line): line is string => line != null)
      .join("\n\n");

    if (summaryLines) {
      contextParts.push(`【直近3話のあらすじ】\n${summaryLines}`);
    }

    const currentMemo = episodeMemos.memos[currentEpisodeId]?.content?.trim();
    if (currentMemo) {
      contextParts.push(`【本章の覚え書き】\n${currentMemo}`);
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
      renderEpisodeSummary(null, undefined, handleUpdateSummary);
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
  onSelectView: (view) => {
    state.currentView = view;
    setView(view);
    renderSettingsView();
  },
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
};

async function handleCreateCharacter(name: string): Promise<void> {
  if (!currentProject) return;
  const character = await createCharacter(currentProject.id, name);
  characters = (await loadCharacters(currentProject.id)).characters;
  state.currentCharacterId = character.id;
  renderSettingsView();
}

async function handleUpdateCharacter(character: Character): Promise<void> {
  if (!currentProject) return;
  await updateCharacter(currentProject.id, character);
  characters = (await loadCharacters(currentProject.id)).characters;
}

async function handleDeleteCharacter(id: string): Promise<void> {
  if (!currentProject) return;
  await deleteCharacter(currentProject.id, id);
  characters = (await loadCharacters(currentProject.id)).characters;
  if (state.currentCharacterId === id) {
    state.currentCharacterId = characters.length > 0 ? characters[0].id : null;
  }
  renderSettingsView();
}

async function handleSelectCharacter(id: string): Promise<void> {
  state.currentCharacterId = id;
  renderSettingsView();
}

async function handleCreateWorldEntry(name: string, category: string): Promise<void> {
  if (!currentProject) return;
  const entry = await createWorldEntry(currentProject.id, name, category);
  worldEntries = (await loadWorldEntries(currentProject.id)).entries;
  state.currentWorldEntryId = entry.id;
  renderSettingsView();
}

async function handleUpdateWorldEntry(entry: WorldEntry): Promise<void> {
  if (!currentProject) return;
  await updateWorldEntry(currentProject.id, entry);
  worldEntries = (await loadWorldEntries(currentProject.id)).entries;
}

async function handleDeleteWorldEntry(id: string): Promise<void> {
  if (!currentProject) return;
  await deleteWorldEntry(currentProject.id, id);
  worldEntries = (await loadWorldEntries(currentProject.id)).entries;
  if (state.currentWorldEntryId === id) {
    state.currentWorldEntryId = worldEntries.length > 0 ? worldEntries[0].id : null;
  }
  renderSettingsView();
}

async function handleSelectWorldEntry(id: string): Promise<void> {
  state.currentWorldEntryId = id;
  renderSettingsView();
}

async function handleContinue(): Promise<void> {
  if (!validateEpisode() || !validateSettings()) return;

  const { start } = getSelection();
  const text = getElements().editor.value;
  const context = text.slice(0, start);

  const controller = startGeneration();
  try {
    await streamContinuation({
      settings: currentSettings,
      context,
      settingsContext: buildSettingsContext(state.currentEpisodeId ?? undefined),
      onChunk: (chunk) => {
        insertAtCursor(chunk);
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

async function handleRewrite(): Promise<void> {
  if (!validateEpisode() || !validateSettings()) return;

  const { start, end, text: selection } = getSelection();
  if (start === end) {
    window.alert("書き直す文章を選択してください。");
    return;
  }

  const editorText = getElements().editor.value;
  const context = `${editorText.slice(0, start)}\n[選択部分]\n${editorText.slice(end)}`;

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
    await streamFeedback({
      settings: currentSettings,
      selection,
      settingsContext: buildSettingsContext(state.currentEpisodeId ?? undefined),
      onChunk: (chunk) => {
        updateLastAssistantChunk(chunk);
      },
      abortSignal: controller.signal,
    });
    await saveCurrentChat();
  } catch (error) {
    if (error instanceof Error && error.name !== "AbortError") {
      window.alert(`エラー: ${error.message}`);
    }
  } finally {
    setGenerating(false);
  }
}

async function handleChatSubmit(): Promise<void> {
  if (!validateProject() || !validateSettings()) return;

  const { chatInput } = getElements();
  const message = chatInput.value.trim();
  if (!message) return;

  chatInput.value = "";
  appendMessage("user", message);

  const controller = startGeneration();
  try {
    const messages: ModelMessage[] = state.chatMessages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    await streamChat({
      settings: currentSettings,
      messages,
      settingsContext: buildSettingsContext(state.currentEpisodeId ?? undefined),
      onChunk: (chunk) => {
        updateLastAssistantChunk(chunk);
      },
      abortSignal: controller.signal,
    });
    await saveCurrentChat();
  } catch (error) {
    if (error instanceof Error && error.name !== "AbortError") {
      window.alert(`エラー: ${error.message}`);
    }
  } finally {
    setGenerating(false);
  }
}

function openSettings(): void {
  renderProviderOptions(providerConfig);
  renderSettings(currentSettings);
  showSettingsModal();
}

async function saveAndCloseSettings(settings: AiSettings): Promise<void> {
  currentSettings = settings;
  await saveSettings(settings);
  hideSettingsModal();
}

function cancelSettings(): void {
  hideSettingsModal();
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

    populateModelList(result.models);
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
  });

  getElements().chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void handleChatSubmit();
  });

  getElements().btnCancel.addEventListener("click", stopGeneration);

  bindSettingsActions({
    onSave: (settings) => void saveAndCloseSettings(settings),
    onCancel: cancelSettings,
  });

  bindModelFetchAction({
    onFetch: (settings) => void handleFetchModels(settings),
  });

  bindProviderChangeAction({
    onChange: handleProviderChange,
  });

  bindAdvancedSettingsToggle();

  bindProjectModalActions(projectModalActions);
  bindProjectModalClose(closeProjectModal);
  bindProjectNavActions(projectNavActions);
}

async function init(): Promise<void> {
  console.log("[phenex] init started");
  bindUiEvents();
  console.log("[phenex] UI events bound");

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
      temperature: 0.7,
      maxTokens: 1000,
    };
  }

  try {
    await loadInitialProject();
    console.log("[phenex] initial project loaded");
  } catch (error) {
    console.error("[phenex] failed to load initial project:", error);
  }
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
