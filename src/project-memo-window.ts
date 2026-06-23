import { emit, listen } from "@tauri-apps/api/event";
import { bindAutoResize } from "./ui/auto-resize.ts";

interface ProjectMemoSyncPayload {
  content: string;
}

let isSyncing = false;

async function init(): Promise<void> {
  const textarea = document.querySelector<HTMLTextAreaElement>("#project-memo-textarea");
  if (!textarea) return;

  bindAutoResize(textarea, 30);

  listen<ProjectMemoSyncPayload>("project-memo-sync", (event) => {
    isSyncing = true;
    try {
      textarea.value = event.payload.content;
    } finally {
      isSyncing = false;
    }
  });

  textarea.addEventListener("input", () => {
    if (isSyncing) return;
    emit("project-memo-update", { content: textarea.value });
  });

  emit("project-memo-ready", {});
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init());
} else {
  void init();
}
