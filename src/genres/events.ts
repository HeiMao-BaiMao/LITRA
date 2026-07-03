export const GENRE_LIBRARY_READY = "genre:library-ready";
export const GENRE_SELECTED = "genre:selected";
export const GENRE_UPDATED = "genre:updated";
export const GENRE_DELETED = "genre:deleted";
export const GENRE_SOURCE_UPDATED = "genre:source-updated";
export const GENRE_ANALYSIS_PROGRESS = "genre:analysis-progress";
export const GENRE_ANALYSIS_COMPLETED = "genre:analysis-completed";
export const GENRE_KNOWLEDGE_UPDATED = "genre:knowledge-updated";

export const GENRE_CHAT_READY = "genre:chat-ready";
export const GENRE_CHAT_SYNC = "genre:chat-sync";
export const GENRE_CHAT_SEND = "genre:chat-send";
export const GENRE_CHAT_STOP = "genre:chat-stop";
export const GENRE_CHAT_SETTINGS_CHANGE = "genre:chat-settings-change";
export const GENRE_CHAT_CLEAR_DISPLAY = "genre:chat-clear-display";

export interface GenreUpdatedEvent {
  genreId: string;
  revision: number;
  updatedAt: string;
}

export interface GenreSelectedEvent {
  genreId: string;
}

export interface GenreChatSyncPayload {
  messages: import("./schema.ts").GenreChatMessage[];
  isGenerating: boolean;
}

export interface GenreChatSettingsSyncPayload {
  provider: import("../settings.ts").Provider;
  model: string;
}

export interface GenreChatSendPayload {
  content: string;
}
