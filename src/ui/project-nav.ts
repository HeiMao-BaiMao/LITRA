import { getElements } from "./layout.ts";
import type { ProjectView } from "../state.ts";
import type { Episode } from "../project/schema.ts";

export interface ProjectNavActions {
  onSelectEpisode: (episodeId: string) => void;
  onNewEpisode: () => void;
  onDeleteEpisode: (episodeId: string) => void;
  onSelectView: (view: ProjectView) => void;
  onUpdateSummary?: (episodeId: string, text: string) => void;
  onUpdateMemo?: (episodeId: string, text: string) => void;
  onGenerateSummary?: (episodeId: string) => void;
}

let currentSummaryCallback: ((text: string) => void) | null = null;
let summaryUpdateTimeout: ReturnType<typeof setTimeout> | null = null;
let currentGenerateSummaryCallback: (() => void) | null = null;
let currentMemoCallback: ((text: string) => void) | null = null;
let memoUpdateTimeout: ReturnType<typeof setTimeout> | null = null;

function createEpisodeItem(
  episode: Episode,
  isActive: boolean,
  actions: Pick<ProjectNavActions, "onSelectEpisode" | "onDeleteEpisode">,
): HTMLElement {
  const item = document.createElement("div");
  item.className = "nav-episode-item";
  if (isActive) {
    item.classList.add("active");
  }

  const title = document.createElement("button");
  title.type = "button";
  title.className = "nav-episode-title";
  title.textContent = episode.title || "（無題）";
  title.addEventListener("click", () => {
    actions.onSelectEpisode(episode.id);
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "nav-episode-delete";
  deleteBtn.textContent = "×";
  deleteBtn.title = "削除";
  deleteBtn.addEventListener("click", () => {
    if (window.confirm(`「${episode.title || "（無題）"}」を削除しますか？`)) {
      actions.onDeleteEpisode(episode.id);
    }
  });

  item.appendChild(title);
  item.appendChild(deleteBtn);
  return item;
}

export function renderEpisodeList(
  episodes: Episode[],
  currentEpisodeId: string | null,
  actions: Pick<ProjectNavActions, "onSelectEpisode" | "onDeleteEpisode">,
): void {
  const list = getElements().episodeList;
  list.innerHTML = "";

  for (const episode of episodes) {
    const item = createEpisodeItem(
      episode,
      episode.id === currentEpisodeId,
      actions,
    );
    list.appendChild(item);
  }
}

export function renderEpisodeSummary(
  episodeId: string | null,
  summary: string | undefined,
  onUpdate?: (episodeId: string, text: string) => void,
  onGenerate?: (episodeId: string) => void,
): void {
  const { episodeSummary, btnGenerateSummary } = getElements();

  if (episodeId && onUpdate) {
    currentSummaryCallback = (text) => onUpdate(episodeId, text);
    episodeSummary.disabled = false;
    episodeSummary.placeholder = "このエピソードの要約を入力...";
  } else {
    currentSummaryCallback = null;
    episodeSummary.disabled = true;
    episodeSummary.placeholder = "エピソードを選択してください...";
  }

  if (episodeId && onGenerate) {
    currentGenerateSummaryCallback = () => onGenerate(episodeId);
    btnGenerateSummary.disabled = false;
  } else {
    currentGenerateSummaryCallback = null;
    btnGenerateSummary.disabled = true;
  }

  episodeSummary.value = summary ?? "";
}

export function renderEpisodeMemo(
  episodeId: string | null,
  memo: string | undefined,
  onUpdate?: (episodeId: string, text: string) => void,
): void {
  const { episodeMemo } = getElements();

  if (episodeId && onUpdate) {
    currentMemoCallback = (text) => onUpdate(episodeId, text);
    episodeMemo.disabled = false;
    episodeMemo.placeholder = "このエピソードの覚え書き（下書き）を入力...";
  } else {
    currentMemoCallback = null;
    episodeMemo.disabled = true;
    episodeMemo.placeholder = "エピソードを選択してください...";
  }

  episodeMemo.value = memo ?? "";
}

export function setActiveNav(view: ProjectView): void {
  const { navCharacters, navWorld } = getElements();
  navCharacters.classList.toggle("active", view === "characters");
  navWorld.classList.toggle("active", view === "world");
}

export function bindProjectNavActions(actions: ProjectNavActions): void {
  const { btnNewEpisode, navCharacters, navWorld, episodeSummary, episodeMemo, btnGenerateSummary } = getElements();

  btnNewEpisode.addEventListener("click", () => {
    actions.onNewEpisode();
  });

  navCharacters.addEventListener("click", () => {
    actions.onSelectView("characters");
  });

  navWorld.addEventListener("click", () => {
    actions.onSelectView("world");
  });

  btnGenerateSummary.addEventListener("click", () => {
    if (!currentGenerateSummaryCallback) return;
    currentGenerateSummaryCallback();
  });

  episodeSummary.addEventListener("input", () => {
    if (!currentSummaryCallback) return;

    if (summaryUpdateTimeout) {
      clearTimeout(summaryUpdateTimeout);
    }
    summaryUpdateTimeout = setTimeout(() => {
      currentSummaryCallback?.(episodeSummary.value);
    }, 400);
  });

  episodeMemo.addEventListener("input", () => {
    if (!currentMemoCallback) return;

    if (memoUpdateTimeout) {
      clearTimeout(memoUpdateTimeout);
    }
    memoUpdateTimeout = setTimeout(() => {
      currentMemoCallback?.(episodeMemo.value);
    }, 400);
  });
}
