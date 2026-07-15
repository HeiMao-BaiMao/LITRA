export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ModelMessage {
  role: MessageRole;
  content: string | Array<Record<string, unknown>>;
  [key: string]: unknown;
}
