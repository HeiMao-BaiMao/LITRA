import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { loadWindowBounds, saveWindowBoundsOnResize } from "./window-bounds.ts";
import { initializeTheme, setupThemeListener } from "./theme.ts";
import { setupCollapsibleSidebar } from "./ui/collapsible-sidebar.ts";
import type { GenreLibrary, GenreSource, Genre, GenreKnowledgeItem, GenreKnowledgeCandidate } from "./genres/schema.ts";
import * as repository from "./genres/repository.ts";
import * as sources from "./genres/sources.ts";
import * as knowledge from "./genres/knowledge.ts";
import * as analyzer from "./genres/analyzer.ts";
import { loadAiSettings } from "./settings.ts";
import { showError, showInfo, registerSpinner } from "./ui/common.ts";
import { renderGenreList } from "./ui/genres/genre-list.ts";
import { renderGenreOverview } from "./ui/genres/genre-overview.ts";
import { renderSourceList } from "./ui/genres/source-list.ts";
import { renderAnalysisReview } from "./ui/genres/analysis-review.ts";
import { renderKnowledgeEditor } from "./ui/genres/knowledge-editor.ts";
import {
  GENRE_LIBRARY_READY,
  GENRE_SELECTED,
  GENRE_CHAT_SYNC,
  type GenreSelectedPayload,
  type GenreChatSyncPayload,
} from "./genres/events.ts";

const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 400;

interface LibraryState {
  genres: GenreLibrary[];
  currentGenreId: string | null;
  currentSourceId: string | null;
  currentTab: "overview" | "sources" | "analysis" | "knowledge";
  isAnalyzing: boolean;
}

const state: LibraryState = {
  genres: [],
  currentGenreId: null,
  currentSourceId: null,
  currentTab: "overview",
  isAnalyzing: false,
};

let analysisAbortController: AbortController | null = null;

async function init(): Promise<void> {
  initializeTheme();
  setupThemeListener();
  await loadWindowBounds("genre-library");
  saveWindowBoundsOnResize("genre-library");
  setupCollapsibleSidebar("sidebar", "sidebar-toggle", {
    minWidth: SIDEBAR_MIN_WIDTH,
    maxWidth: SIDEBAR_MAX_WIDTH,
  });

  document.getElementById("btn-new-genre")?.addEventListener("click", createGenre);
  document.getElementById("btn-import-source")?.addEventListener("click", importSource);
  document.getElementById("btn-analyze-source")?.addEventListener("click", analyzeCurrentSource);
  document.getElementById("btn-open-genre-chat")?.addEventListener("click", openGenreChat);

  setupTabs();
  setupEventListeners();

  await refreshGenreList();

  await emit(GENRE_LIBRARY_READY, {});
}

function setupTabs(): void {
  const tabs = ["overview", "sources", "analysis", "knowledge"] as const;
  for (const tab of tabs) {
    document.getElementById(`tab-${tab}`)?.addEventListener("click", () => {
      state.currentTab = tab;
      updateTabUI();
      renderCurrentTab();
    });
  }
}

function updateTabUI(): void {
  const tabs = ["overview", "sources", "analysis", "knowledge"] as const;
  for (const tab of tabs) {
    const el = document.getElementById(`tab-${tab}`);
    el?.classList.toggle("active", state.currentTab === tab);
  }
}

function setupEventListeners(): void {
  listen<GenreSelectedPayload>(GENRE_SELECTED, async (event) => {
    if (event.payload.genreId) {
      await selectGenre(event.payload.genreId);
    }
  });

  listen<GenreChatSyncPayload>(GENRE_CHAT_SYNC, async () => {
    if (state.currentGenreId) {
      await refreshCurrentGenre();
    }
  });
}

async function refreshGenreList(): Promise<void> {
  registerSpinner("genre-list-spinner", true);
  try {
    state.genres = await repository.listGenres();
    const container = document.getElementById("genre-list");
    if (container) {
      renderGenreList(container, state.genres, {
        onSelect: selectGenre,
        onCreate: createGenre,
        onRename: renameGenre,
        onDelete: deleteGenre,
      });
    }
  } catch (error) {
    showError("ジャンル一覧の取得に失敗しました", error);
  } finally {
    registerSpinner("genre-list-spinner", false);
  }
}

