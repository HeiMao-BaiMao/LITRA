import { emit, listen } from "@tauri-apps/api/event";

interface SummarySyncPayload {
  episodeId: string | null;
  content: string;
}

let currentEpisodeId: string | null = null;
let updateTimeout: ReturnType<typeof setTimeout> | null = null;

function init(): void {
  const textarea = document.querySelector<HTMLTextAreaElement>("#summary-textarea");
  const btnGenerate = document.querySelector<HTMLButtonElement>("#btn-generate-summary");
  if (!textarea || !btnGenerate) return;

  listen<SummarySyncPayload>("summary-sync", (event) => {
    currentEpisodeId = event.payload.episodeId;
    textarea.value = event.payload.content;

    if (currentEpisodeId) {
      textarea.disabled = false;
      textarea.placeholder = "このエピソードの要約を入力...";
      btnGenerate.disabled = false;
    } else {
      textarea.disabled = true;
      textarea.placeholder = "エピソードを選択してください...";
      btnGenerate.disabled = true;
    }
  });

  textarea.addEventListener("input", () => {
    if (!currentEpisodeId) return;
    if (updateTimeout) {
      clearTimeout(updateTimeout);
    }
    updateTimeout = setTimeout(() => {
      emit("summary-update", {
        episodeId: currentEpisodeId,
        content: textarea.value,
      });
    }, 400);
  });

  btnGenerate.addEventListener("click", () => {
    if (!currentEpisodeId) return;
    emit("summary-generate", { episodeId: currentEpisodeId });
  });

  emit("summary-ready", {});
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
