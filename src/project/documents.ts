import { BaseDirectory, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type { ChatMessage } from "../state.ts";

function projectPath(projectId: string, fileName: string): string {
  return `phenex/projects/${projectId}/${fileName}`;
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
  } catch {
    // 読み込み失敗時は空の履歴を返す
  }
  return [];
}

export async function saveChat(
  projectId: string,
  messages: ChatMessage[],
): Promise<void> {
  await writeTextFile(
    projectPath(projectId, "chat.json"),
    JSON.stringify(messages, null, 2),
    { baseDir: BaseDirectory.Document },
  );
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Partial<ChatMessage>;
  return (m.role === "user" || m.role === "assistant") && typeof m.content === "string";
}