async function selectGenre(genreId: string): Promise<void> {
  state.currentGenreId = genreId;
  state.currentSourceId = null;
  updateGenreSelectionUI();
  await refreshCurrentGenre();
}

async function refreshCurrentGenre(): Promise<void> {
  if (!state.currentGenreId) return;

  try {
    const genre = await repository.loadGenre(state.currentGenreId);
    if (!genre) {
      showError("ジャンルが見つかりません");
      return;
    }

    const sourceIndex = await sources.loadSourceIndex(state.currentGenreId);
    const knowledgeStore = await knowledge.loadKnowledgeStore(state.currentGenreId);

    renderCurrentTabWithData(genre, sourceIndex.sources, knowledgeStore.items, knowledgeStore.candidates);
  } catch (error) {
    showError("ジャンルデータの読み込みに失敗しました", error);
  }
}

function updateGenreSelectionUI(): void {
  const containers = [
    document.getElementById("genre-list"),
    document.getElementById("main-content"),
  ];

  for (const container of containers) {
    if (!container) continue;
    const items = container.querySelectorAll(".genre-list-item");
    items.forEach((item) => {
      item.classList.toggle("selected", item.getAttribute("data-genre-id") === state.currentGenreId);
    });
  }

  const main = document.getElementById("main-content");
  if (main) {
    main.classList.toggle("has-selection", !!state.currentGenreId);
  }
}

function renderCurrentTab(): void {
  if (!state.currentGenreId) return;
  refreshCurrentGenre();
}

async function renderCurrentTabWithData(
  genre: Genre,
  sourceList: GenreSource[],
  items: GenreKnowledgeItem[],
  candidates: GenreKnowledgeCandidate[],
): Promise<void> {
  const container = document.getElementById("main-content");
  if (!container) return;
  container.innerHTML = "";

  switch (state.currentTab) {
    case "overview": {
      renderGenreOverview(container, genre, {
        onEdit: () => editGenreOverview(genre),
      });
      break;
    }
    case "sources": {
      renderSourceList(container, sourceList, {
        onSelect: (sourceId) => {
          state.currentSourceId = sourceId;
          refreshCurrentGenre();
        },
        onImport: importSource,
        onDelete: deleteSource,
        onView: viewSource,
      });
      break;
    }
    case "analysis": {
      const source = state.currentSourceId
        ? sourceList.find((s) => s.id === state.currentSourceId)
        : sourceList[0];
      if (source) {
        const analysis = await sources.loadAnalysis(genre.id, source.id);
        renderAnalysisReview(container, source, analysis, {
          onAnalyze: () => analyzeSource(source.id),
          onAcceptCandidate: (candidateId) => acceptCandidate(candidateId),
          onRejectCandidate: (candidateId) => rejectCandidate(candidateId),
        });
      } else {
        container.innerHTML = `<p class="empty-state">資料をインポートしてください。</p>`;
      }
      break;
    }
    case "knowledge": {
      renderKnowledgeEditor(container, items, candidates, {
        onAcceptCandidate: acceptCandidate,
        onRejectCandidate: rejectCandidate,
        onHoldCandidate: holdCandidate,
        onCreateItem: () => createKnowledgeItem(genre.id),
        onEditItem: (itemId) => editKnowledgeItem(genre.id, itemId),
        onDisableItem: (itemId) => disableKnowledgeItem(genre.id, itemId),
        onEnableItem: (itemId) => enableKnowledgeItem(genre.id, itemId),
        onDeleteItem: (itemId) => deleteKnowledgeItem(genre.id, itemId),
      });
      break;
    }
  }
}

async function createGenre(): Promise<void> {
  const name = window.prompt("新しいジャンル名を入力してください");
  if (!name || !name.trim()) return;

  try {
    const genre = await repository.createGenre(name.trim());
    await refreshGenreList();
    await selectGenre(genre.id);
    showInfo(`ジャンル「${genre.name}」を作成しました`);
  } catch (error) {
    showError("ジャンルの作成に失敗しました", error);
  }
}

