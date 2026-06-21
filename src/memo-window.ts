import { emit, listen } from "@tauri-apps/api/event";

interface MemoSyncPayload {
  episodeId: string | null;
  content: string;
}

let currentEpisodeId: string | null = null;
let updateTimeout: ReturnType<typeof setTimeout> | null = null;

function init(): void {
  const textarea = document.querySelector<HTMLTextAreaElement>("#memo-textarea");
  if (!textarea) return;

  listen<MemoSyncPayload>("memo-sync", (event) => {
    currentEpisodeId = event.payload.episodeId;
    textarea.value = event.payload.content;

    if (currentEpisodeId) {
      textarea.disabled = false;
      textarea.placeholder = "このエピソードの覚え書き（下書き）を入力...";
    } else {
      textarea.disabled = true;
      textarea.placeholder = "エピソードを選択してください...";
    }
  });

  textarea.addEventListener("input", () => {
    if (!currentEpisodeId) return;
    if (updateTimeout) {
      clearTimeout(updateTimeout);
    }
    updateTimeout = setTimeout(() => {
      emit("memo-update", {
        episodeId: currentEpisodeId,
        content: textarea.value,
      });
    }, 400);
  });

  emit("memo-ready", {});
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
