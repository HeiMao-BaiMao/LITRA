export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export type ProjectView = "episode" | "characters" | "world";

export interface AppState {
  editorText: string;
  selectionStart: number;
  selectionEnd: number;
  chatMessages: ChatMessage[];
  isGenerating: boolean;
  abortController: AbortController | null;
  currentProject: { id: string; title: string } | null;
  currentView: ProjectView;
  currentEpisodeId: string | null;
  currentCharacterId: string | null;
  currentWorldEntryId: string | null;
}

export const state: AppState = {
  editorText: "",
  selectionStart: 0,
  selectionEnd: 0,
  chatMessages: [],
  isGenerating: false,
  abortController: null,
  currentProject: null,
  currentView: "episode",
  currentEpisodeId: null,
  currentCharacterId: null,
  currentWorldEntryId: null,
};