async function renameGenre(genreId: string, name: string): Promise<void> {
  try {
    const genre = await repository.loadGenre(genreId);
    if (!genre) return;
    genre.name = name;
    genre.updatedAt = Date.now();
    await repository.saveGenre(genre);
    await refreshGenreList();
  } catch (error) {
    showError("ジャンル名の変更に失敗しました", error);
  }
}

async function deleteGenre(genreId: string): Promise<void> {
  const genre = state.genres.find((g) => g.id === genreId);
  if (!window.confirm(`ジャンル「${genre?.name ?? genreId}」を削除しますか？\n関連する資料・知識もすべて削除されます。`)) {
    return;
  }

  try {
    await repository.deleteGenre(genreId);
    if (state.currentGenreId === genreId) {
      state.currentGenreId = null;
      state.currentSourceId = null;
      const main = document.getElementById("main-content");
      if (main) main.innerHTML = "";
    }
    await refreshGenreList();
  } catch (error) {
    showError("ジャンルの削除に失敗しました", error);
  }
}

async function editGenreOverview(genre: Genre): Promise<void> {
  const name = window.prompt("ジャンル名", genre.name);
  if (name === null) return;

  const description = window.prompt("説明", genre.description);
  if (description === null) return;

  genre.name = name.trim() || genre.name;
  genre.description = description.trim();
  genre.updatedAt = Date.now();

  try {
    await repository.saveGenre(genre);
    await refreshGenreList();
    await refreshCurrentGenre();
  } catch (error) {
    showError("ジャンルの更新に失敗しました", error);
  }
}

async function importSource(): Promise<void> {
  if (!state.currentGenreId) {
    showError("先にジャンルを選択してください");
    return;
  }

  const title = window.prompt("資料のタイトルを入力してください");
  if (!title || !title.trim()) return;

  const content = window.prompt("資料の本文を入力してください\n（Markdown形式）");
  if (!content || !content.trim()) return;

  try {
    const source = await sources.addSource(state.currentGenreId, title.trim(), content.trim());
    state.currentSourceId = source.id;
    state.currentTab = "analysis";
    updateTabUI();
    await refreshCurrentGenre();
    showInfo("資料を追加しました");
  } catch (error) {
    showError("資料の追加に失敗しました", error);
  }
}

async function deleteSource(sourceId: string): Promise<void> {
  if (!state.currentGenreId) return;
  if (!window.confirm("この資料を削除しますか？")) return;

  try {
    await sources.deleteSource(state.currentGenreId, sourceId);
    if (state.currentSourceId === sourceId) {
      state.currentSourceId = null;
    }
    await refreshCurrentGenre();
  } catch (error) {
    showError("資料の削除に失敗しました", error);
  }
}

async function viewSource(sourceId: string): Promise<void> {
  if (!state.currentGenreId) return;

  try {
    const source = await sources.loadSource(state.currentGenreId, sourceId);
    if (!source) {
      showError("資料が見つかりません");
      return;
    }

    const segments = await sources.loadSourceSegments(state.currentGenreId, sourceId);
    const joined = segments.map((s) => s.content).join("\n\n---\n\n");
    window.alert(`${source.title}\n\n${joined.substring(0, 2000)}${joined.length > 2000 ? "..." : ""}`);
  } catch (error) {
    showError("資料の表示に失敗しました", error);
  }
}

async function analyzeCurrentSource(): Promise<void> {
  if (!state.currentSourceId) {
    showError("先に資料を選択してください");
    return;
  }
  await analyzeSource(state.currentSourceId);
}

async function analyzeSource(sourceId: string): Promise<void> {
  if (!state.currentGenreId) return;
  if (state.isAnalyzing) return;

  const settings = loadAiSettings();
  if (!settings.apiKey) {
    showError("AI設定でAPIキーを設定してください");
    return;
  }

  state.isAnalyzing = true;
  analysisAbortController = new AbortController();
  registerSpinner("analysis-spinner", true);

  try {
    await analyzer.analyzeSource(
      state.currentGenreId,
      sourceId,
      settings,
      (progress) => {
        const statusEl = document.getElementById("analysis-status");
        if (statusEl) {
          statusEl.textContent = `分析中: ${progress.currentSegment} / ${progress.totalSegments}`;
        }
      },
      analysisAbortController.signal,
    );

    showInfo("分析が完了しました");
    if (state.currentTab === "analysis" || state.currentTab === "knowledge") {
      await refreshCurrentGenre();
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      showInfo("分析を中断しました");
    } else {
      showError("分析に失敗しました", error);
    }
  } finally {
    state.isAnalyzing = false;
    analysisAbortController = null;
    registerSpinner("analysis-spinner", false);
  }
}

