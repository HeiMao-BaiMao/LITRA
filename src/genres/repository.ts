import {
  BaseDirectory,
  exists,
  mkdir,
  readDir,
  readTextFile,
  remove,
  rename,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import {
  GENRE_SCHEMA_VERSION,
  genreIndexSchema,
  genreSchema,
  isGenre,
  isGenreIndex,
} from "./schema.ts";
import type {
  CreateGenreInput,
  Genre,
  GenreIndex,
  GenreIndexEntry,
  UpdateGenreInput,
} from "./schema.ts";

const GENRES_ROOT = "phenex/genres";

export class GenreRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenreRepositoryError";
  }
}

export function genreDir(genreId: string): string {
  return `${GENRES_ROOT}/${genreId}`;
}

export function genreJsonPath(genreId: string): string {
  return `${genreDir(genreId)}/genre.json`;
}

export function genreIndexPath(): string {
  return `${GENRES_ROOT}/index.json`;
}

export function genreSourcesDir(genreId: string): string {
  return `${genreDir(genreId)}/sources`;
}

export function genreAnalysesDir(genreId: string): string {
  return `${genreDir(genreId)}/analyses`;
}

export function genreKnowledgeDir(genreId: string): string {
  return `${genreDir(genreId)}/knowledge`;
}

export function genreChatsDir(genreId: string): string {
  return `${genreDir(genreId)}/chats`;
}

export function genreChatContextDir(genreId: string): string {
  return `${genreChatsDir(genreId)}/context`;
}

export function genreKnowledgeHistoryDir(genreId: string): string {
  return `${genreKnowledgeDir(genreId)}/history`;
}

export function genreSourceSegmentsDir(genreId: string): string {
  return `${genreSourcesDir(genreId)}/segments`;
}

async function ensureGenresRoot(): Promise<void> {
  const rootExists = await exists(GENRES_ROOT, { baseDir: BaseDirectory.Document });
  if (!rootExists) {
    await mkdir(GENRES_ROOT, { baseDir: BaseDirectory.Document, recursive: true });
  }
}

async function ensureGenreDirs(genreId: string): Promise<void> {
  const dirs = [
    genreDir(genreId),
    genreSourcesDir(genreId),
    genreSourceSegmentsDir(genreId),
    genreAnalysesDir(genreId),
    genreKnowledgeDir(genreId),
    genreKnowledgeHistoryDir(genreId),
    genreChatsDir(genreId),
    genreChatContextDir(genreId),
  ];
  for (const dir of dirs) {
    await mkdir(dir, { baseDir: BaseDirectory.Document, recursive: true });
  }
}

async function safeWriteJson(
  path: string,
  value: unknown,
  validator?: (value: unknown) => boolean,
): Promise<void> {
  const json = JSON.stringify(value, null, 2);
  const tmpPath = `${path}.tmp`;

  try {
    await writeTextFile(tmpPath, json, { baseDir: BaseDirectory.Document });

    const reRead = await readTextFile(tmpPath, { baseDir: BaseDirectory.Document });
    const parsed: unknown = JSON.parse(reRead);
    if (validator && !validator(parsed)) {
      throw new GenreRepositoryError(`一時ファイルの検証に失敗しました: ${path}`);
    }

    await rename(tmpPath, path, { oldPathBaseDir: BaseDirectory.Document, newPathBaseDir: BaseDirectory.Document });
  } catch (error) {
    try {
      await remove(tmpPath, { baseDir: BaseDirectory.Document });
    } catch {
      // 一時ファイルが存在しなくても無視
    }
    throw error;
  }
}

async function safeReadJson<T>(
  path: string,
  validator: (value: unknown) => value is T,
  defaultValue: T,
): Promise<T> {
  try {
    const text = await readTextFile(path, { baseDir: BaseDirectory.Document });
    const parsed: unknown = JSON.parse(text);
    if (validator(parsed)) {
      return parsed;
    }
  } catch (error) {
    if (error instanceof Error && error.message?.includes("No such file")) {
      return defaultValue;
    }
    console.warn(`[phenex:genres] failed to read ${path}:`, error);
  }
  return defaultValue;
}

async function loadGenreIndexDocument(): Promise<GenreIndex> {
  return safeReadJson<GenreIndex>(
    genreIndexPath(),
    isGenreIndex,
    { schemaVersion: GENRE_SCHEMA_VERSION, genres: [] },
  );
}

async function saveGenreIndexDocument(index: GenreIndex): Promise<void> {
  await safeWriteJson(genreIndexPath(), index, (value) => isGenreIndex(value));
}

async function updateIndexEntry(
  genre: Genre,
  sourceCount: number,
  acceptedKnowledgeCount: number,
  candidateKnowledgeCount: number,
  chatThreadCount: number,
): Promise<void> {
  const index = await loadGenreIndexDocument();
  const entryIndex = index.genres.findIndex((entry) => entry.id === genre.id);
  const entry: GenreIndexEntry = {
    id: genre.id,
    name: genre.name,
    description: genre.description,
    status: genre.status,
    revision: genre.revision,
    sourceCount,
    acceptedKnowledgeCount,
    candidateKnowledgeCount,
    chatThreadCount,
    createdAt: genre.createdAt,
    updatedAt: genre.updatedAt,
  };

  if (entryIndex >= 0) {
    index.genres[entryIndex] = entry;
  } else {
    index.genres.push(entry);
  }

  await saveGenreIndexDocument(index);
}

