import { getElements } from "./layout.ts";
import { state } from "../state.ts";

export function getEditorText(): string {
  return getElements().editor.value;
}

export function setEditorText(text: string): void {
  const editor = getElements().editor;
  editor.value = text;
  state.editorText = text;
}

export function getSelection(): { start: number; end: number; text: string } {
  const editor = getElements().editor;
  return {
    start: editor.selectionStart,
    end: editor.selectionEnd,
    text: editor.value.slice(editor.selectionStart, editor.selectionEnd),
  };
}

export function replaceSelection(text: string): void {
  const editor = getElements().editor;
  const start = editor.selectionStart;
  const end = editor.selectionEnd;

  editor.setRangeText(text, start, end, "end");
  editor.focus();
  state.editorText = editor.value;
  state.selectionStart = editor.selectionStart;
  state.selectionEnd = editor.selectionEnd;
}

export function insertAtCursor(text: string): void {
  const editor = getElements().editor;
  const start = editor.selectionStart;
  const end = editor.selectionEnd;

  editor.setRangeText(text, start, end, "end");
  editor.focus();
  state.editorText = editor.value;
  state.selectionStart = editor.selectionStart;
  state.selectionEnd = editor.selectionEnd;
}

export function updateSelectionState(): void {
  const editor = getElements().editor;
  state.editorText = editor.value;
  state.selectionStart = editor.selectionStart;
  state.selectionEnd = editor.selectionEnd;
}

export function initEditor(): void {
  const editor = getElements().editor;
  editor.addEventListener("input", updateSelectionState);
  editor.addEventListener("select", updateSelectionState);
  editor.addEventListener("click", updateSelectionState);
  editor.addEventListener("keyup", updateSelectionState);
  document.addEventListener("selectionchange", () => {
    if (document.activeElement === editor) {
      updateSelectionState();
    }
  });
}
