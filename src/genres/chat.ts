import { BaseDirectory, readTextFile, writeTextFile, remove } from "@tauri-apps/plugin-fs";
import {
  GENRE_SCHEMA_VERSION,
  genreChatDocumentSchema,
  genreChatThreadListDocumentSchema,
} from "./schema.ts";
import type {
  GenreChatDocument,
  GenreChatMessage,
  GenreChatThread,
  GenreChatThreadListDocument,
} from "./schema.ts";
import {
  genreChatsDir,
  genreChatContextDir,
  GenreRepositoryError,
  ensureGenreDataDirs,
  rebuildGenreIndexEntry,
} from "./repository.ts";

async function loadThreadListDocument(
  genreId: string,
): Promise<GenreChatThreadListDocument> {
  try {
    const text = await readTextFile(`${genreChatsDir(genreId)}/index.json`, {
      baseDir: BaseDirectory.Document,
    });
    const parsed: unknown = JSON.parse(text);
    const result = genreChatThreadListDocumentSchema.safeParse(parsed);
    if (result.success) return result.data;
  } catch (error) {
    if (error instanceof Error && error.message?.includes("No such file")) {
      return { schemaVersion: GENRE_SCHEMA_VERSION, threads: [] };
    }
    console.warn(`[phenex:genres] failed to load chat thread list for ${genreId}:`, error);
  }
  return { schemaVersion: GENRE_SCHEMA_VERSION, threads: [] };
}

async function saveThreadListDocument(
  genreId: string,
  document: GenreChatThreadListDocument,
): Promise<void> {
  await ensureGenreDataDirs(genreId);
  await writeTextFile(
    `${genreChatsDir(genreId)}/index.json`,
    JSON.stringify(document, null, 2),
    { baseDir: BaseDirectory.Document },
  );
}

export async function listGenreChatThreads(genreId: string): Promise<GenreChatThread[]> {
  const document = await loadThreadListDocument(genreId);
  return document.threads
    .filter((thread) => thread.status !== "archived")
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export async function createGenreChatThread(
  genreId: string,
  title?: string,
): Promise<GenreChatThread> {
  await ensureGenreDataDirs(genreId);
  const now = new Date().toISOString();
  const thread: GenreChatThread = {
    id: crypto.randomUUID(),
    genreId,
    title: title ?? "新しいチャット",
    summary: "",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };

  const document: GenreChatDocument = {
    schemaVersion: GENRE_SCHEMA_VERSION,
    thread,
    messages: [],
  };

  await writeTextFile(
    `${genreChatsDir(genreId)}/${thread.id}.json`,
    JSON.stringify(document, null, 2),
    { baseDir: BaseDirectory.Document },
  );

  const list = await loadThreadListDocument(genreId);
  list.threads.push(thread);
  await saveThreadListDocument(genreId, list);
  await rebuildGenreIndexEntry(genreId);

  return thread;
}

export async function loadGenreChatThread(
  genreId: string,
  threadId: string,
): Promise<GenreChatDocument> {
  const text = await readTextFile(`${genreChatsDir(genreId)}/${threadId}.json`, {
    baseDir: BaseDirectory.Document,
  });
  const parsed: unknown = JSON.parse(text);
  const result = genreChatDocumentSchema.safeParse(parsed);
  if (!result.success) {
    throw new GenreRepositoryError(`チャットスレッド ${threadId} の形式が不正です。`);
  }
  return result.data;
}

export async function saveGenreChatThread(
  genreId: string,
  document: GenreChatDocument,
): Promise<void> {
  await ensureGenreDataDirs(genreId);
  const validated = genreChatDocumentSchema.parse(document);
  await writeTextFile(
    `${genreChatsDir(genreId)}/${document.thread.id}.json`,
    JSON.stringify(validated, null, 2),
    { baseDir: BaseDirectory.Document },
  );

  const list = await loadThreadListDocument(genreId);
  const index = list.threads.findIndex((t) => t.id === document.thread.id);
  if (index >= 0) {
    list.threads[index] = document.thread;
  } else {
    list.threads.push(document.thread);
  }
  await saveThreadListDocument(genreId, list);
  await rebuildGenreIndexEntry(genreId);
}

export async function deleteGenreChatThread(
  genreId: string,
  threadId: string,
): Promise<void> {
  await remove(`${genreChatsDir(genreId)}/${threadId}.json`, {
    baseDir: BaseDirectory.Document,
  });

  const list = await loadThreadListDocument(genreId);
  list.threads = list.threads.filter((t) => t.id !== threadId);
  await saveThreadListDocument(genreId, list);
  await rebuildGenreIndexEntry(genreId);
}

export async function updateThreadTitle(
  genreId: string,
  threadId: string,
  title: string,
): Promise<GenreChatThread> {
  const document = await loadGenreChatThread(genreId, threadId);
  document.thread.title = title;
  document.thread.updatedAt = new Date().toISOString();
  await saveGenreChatThread(genreId, document);
  return document.thread;
}

export async function archiveThread(genreId: string, threadId: string): Promise<GenreChatThread> {
  const document = await loadGenreChatThread(genreId, threadId);
  document.thread.status = "archived";
  document.thread.updatedAt = new Date().toISOString();
  await saveGenreChatThread(genreId, document);
  return document.thread;
}

export async function saveContextSnapshot(
  genreId: string,
  _threadId: string,
  snapshot: import("./schema.ts").GenreChatContextSnapshot,
): Promise<void> {
  await ensureGenreDataDirs(genreId);
  await writeTextFile(
    `${genreChatContextDir(genreId)}/${snapshot.id}.json`,
    JSON.stringify(snapshot, null, 2),
    { baseDir: BaseDirectory.Document },
  );
}

export function appendMessage(
  document: GenreChatDocument,
  message: Omit<GenreChatMessage, "id" | "createdAt">,
): GenreChatDocument {
  const now = new Date().toISOString();
  const newMessage: GenreChatMessage = {
    ...message,
    id: `${now}-${crypto.randomUUID()}`,
    createdAt: now,
  };
  return {
    ...document,
    messages: [...document.messages, newMessage],
    thread: {
      ...document.thread,
      updatedAt: now,
    },
  };
}
