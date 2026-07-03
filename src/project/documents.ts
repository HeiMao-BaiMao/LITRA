import { BaseDirectory, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type { ChatMessage } from "../state.ts";

const CHAT_DOCUMENT_VERSION = 2;

interface ChatDocument {
  schemaVersion: typeof CHAT_DOCUMENT_VERSION;
  messages: ChatMessage[];
  session: {
    updatedAt: string;
  };
}

function projectPath(projectId: string, fileName: string): string {
  return `litra/projects/${projectId}/${fileName}`;
}

export async function loadChat(projectId: string): Promise<ChatMessage[]> {
  try {
    const text = await readTextFile(projectPath(projectId, "chat.json"), {
      baseDir: BaseDirectory.Document,
    });
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.filter(isChatMessage);
    }
    if (isChatDocument(parsed)) {
      return parsed.messages.filter(isChatMessage);
    }
  } catch {
    // 読み込み失敗時は空の履歴を返す
  }
  return [];
}

export async function saveChat(
  projectId: string,
  messages: ChatMessage[],
): Promise<void> {
  const document: ChatDocument = {
    schemaVersion: CHAT_DOCUMENT_VERSION,
    messages,
    session: {
      updatedAt: new Date().toISOString(),
    },
  };

  await writeTextFile(
    projectPath(projectId, "chat.json"),
    JSON.stringify(document, null, 2),
    { baseDir: BaseDirectory.Document },
  );
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Partial<ChatMessage>;
  if ((m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") return false;
  return m.thinking === undefined || typeof m.thinking === "string";
}

function isChatDocument(value: unknown): value is ChatDocument {
  if (typeof value !== "object" || value === null) return false;
  const document = value as Partial<ChatDocument>;
  return Array.isArray(document.messages);
}
