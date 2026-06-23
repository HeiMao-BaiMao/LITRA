import { emit, listen } from "@tauri-apps/api/event";
import { renderMemosEditor, type MemosEditorActions } from "./ui/memos-editor.ts";
import type { ProjectMemo } from "./project/project-memo.ts";

interface ProjectMemosSyncPayload {
  memos: ProjectMemo[];
  currentMemoId: string | null;
}

const container = document.querySelector<HTMLElement>("#memos-container");
if (!container) {
  console.error("[phenex:project-memos-window] container not found");
  throw new Error("#memos-container not found");
}

let currentMemos: ProjectMemo[] = [];
let currentMemoId: string | null = null;

const actions: MemosEditorActions = {
  onCreate: (title) => emit("project-memos-create", { title }),
  onUpdate: (id, updates) => emit("project-memos-update", { id, ...updates }),
  onDelete: (id) => emit("project-memos-delete", { id }),
  onSelect: (id) => emit("project-memos-select", { id }),
};

function render(): void {
  renderMemosEditor(currentMemos, currentMemoId, actions, container!, true);
}

listen<ProjectMemosSyncPayload>("project-memos-sync", (event) => {
  currentMemos = event.payload.memos;
  currentMemoId = event.payload.currentMemoId;
  render();
});

emit("project-memos-ready", {});
