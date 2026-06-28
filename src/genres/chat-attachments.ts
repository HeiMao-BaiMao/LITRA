import { BaseDirectory, mkdir, readTextFile, writeTextFile, remove } from "@tauri-apps/plugin-fs";
import { genreChatAttachmentsDir } from "./repository.ts";
import type { GenreChatAttachment } from "./schema.ts";

const ATTACHMENT_EXTENSION = "md";

export interface ChatAttachmentInput {
  name: string;
  type: GenreChatAttachment["type"];
  content: string;
}

function attachmentPath(
  genreId: string,
  threadId: string,
  messageId: string,
  attachmentId: string,
): string {
  return `${genreChatAttachmentsDir(genreId)}/${threadId}/${messageId}/${attachmentId}.${ATTACHMENT_EXTENSION}`;
}

export async function saveChatAttachment(
  genreId: string,
  threadId: string,
  messageId: string,
  input: ChatAttachmentInput,
): Promise<GenreChatAttachment> {
  const attachmentId = crypto.randomUUID();
  const path = attachmentPath(genreId, threadId, messageId, attachmentId);

  await mkdir(`${genreChatAttachmentsDir(genreId)}/${threadId}/${messageId}`, {
    baseDir: BaseDirectory.Document,
    recursive: true,
  });

  await writeTextFile(path, input.content, { baseDir: BaseDirectory.Document });

  return {
    id: attachmentId,
    name: input.name,
    type: input.type,
    size: new Blob([input.content]).size,
  };
}

export async function loadChatAttachment(
  genreId: string,
  threadId: string,
  messageId: string,
  attachmentId: string,
): Promise<string> {
  const path = attachmentPath(genreId, threadId, messageId, attachmentId);
  return await readTextFile(path, { baseDir: BaseDirectory.Document });
}

export async function deleteChatAttachmentsForMessage(
  genreId: string,
  threadId: string,
  messageId: string,
): Promise<void> {
  const dir = `${genreChatAttachmentsDir(genreId)}/${threadId}/${messageId}`;
  try {
    await remove(dir, { baseDir: BaseDirectory.Document });
  } catch (error) {
    if (error instanceof Error && error.message?.includes("No such file")) {
      return;
    }
    throw error;
  }
}

export async function deleteChatAttachmentsForThread(
  genreId: string,
  threadId: string,
): Promise<void> {
  const dir = `${genreChatAttachmentsDir(genreId)}/${threadId}`;
  try {
    await remove(dir, { baseDir: BaseDirectory.Document });
  } catch (error) {
    if (error instanceof Error && error.message?.includes("No such file")) {
      return;
    }
    throw error;
  }
}

export function detectNovelText(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length < 400) return false;

  const lineCount = trimmed.split(/\r?\n/).length;
  const paragraphCount = trimmed.split(/\r?\n\r?\n/).length;
  const hasDialogue = /[「『"']/.test(trimmed);
  const hasFictionMarkers = /(章|話|幕|場面|登場人物|あらすじ|プロローグ|エピローグ)/.test(trimmed);

  return (
    trimmed.length > 1200 &&
    (lineCount >= 8 || paragraphCount >= 4) &&
    (hasDialogue || hasFictionMarkers)
  );
}

export function detectLongText(content: string): boolean {
  return content.length > 3000;
}

export function extractAttachmentPreview(content: string, maxChars = 500): string {
  const trimmed = content.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}…（後略）`;
}
