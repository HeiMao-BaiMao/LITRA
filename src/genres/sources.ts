import {
  BaseDirectory,
  exists,
  readTextFile,
} from "@tauri-apps/plugin-fs";
import { removeDocumentPath, writeDocumentTextFile } from "../sync/webdav.ts";
import { computeTextHash } from "./hash.ts";
import { segmentSourceText } from "./segmentation.ts";
import {
  GENRE_SCHEMA_VERSION,
  genreSourceListDocumentSchema,
} from "./schema.ts";
import type {
  CreateGenreSourceInput,
  GenreSource,
  GenreSourceListDocument,
  GenreSourceSegment,
  UpdateGenreSourceInput,
} from "./schema.ts";
import {
  genreSourceSegmentsDir,
  genreSourcesDir,
  GenreRepositoryError,
  ensureGenreDataDirs,
  rebuildGenreIndexEntry,
} from "./repository.ts";

async function loadSourceListDocument(genreId: string): Promise<GenreSourceListDocument> {
  try {
    const text = await readTextFile(`${genreSourcesDir(genreId)}/index.json`, {
      baseDir: BaseDirectory.Document,
    });
    const parsed: unknown = JSON.parse(text);
    const result = genreSourceListDocumentSchema.safeParse(parsed);
    if (result.success) return result.data;
  } catch (error) {
    if (error instanceof Error && error.message?.includes("No such file")) {
      return { schemaVersion: GENRE_SCHEMA_VERSION, sources: [] };
    }
    console.warn(`[litra:genres] failed to load source list for ${genreId}:`, error);
  }
  return { schemaVersion: GENRE_SCHEMA_VERSION, sources: [] };
}

async function saveSourceListDocument(
  genreId: string,
  document: GenreSourceListDocument,
): Promise<void> {
  await ensureGenreDataDirs(genreId);
  await writeDocumentTextFile(
    `${genreSourcesDir(genreId)}/index.json`,
    JSON.stringify(document, null, 2),
  );
}

async function loadSegmentDocument(
  genreId: string,
  sourceId: string,
): Promise<{ schemaVersion: number; sourceId: string; segments: GenreSourceSegment[] }> {
  try {
    const text = await readTextFile(`${genreSourceSegmentsDir(genreId)}/${sourceId}.json`, {
      baseDir: BaseDirectory.Document,
    });
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "sourceId" in parsed &&
      "segments" in parsed &&
      Array.isArray(parsed.segments)
    ) {
      return parsed as { schemaVersion: number; sourceId: string; segments: GenreSourceSegment[] };
    }
  } catch {
    // ignore
  }
  return { schemaVersion: GENRE_SCHEMA_VERSION, sourceId, segments: [] };
}

async function saveSegmentDocument(
  genreId: string,
  sourceId: string,
  segments: GenreSourceSegment[],
): Promise<void> {
  await ensureGenreDataDirs(genreId);
  await writeDocumentTextFile(
    `${genreSourceSegmentsDir(genreId)}/${sourceId}.json`,
    JSON.stringify({ schemaVersion: GENRE_SCHEMA_VERSION, sourceId, segments }, null, 2),
  );
}

