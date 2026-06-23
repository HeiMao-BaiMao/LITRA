import { getElements } from "./layout.ts";
import type { ProjectSummary } from "../project/repository.ts";
import type { AiImportCandidate, ImportResult } from "../project/import.ts";

export interface ProjectModalActions {
  onCreate: () => void;
  onOpen: (projectId: string) => void;
  onDelete: (projectId: string) => void;
}

export function showProjectModal(): void {
  getElements().projectModal.classList.remove("hidden");
}

export function hideProjectModal(): void {
  getElements().projectModal.classList.add("hidden");
}

export function getNewProjectTitle(): string {
  return getElements().projectTitleInput.value.trim();
}

export function clearNewProjectTitle(): void {
  getElements().projectTitleInput.value = "";
}

export function renderProjectList(
  projects: ProjectSummary[],
  actions: ProjectModalActions,
  currentProjectId?: string,
): void {
  const list = getElements().projectList;
  list.innerHTML = "";

  if (projects.length === 0) {
    const empty = document.createElement("div");
    empty.className = "project-list-empty";
    empty.textContent = "プロジェクトがありません。新規作成してください。";
    list.appendChild(empty);
    return;
  }

  for (const project of projects) {
    const item = document.createElement("div");
    item.className = "project-list-item";
    if (project.id === currentProjectId) {
      item.classList.add("active");
    }

    const info = document.createElement("div");
    info.className = "project-list-info";

    const title = document.createElement("div");
    title.className = "project-list-title";
    title.textContent = project.title || "（無題）";

    const meta = document.createElement("div");
    meta.className = "project-list-meta";
    meta.textContent = `更新: ${new Date(project.updatedAt).toLocaleString("ja-JP")}`;

    info.appendChild(title);
    info.appendChild(meta);

    const actionContainer = document.createElement("div");
    actionContainer.className = "project-list-actions";

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.textContent = "開く";
    openBtn.addEventListener("click", () => {
      actions.onOpen(project.id);
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.textContent = "削除";
    deleteBtn.classList.add("danger");
    deleteBtn.addEventListener("click", () => {
      if (window.confirm(`「${project.title || "（無題）"}」を削除しますか？`)) {
        actions.onDelete(project.id);
      }
    });

    actionContainer.appendChild(openBtn);
    actionContainer.appendChild(deleteBtn);

    item.appendChild(info);
    item.appendChild(actionContainer);
    list.appendChild(item);
  }
}

export function bindProjectModalActions(actions: ProjectModalActions): void {
  const { btnCreateProject, projectTitleInput } = getElements();

  btnCreateProject.addEventListener("click", () => {
    actions.onCreate();
  });

  projectTitleInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      actions.onCreate();
    }
  });
}

export function bindProjectModalClose(onClose: () => void): void {
  const { projectModal } = getElements();
  const backdrop = projectModal.querySelector(".modal-backdrop");
  const closeBtn = getElements().btnCloseProjectModal;

  closeBtn.addEventListener("click", onClose);
  backdrop?.addEventListener("click", onClose);
}

export interface FolderImportActions {
  onSelect: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function bindFolderImportActions(actions: FolderImportActions): void {
  const { btnImportFolder, folderImportInput, btnConfirmImport, btnCancelImport } = getElements();

  btnImportFolder.addEventListener("click", () => {
    actions.onSelect();
  });

  folderImportInput.addEventListener("change", () => {
    actions.onSelect();
  });

  btnConfirmImport.addEventListener("click", () => {
    actions.onConfirm();
  });

  btnCancelImport.addEventListener("click", () => {
    actions.onCancel();
  });
}

export function showImportPreviewModal(): void {
  getElements().importPreviewModal.classList.remove("hidden");
}

export function hideImportPreviewModal(): void {
  getElements().importPreviewModal.classList.add("hidden");
}

export function renderImportLoading(message = "AI でファイルを分類中..."): void {
  const list = getElements().importPreviewList;
  list.innerHTML = "";

  const row = document.createElement("div");
  row.className = "import-preview-loading";
  row.textContent = message;
  list.appendChild(row);
}

export function renderImportPreview(candidates: AiImportCandidate[]): void {
  const list = getElements().importPreviewList;
  list.innerHTML = "";

  const counts: Record<string, number> = {};
  for (const candidate of candidates) {
    counts[candidate.type] = (counts[candidate.type] ?? 0) + 1;
  }

  const typeLabels: Record<string, string> = {
    character: "キャラクター",
    world: "世界観",
    episode: "エピソード",
    memo: "覚え書き",
    projectMemo: "作品メモ",
    unknown: "対象外",
    ignore: "対象外",
  };

  const summary = document.createElement("div");
  summary.className = "import-preview-summary";
  summary.textContent = `検出されたファイル: ${candidates.length} 件`;
  list.appendChild(summary);

  for (const [type, count] of Object.entries(counts)) {
    const row = document.createElement("div");
    row.className = "import-preview-row";
    row.textContent = `${typeLabels[type] ?? type}: ${count} 件`;
    list.appendChild(row);
  }

  for (const candidate of candidates) {
    const detail = document.createElement("div");
    detail.className = "import-preview-detail";
    detail.textContent = `[${typeLabels[candidate.type] ?? candidate.type}] ${candidate.filename} → ${candidate.title}`;
    list.appendChild(detail);
  }

  if (candidates.length === 0) {
    const empty = document.createElement("div");
    empty.className = "import-preview-empty";
    empty.textContent = "取り込めるファイルが見つかりませんでした。";
    list.appendChild(empty);
  }
}

export function renderImportResult(result: ImportResult): void {
  const list = getElements().importPreviewList;
  list.innerHTML = "";

  const summary = document.createElement("div");
  summary.className = "import-preview-summary";
  summary.textContent = "取り込みが完了しました。";
  list.appendChild(summary);

  const rows = [
    `キャラクター: ${result.characters} 件`,
    `世界観: ${result.worldEntries} 件`,
    `エピソード: ${result.episodes} 件`,
    `覚え書き: ${result.memos} 件`,
    `作品メモ: ${result.projectMemos} 件`,
  ];
  if (result.skippedMemos > 0) {
    rows.push(`スキップされた覚え書き: ${result.skippedMemos} 件（紐づくエピソードが見つかりませんでした）`);
  }

  for (const text of rows) {
    const row = document.createElement("div");
    row.className = "import-preview-row";
    row.textContent = text;
    list.appendChild(row);
  }
}
