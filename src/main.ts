import { loadSettings, saveSettings, type AiSettings } from "./settings.ts";
import { state } from "./state.ts";
import {
  streamChat,
  streamContinuation,
  streamFeedback,
  streamRewrite,
} from "./ai/service.ts";
import { getElements } from "./ui/layout.ts";
import { initEditor, getSelection, insertAtCursor, replaceSelection } from "./ui/editor.ts";
import { appendMessage, updateLastAssistantChunk } from "./ui/chat.ts";
import { bindToolbarActions } from "./ui/toolbar.ts";
import {
  bindSettingsActions,
  hideSettingsModal,
  renderSettings,
  showSettingsModal,
} from "./ui/settings-modal.ts";
import type { ModelMessage } from "ai";

let currentSettings: AiSettings;

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

function validateSettings(): boolean {
  if (!currentSettings.apiKey) {
    window.alert("API キーを設定してください。");
    showSettingsModal();
    return false;
  }
  return true;
}

async function handleContinue(): Promise<void> {
  if (!validateSettings()) return;

  const { start } = getSelection();
  const text = getElements().editor.value;
  const context = text.slice(0, start);

  const controller = startGeneration();
  try {
    await streamContinuation({
      settings: currentSettings,
      context,
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
  }
}

async function handleRewrite(): Promise<void> {
  if (!validateSettings()) return;

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
  }
}

async function handleFeedback(): Promise<void> {
  if (!validateSettings()) return;

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
      onChunk: (chunk) => {
        updateLastAssistantChunk(chunk);
      },
      abortSignal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name !== "AbortError") {
      window.alert(`エラー: ${error.message}`);
    }
  } finally {
    setGenerating(false);
  }
}

async function handleChatSubmit(): Promise<void> {
  if (!validateSettings()) return;

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
      onChunk: (chunk) => {
        updateLastAssistantChunk(chunk);
      },
      abortSignal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name !== "AbortError") {
      window.alert(`エラー: ${error.message}`);
    }
  } finally {
    setGenerating(false);
  }
}

function openSettings(): void {
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

async function init(): Promise<void> {
  currentSettings = await loadSettings();

  getElements();
  initEditor();

  bindToolbarActions({
    onContinue: () => void handleContinue(),
    onRewrite: () => void handleRewrite(),
    onFeedback: () => void handleFeedback(),
    onOpenSettings: openSettings,
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
}

window.addEventListener("DOMContentLoaded", () => {
  void init();
});
