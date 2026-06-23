export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  excludeFromContext?: boolean;
}

export type ProjectView = "episode" | "characters" | "world" | "relationships" | "memos";

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
  memoCollapsed: boolean;
  chatCollapsed: boolean;
  memoDetached: boolean;
  chatDetached: boolean;
  summaryDetached: boolean;
  settingsDetached: boolean;
  memosDetached: boolean;
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
  memoCollapsed: false,
  chatCollapsed: false,
  memoDetached: false,
  chatDetached: false,
  summaryDetached: false,
  settingsDetached: false,
  memosDetached: false,
};