export async function listGenreSources(genreId: string): Promise<GenreSource[]> {
  const document = await loadSourceListDocument(genreId);
  return document.sources.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

export interface GenreSourceWithContent {
  metadata: GenreSource;
  content: string;
  segments: GenreSourceSegment[];
}

export async function loadGenreSource(
  genreId: string,
  sourceId: string,
): Promise<GenreSourceWithContent> {
  const document = await loadSourceListDocument(genreId);
  const metadata = document.sources.find((source) => source.id === sourceId);
  if (!metadata) {
    throw new GenreRepositoryError(`資料 ${sourceId} が見つかりません。`);
  }

  const content = await readTextFile(`${genreSourcesDir(genreId)}/${sourceId}.md`, {
    baseDir: BaseDirectory.Document,
  });
  const segmentDocument = await loadSegmentDocument(genreId, sourceId);
  return { metadata, content, segments: segmentDocument.segments };
}

export async function createGenreSource(
  genreId: string,
  input: CreateGenreSourceInput,
): Promise<GenreSourceWithContent> {
  await ensureGenreDataDirs(genreId);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const contentHash = await computeTextHash(input.content);
  const segments = await segmentSourceText(id, input.content);

  const metadata: GenreSource = {
    id,
    genreId,
    title: input.title,
    author: input.author ?? "",
    sourceType: input.sourceType ?? "other",
    sourceRole: input.sourceRole ?? "partial_example",
    preference: input.preference ?? "neutral",
    sourceNote: "",
    userInterpretation: "",
    originalFileName: input.originalFileName,
    mediaType: "text/markdown",
    language: "ja",
    contentFileName: `${id}.md`,
    contentHash,
    characterCount: input.content.length,
    segmentCount: segments.length,
    analysisStatus: "not_analyzed",
    createdAt: now,
    updatedAt: now,
  };

  await writeDocumentTextFile(
    `${genreSourcesDir(genreId)}/${id}.md`,
    input.content,
  );
  await saveSegmentDocument(genreId, id, segments);

  const document = await loadSourceListDocument(genreId);
  document.sources.push(metadata);
  await saveSourceListDocument(genreId, document);
  await rebuildGenreIndexEntry(genreId);

  return { metadata, content: input.content, segments };
}

export async function updateGenreSource(
  genreId: string,
  sourceId: string,
  input: UpdateGenreSourceInput,
): Promise<GenreSourceWithContent> {
  const document = await loadSourceListDocument(genreId);
  const index = document.sources.findIndex((source) => source.id === sourceId);
  if (index === -1) {
    throw new GenreRepositoryError(`資料 ${sourceId} が見つかりません。`);
  }

  const existing = document.sources[index];
  let content = input.content;
  if (content === undefined) {
    content = await readTextFile(`${genreSourcesDir(genreId)}/${sourceId}.md`, {
      baseDir: BaseDirectory.Document,
    });
  }

  const contentHash = await computeTextHash(content);
  const contentChanged = contentHash !== existing.contentHash;
  const segments = contentChanged ? await segmentSourceText(sourceId, content) : (await loadSegmentDocument(genreId, sourceId)).segments;

  const updated: GenreSource = {
    ...existing,
    ...(input.title !== undefined && { title: input.title }),
    ...(input.author !== undefined && { author: input.author }),
    ...(input.sourceType !== undefined && { sourceType: input.sourceType }),
    ...(input.sourceRole !== undefined && { sourceRole: input.sourceRole }),
    ...(input.preference !== undefined && { preference: input.preference }),
    ...(input.sourceNote !== undefined && { sourceNote: input.sourceNote }),
    ...(input.userInterpretation !== undefined && { userInterpretation: input.userInterpretation }),
    contentHash,
    characterCount: content.length,
    segmentCount: segments.length,
    analysisStatus: contentChanged && existing.analysisStatus === "completed" ? "stale" : existing.analysisStatus,
    updatedAt: new Date().toISOString(),
  };

  await writeDocumentTextFile(
    `${genreSourcesDir(genreId)}/${sourceId}.md`,
    content,
  );
  await saveSegmentDocument(genreId, sourceId, segments);

  document.sources[index] = updated;
  await saveSourceListDocument(genreId, document);
  await rebuildGenreIndexEntry(genreId);

  return { metadata: updated, content, segments };
}

export async function deleteGenreSource(genreId: string, sourceId: string): Promise<void> {
  const document = await loadSourceListDocument(genreId);
  document.sources = document.sources.filter((source) => source.id !== sourceId);
  await saveSourceListDocument(genreId, document);

  try {
    await removeDocumentPath(`${genreSourcesDir(genreId)}/${sourceId}.md`);
  } catch {
    // ignore
  }
  try {
    await removeDocumentPath(`${genreSourceSegmentsDir(genreId)}/${sourceId}.json`);
  } catch {
    // ignore
  }

  await rebuildGenreIndexEntry(genreId);
}

export async function sourceExists(genreId: string, sourceId: string): Promise<boolean> {
  return exists(`${genreSourcesDir(genreId)}/${sourceId}.md`, { baseDir: BaseDirectory.Document });
}
