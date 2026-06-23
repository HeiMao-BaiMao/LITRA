import { getElements } from "./layout.ts";
import type { ProjectView } from "../state.ts";
import type { Episode } from "../project/schema.ts";

export interface ProjectNavActions {
  onSelectEpisode: (episodeId: string) => void;
  onNewEpisode: () => void;
  onDeleteEpisode: (episodeId: string) => void;
  onUpdateEpisodeTitle: (episodeId: string, title: string) => void;
  onMoveEpisode: (episodeId: string, direction: "up" | "down") => void;
  onReorderEpisodes?: (orderedEpisodeIds: string[]) => void;
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

let dndEpisodes: Episode[] = [];
let dndActions: Pick<ProjectNavActions, "onReorderEpisodes"> | null = null;
let dndAttached = false;

function createInlineTitleEditor(
  initialTitle: string,
  onCommit: (title: string) => void,
  onCancel: () => void,
): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "nav-episode-title-edit";
  input.value = initialTitle;
  input.placeholder = "エピソードタイトル";

  const commit = (): void => {
    const trimmed = input.value.trim();
    if (trimmed.length > 0) {
      onCommit(trimmed);
    } else {
      onCancel();
    }
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  });

  input.addEventListener("blur", () => {
    commit();
  });

  return input;
}

