export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AppState {
  editorText: string;
  selectionStart: number;
  selectionEnd: number;
  chatMessages: ChatMessage[];
  isGenerating: boolean;
  abortController: AbortController | null;
}

export const state: AppState = {
  editorText: "",
  selectionStart: 0,
  selectionEnd: 0,
  chatMessages: [],
  isGenerating: false,
  abortController: null,
};