async function acceptCandidate(candidateId: string): Promise<void> {
  if (!state.currentGenreId) return;
  try {
    await knowledge.acceptCandidate(state.currentGenreId, candidateId);
    await refreshCurrentGenre();
  } catch (error) {
    showError("候補の採用に失敗しました", error);
  }
}

async function rejectCandidate(candidateId: string): Promise<void> {
  if (!state.currentGenreId) return;
  try {
    await knowledge.rejectCandidate(state.currentGenreId, candidateId);
    await refreshCurrentGenre();
  } catch (error) {
    showError("候補の却下に失敗しました", error);
  }
}

async function holdCandidate(candidateId: string): Promise<void> {
  if (!state.currentGenreId) return;
  try {
    await knowledge.holdCandidate(state.currentGenreId, candidateId);
    await refreshCurrentGenre();
  } catch (error) {
    showError("候補の保留に失敗しました", error);
  }
}

async function createKnowledgeItem(genreId: string): Promise<void> {
  const title = window.prompt("知識のタイトルを入力してください");
  if (!title || !title.trim()) return;

  const statement = window.prompt("知識の内容を入力してください");
  if (!statement || !statement.trim()) return;

  try {
    await knowledge.addManualItem(genreId, title.trim(), statement.trim());
    await refreshCurrentGenre();
  } catch (error) {
    showError("知識の追加に失敗しました", error);
  }
}

async function editKnowledgeItem(genreId: string, itemId: string): Promise<void> {
  try {
    const store = await knowledge.loadKnowledgeStore(genreId);
    const item = store.items.find((i) => i.id === itemId);
    if (!item) return;

    const title = window.prompt("タイトル", item.title);
    if (title === null) return;

    const statement = window.prompt("内容", item.statement);
    if (statement === null) return;

    const explanation = window.prompt("補足", item.explanation);
    if (explanation === null) return;

    await knowledge.updateItem(genreId, itemId, {
      title: title.trim() || item.title,
      statement: statement.trim() || item.statement,
      explanation: explanation.trim(),
    });
    await refreshCurrentGenre();
  } catch (error) {
    showError("知識の編集に失敗しました", error);
  }
}

async function disableKnowledgeItem(genreId: string, itemId: string): Promise<void> {
  try {
    await knowledge.disableItem(genreId, itemId);
    await refreshCurrentGenre();
  } catch (error) {
    showError("知識の無効化に失敗しました", error);
  }
}

async function enableKnowledgeItem(genreId: string, itemId: string): Promise<void> {
  try {
    await knowledge.enableItem(genreId, itemId);
    await refreshCurrentGenre();
  } catch (error) {
    showError("知識の再有効化に失敗しました", error);
  }
}

async function deleteKnowledgeItem(genreId: string, itemId: string): Promise<void> {
  try {
    await knowledge.deleteItem(genreId, itemId);
    await refreshCurrentGenre();
  } catch (error) {
    showError("知識の削除に失敗しました", error);
  }
}

async function openGenreChat(): Promise<void> {
  if (!state.currentGenreId) {
    showError("先にジャンルを選択してください");
    return;
  }

  try {
    await invoke("open_genre_chat_window", { genreId: state.currentGenreId });
  } catch (error) {
    showError("ジャンルチャットウィンドウを開けませんでした", error);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  init().catch((error) => {
    console.error("Failed to initialize genre library window:", error);
    showError("ジャンルライブラリの初期化に失敗しました", error);
  });
});

getCurrentWindow().onCloseRequested(() => {
  if (analysisAbortController) {
    analysisAbortController.abort();
  }
});