async function countSources(genreId: string): Promise<number> {
  try {
    const entries = await readDir(genreSourcesDir(genreId), { baseDir: BaseDirectory.Document });
    return entries.filter((entry) => entry.isFile && entry.name.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

async function countChats(genreId: string): Promise<number> {
  try {
    const entries = await readDir(genreChatsDir(genreId), { baseDir: BaseDirectory.Document });
    return entries.filter((entry) => entry.isFile && entry.name.endsWith(".json") && entry.name !== "index.json").length;
  } catch {
    return 0;
  }
}

async function countKnowledge(genreId: string): Promise<{ items: number; candidates: number }> {
  try {
    const text = await readTextFile(`${genreKnowledgeDir(genreId)}/current.json`, {
      baseDir: BaseDirectory.Document,
    });
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "items" in parsed &&
      "candidates" in parsed &&
      Array.isArray(parsed.items) &&
      Array.isArray(parsed.candidates)
    ) {
      return { items: parsed.items.length, candidates: parsed.candidates.length };
    }
  } catch {
    // ignore
  }
  return { items: 0, candidates: 0 };
}

export async function rebuildGenreIndexEntry(genreId: string): Promise<void> {
  const genre = await loadGenre(genreId);
  const sourceCount = await countSources(genreId);
  const chatThreadCount = await countChats(genreId);
  const knowledge = await countKnowledge(genreId);
  await updateIndexEntry(
    genre,
    sourceCount,
    knowledge.items,
    knowledge.candidates,
    chatThreadCount,
  );
}

export async function listGenres(): Promise<GenreIndexEntry[]> {
  await ensureGenresRoot();
  const index = await loadGenreIndexDocument();
  return index.genres
    .filter((entry) => entry.status !== "archived")
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export async function loadGenre(genreId: string): Promise<Genre> {
  const text = await readTextFile(genreJsonPath(genreId), { baseDir: BaseDirectory.Document });
  const parsed: unknown = JSON.parse(text);
  if (!isGenre(parsed)) {
    throw new GenreRepositoryError(`ジャンル ${genreId} のメタデータが不正です。`);
  }
  return parsed;
}

export async function createGenre(input: CreateGenreInput): Promise<Genre> {
  await ensureGenresRoot();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const genre: Genre = {
    schemaVersion: GENRE_SCHEMA_VERSION,
    id,
    name: input.name,
    aliases: [],
    description: input.description ?? "",
    userDefinition: "",
    notes: "",
    tags: [],
    status: "active",
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };

  await ensureGenreDirs(id);
  await safeWriteJson(genreJsonPath(id), genre, (value) => isGenre(value));
  await safeWriteJson(
    `${genreSourcesDir(id)}/index.json`,
    { schemaVersion: GENRE_SCHEMA_VERSION, sources: [] },
    (value) => typeof value === "object" && value !== null && Array.isArray((value as { sources?: unknown }).sources),
  );
  await safeWriteJson(
    `${genreAnalysesDir(id)}/index.json`,
    { schemaVersion: GENRE_SCHEMA_VERSION, runs: [] },
    (value) => typeof value === "object" && value !== null && Array.isArray((value as { runs?: unknown }).runs),
  );
  await safeWriteJson(
    `${genreKnowledgeDir(id)}/current.json`,
    {
      schemaVersion: GENRE_SCHEMA_VERSION,
      genreId: id,
      revision: 0,
      items: [],
      candidates: [],
      updatedAt: now,
    },
    (value) => typeof value === "object" && value !== null && Array.isArray((value as { items?: unknown }).items),
  );
  await safeWriteJson(
    `${genreChatsDir(id)}/index.json`,
    { schemaVersion: GENRE_SCHEMA_VERSION, threads: [] },
    (value) => typeof value === "object" && value !== null && Array.isArray((value as { threads?: unknown }).threads),
  );

  await updateIndexEntry(genre, 0, 0, 0, 0);
  return genre;
}

export async function updateGenre(
  genreId: string,
  input: UpdateGenreInput,
  expectedRevision?: number,
): Promise<Genre> {
  const genre = await loadGenre(genreId);
  if (expectedRevision !== undefined && genre.revision !== expectedRevision) {
    throw new GenreRepositoryError(
      `改訂番号が一致しません。読込時: ${expectedRevision}, 現在: ${genre.revision}`,
    );
  }

  const updated: Genre = {
    ...genre,
    ...(input.name !== undefined && { name: input.name }),
    ...(input.aliases !== undefined && { aliases: input.aliases }),
    ...(input.description !== undefined && { description: input.description }),
    ...(input.userDefinition !== undefined && { userDefinition: input.userDefinition }),
    ...(input.notes !== undefined && { notes: input.notes }),
    ...(input.tags !== undefined && { tags: input.tags }),
    ...(input.status !== undefined && { status: input.status }),
    updatedAt: new Date().toISOString(),
  };

  await safeWriteJson(genreJsonPath(genreId), updated, (value) => isGenre(value));

  const sourceCount = await countSources(genreId);
  const chatThreadCount = await countChats(genreId);
  const knowledge = await countKnowledge(genreId);
  await updateIndexEntry(updated, sourceCount, knowledge.items, knowledge.candidates, chatThreadCount);

  return updated;
}

export async function deleteGenre(genreId: string): Promise<void> {
  await remove(genreDir(genreId), { baseDir: BaseDirectory.Document, recursive: true });
  const index = await loadGenreIndexDocument();
  index.genres = index.genres.filter((entry) => entry.id !== genreId);
  await saveGenreIndexDocument(index);
}

export async function ensureGenreDataDirs(genreId: string): Promise<void> {
  await ensureGenreDirs(genreId);
}