function createEpisodeItem(
  episode: Episode,
  index: number,
  total: number,
  isActive: boolean,
  actions: Pick<ProjectNavActions, "onSelectEpisode" | "onDeleteEpisode" | "onUpdateEpisodeTitle" | "onMoveEpisode" | "onReorderEpisodes">,
): HTMLElement {
  const item = document.createElement("div");
  item.className = "nav-episode-item";
  item.dataset.episodeId = episode.id;
  item.draggable = true;
  if (isActive) {
    item.classList.add("active");
  }

  item.addEventListener("dragstart", (event) => {
    const handle = (event.target as HTMLElement).closest(".nav-episode-drag-handle");
    if (!handle) {
      event.preventDefault();
      return;
    }
    event.dataTransfer?.setData("text/plain", episode.id);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
    }
    item.classList.add("dragging");
  });
  item.addEventListener("dragend", () => {
    item.classList.remove("dragging");
  });

  const dragHandle = document.createElement("span");
  dragHandle.className = "nav-episode-drag-handle";
  dragHandle.textContent = "≡";
  dragHandle.title = "ドラッグして並び替え";

  const moveControls = document.createElement("div");
  moveControls.className = "nav-episode-move-controls";

  const upBtn = document.createElement("button");
  upBtn.type = "button";
  upBtn.className = "nav-episode-move";
  upBtn.textContent = "▲";
  upBtn.title = "上へ移動";
  upBtn.disabled = index === 0;
  upBtn.addEventListener("click", () => {
    actions.onMoveEpisode(episode.id, "up");
  });

  const downBtn = document.createElement("button");
  downBtn.type = "button";
  downBtn.className = "nav-episode-move";
  downBtn.textContent = "▼";
  downBtn.title = "下へ移動";
  downBtn.disabled = index === total - 1;
  downBtn.addEventListener("click", () => {
    actions.onMoveEpisode(episode.id, "down");
  });

  moveControls.appendChild(upBtn);
  moveControls.appendChild(downBtn);

  const titleContainer = document.createElement("div");
  titleContainer.className = "nav-episode-title-container";

  const title = document.createElement("button");
  title.type = "button";
  title.className = "nav-episode-title";
  title.textContent = episode.title || "（無題）";
  title.title = "クリックで選択、ダブルクリックでタイトル編集";
  title.addEventListener("click", () => {
    actions.onSelectEpisode(episode.id);
  });
  title.addEventListener("dblclick", () => {
    const input = createInlineTitleEditor(
      episode.title,
      (newTitle) => {
        actions.onUpdateEpisodeTitle(episode.id, newTitle);
      },
      () => {
        renderEpisodeTitleButton(title, episode.title);
      },
    );
    titleContainer.replaceChild(input, title);
    input.focus();
    input.select();
  });

  titleContainer.appendChild(title);

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "nav-episode-edit";
  editBtn.textContent = "✎";
  editBtn.title = "タイトルを編集";
  editBtn.addEventListener("click", () => {
    const input = createInlineTitleEditor(
      episode.title,
      (newTitle) => {
        actions.onUpdateEpisodeTitle(episode.id, newTitle);
      },
      () => {
        renderEpisodeTitleButton(title, episode.title);
      },
    );
    titleContainer.replaceChild(input, title);
    input.focus();
    input.select();
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

  item.appendChild(dragHandle);
  item.appendChild(moveControls);
  item.appendChild(titleContainer);
  item.appendChild(editBtn);
  item.appendChild(deleteBtn);
  return item;
}

function renderEpisodeTitleButton(button: HTMLButtonElement, title: string): void {
  button.textContent = title || "（無題）";
}

export function renderEpisodeList(
  episodes: Episode[],
  currentEpisodeId: string | null,
  actions: Pick<ProjectNavActions, "onSelectEpisode" | "onDeleteEpisode" | "onUpdateEpisodeTitle" | "onMoveEpisode" | "onReorderEpisodes">,
): void {
  const list = getElements().episodeList;
  list.innerHTML = "";

  for (let i = 0; i < episodes.length; i++) {
    const episode = episodes[i];
    const item = createEpisodeItem(
      episode,
      i,
      episodes.length,
      episode.id === currentEpisodeId,
      actions,
    );
    list.appendChild(item);
  }

  dndEpisodes = episodes;
  dndActions = actions;
  if (dndAttached) return;
  dndAttached = true;
  if (!dndActions.onReorderEpisodes) return;

  function getDragAfterElement(y: number): HTMLElement | null {
    const items = [...list.querySelectorAll<HTMLElement>(".nav-episode-item:not(.dragging)")];
    return items.reduce<{ element: HTMLElement; offset: number } | null>((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && (closest === null || offset > closest.offset)) {
        return { element: child, offset };
      }
      return closest;
    }, null)?.element ?? null;
  }

  list.addEventListener("dragover", (event) => {
    event.preventDefault();
    const afterElement = getDragAfterElement(event.clientY);
    list.querySelectorAll<HTMLElement>(".nav-episode-item").forEach((el) => {
      el.classList.remove("drag-over");
    });
    afterElement?.classList.add("drag-over");
  });

  list.addEventListener("dragleave", (event) => {
    if (!list.contains(event.relatedTarget as Node)) {
      list.querySelectorAll<HTMLElement>(".nav-episode-item").forEach((el) => {
        el.classList.remove("drag-over");
      });
    }
  });

  list.addEventListener("drop", (event) => {
    event.preventDefault();
    list.querySelectorAll<HTMLElement>(".nav-episode-item").forEach((el) => {
      el.classList.remove("drag-over");
    });
    const draggedId = event.dataTransfer?.getData("text/plain");
    if (!draggedId) return;

    const afterElement = getDragAfterElement(event.clientY);
    const currentOrder = dndEpisodes.map((ep) => ep.id);
    const fromIndex = currentOrder.indexOf(draggedId);
    if (fromIndex === -1) return;

    currentOrder.splice(fromIndex, 1);
    let toIndex: number;
    if (afterElement) {
      const targetId = afterElement.dataset.episodeId;
      toIndex = targetId ? currentOrder.indexOf(targetId) : currentOrder.length;
      if (toIndex === -1) toIndex = currentOrder.length;
    } else {
      toIndex = currentOrder.length;
    }
    currentOrder.splice(toIndex, 0, draggedId);
    dndActions?.onReorderEpisodes?.(currentOrder);
  });
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
  const { navCharacters, navWorld, navRelationships } = getElements();
  navCharacters.classList.toggle("active", view === "characters");
  navWorld.classList.toggle("active", view === "world");
  navRelationships.classList.toggle("active", view === "relationships");
}

export function bindProjectNavActions(actions: ProjectNavActions): void {
  const { btnNewEpisode, navCharacters, navWorld, navRelationships, episodeSummary, episodeMemo, btnGenerateSummary } = getElements();

  btnNewEpisode.addEventListener("click", () => {
    actions.onNewEpisode();
  });

  navCharacters.addEventListener("click", () => {
    actions.onSelectView("characters");
  });

  navWorld.addEventListener("click", () => {
    actions.onSelectView("world");
  });

  navRelationships.addEventListener("click", () => {
    actions.onSelectView("relationships");
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
