import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import {
  GENRE_SCHEMA_VERSION,
  genreKnowledgeDocumentSchema,
  genreKnowledgeItemSchema,
} from "./schema.ts";
import type {
  CreateGenreKnowledgeItemInput,
  GenreEvidenceReference,
  GenreKnowledgeCandidate,
  GenreKnowledgeDocument,
  GenreKnowledgeItem,
  UpdateGenreKnowledgeItemInput,
} from "./schema.ts";
import {
  genreKnowledgeDir,
  genreKnowledgeHistoryDir,
  GenreRepositoryError,
  ensureGenreDataDirs,
  rebuildGenreIndexEntry,
} from "./repository.ts";

async function loadKnowledgeDocument(genreId: string): Promise<GenreKnowledgeDocument> {
  try {
    const text = await readTextFile(`${genreKnowledgeDir(genreId)}/current.json`, {
      baseDir: BaseDirectory.Document,
    });
    const parsed: unknown = JSON.parse(text);
    const result = genreKnowledgeDocumentSchema.safeParse(parsed);
    if (result.success) return result.data;
  } catch (error) {
    if (error instanceof Error && error.message?.includes("No such file")) {
      return {
        schemaVersion: GENRE_SCHEMA_VERSION,
        genreId,
        revision: 0,
        items: [],
        candidates: [],
        updatedAt: new Date().toISOString(),
      };
    }
    console.warn(`[phenex:genres] failed to load knowledge for ${genreId}:`, error);
  }
  return {
    schemaVersion: GENRE_SCHEMA_VERSION,
    genreId,
    revision: 0,
    items: [],
    candidates: [],
    updatedAt: new Date().toISOString(),
  };
}

async function saveKnowledgeDocument(
  genreId: string,
  document: GenreKnowledgeDocument,
): Promise<void> {
  await ensureGenreDataDirs(genreId);
  const validated = genreKnowledgeDocumentSchema.parse(document);
  await writeTextFile(
    `${genreKnowledgeDir(genreId)}/current.json`,
    JSON.stringify(validated, null, 2),
    { baseDir: BaseDirectory.Document },
  );
}

async function snapshotKnowledge(
  genreId: string,
  document: GenreKnowledgeDocument,
): Promise<void> {
  await ensureGenreDataDirs(genreId);
  const snapshot = {
    schemaVersion: GENRE_SCHEMA_VERSION,
    genreId,
    revision: document.revision,
    items: document.items,
    createdAt: new Date().toISOString(),
  };
  await writeTextFile(
    `${genreKnowledgeHistoryDir(genreId)}/${document.revision}.json`,
    JSON.stringify(snapshot, null, 2),
    { baseDir: BaseDirectory.Document },
  );
}

async function bumpRevision(document: GenreKnowledgeDocument): Promise<GenreKnowledgeDocument> {
  const next = {
    ...document,
    revision: document.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  await snapshotKnowledge(document.genreId, next);
  return next;
}

export async function loadGenreKnowledge(genreId: string): Promise<GenreKnowledgeDocument> {
  return loadKnowledgeDocument(genreId);
}

export async function createKnowledgeCandidate(
  genreId: string,
  candidate: Omit<GenreKnowledgeCandidate, "id" | "genreId" | "status" | "createdAt" | "updatedAt">,
): Promise<GenreKnowledgeCandidate> {
  const now = new Date().toISOString();
  const newCandidate: GenreKnowledgeCandidate = {
    ...candidate,
    id: crypto.randomUUID(),
    genreId,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };

  const document = await loadKnowledgeDocument(genreId);
  document.candidates.push(newCandidate);
  await saveKnowledgeDocument(genreId, document);
  await rebuildGenreIndexEntry(genreId);
  return newCandidate;
}

export async function acceptKnowledgeCandidate(
  genreId: string,
  candidateId: string,
  edits?: Partial<GenreKnowledgeItem>,
): Promise<GenreKnowledgeItem> {
  const document = await loadKnowledgeDocument(genreId);
  const candidateIndex = document.candidates.findIndex((c) => c.id === candidateId);
  if (candidateIndex === -1) {
    throw new GenreRepositoryError(`知識候補 ${candidateId} が見つかりません。`);
  }

  const candidate = document.candidates[candidateIndex];
  const now = new Date().toISOString();

  const item: GenreKnowledgeItem = {
    id: crypto.randomUUID(),
    genreId,
    category: edits?.category ?? candidate.category,
    title: edits?.title ?? candidate.title,
    statement: edits?.statement ?? candidate.statement,
    explanation: edits?.explanation ?? candidate.explanation,
    importance:
      edits?.importance ??
      (candidate.proposedImportance === "work_specific" ? "optional" : candidate.proposedImportance),
    status: edits?.status ?? "active",
    confidence: edits?.confidence ?? candidate.confidence,
    authority: candidate.createdBy === "user" ? "user_explicit" : "user_approved_ai",
    sourceReferences: edits?.sourceReferences ?? candidate.sourceReferences,
    chatReferences: edits?.chatReferences ?? candidate.chatReferences,
    createdFromCandidateId: candidate.id,
    createdAt: now,
    updatedAt: now,
  };

  const validatedItem = genreKnowledgeItemSchema.parse(item);
  document.items.push(validatedItem);
  document.candidates[candidateIndex] = { ...candidate, status: "accepted", updatedAt: now };

  const bumped = await bumpRevision(document);
  await saveKnowledgeDocument(genreId, bumped);
  await rebuildGenreIndexEntry(genreId);

  return validatedItem;
}

export async function rejectKnowledgeCandidate(
  genreId: string,
  candidateId: string,
  reason?: string,
): Promise<void> {
  const document = await loadKnowledgeDocument(genreId);
  const candidate = document.candidates.find((c) => c.id === candidateId);
  if (!candidate) {
    throw new GenreRepositoryError(`知識候補 ${candidateId} が見つかりません。`);
  }

  candidate.status = "rejected";
  candidate.explanation = reason ? `${candidate.explanation}\n\n【却下理由】\n${reason}` : candidate.explanation;
  candidate.updatedAt = new Date().toISOString();

  await saveKnowledgeDocument(genreId, document);
  await rebuildGenreIndexEntry(genreId);
}

export async function holdKnowledgeCandidate(
  genreId: string,
  candidateId: string,
): Promise<void> {
  const document = await loadKnowledgeDocument(genreId);
  const candidate = document.candidates.find((c) => c.id === candidateId);
  if (!candidate) {
    throw new GenreRepositoryError(`知識候補 ${candidateId} が見つかりません。`);
  }

  candidate.status = "on_hold";
  candidate.updatedAt = new Date().toISOString();

  await saveKnowledgeDocument(genreId, document);
}

export async function createKnowledgeItem(
  genreId: string,
  input: CreateGenreKnowledgeItemInput,
): Promise<GenreKnowledgeItem> {
  const now = new Date().toISOString();
  const item: GenreKnowledgeItem = {
    id: crypto.randomUUID(),
    genreId,
    category: input.category,
    title: input.title,
    statement: input.statement,
    explanation: input.explanation ?? "",
    importance: input.importance ?? "optional",
    status: "active",
    confidence: 1,
    authority: "user_explicit",
    sourceReferences: input.sourceReferences ?? [],
    chatReferences: input.chatReferences ?? [],
    createdAt: now,
    updatedAt: now,
  };

  const validatedItem = genreKnowledgeItemSchema.parse(item);
  const document = await loadKnowledgeDocument(genreId);
  document.items.push(validatedItem);

  const bumped = await bumpRevision(document);
  await saveKnowledgeDocument(genreId, bumped);
  await rebuildGenreIndexEntry(genreId);

  return validatedItem;
}

export async function updateKnowledgeItem(
  genreId: string,
  itemId: string,
  input: UpdateGenreKnowledgeItemInput,
): Promise<GenreKnowledgeItem> {
  const document = await loadKnowledgeDocument(genreId);
  const index = document.items.findIndex((item) => item.id === itemId);
  if (index === -1) {
    throw new GenreRepositoryError(`知識 ${itemId} が見つかりません。`);
  }

  const existing = document.items[index];
  const updated: GenreKnowledgeItem = {
    ...existing,
    ...(input.category !== undefined && { category: input.category }),
    ...(input.title !== undefined && { title: input.title }),
    ...(input.statement !== undefined && { statement: input.statement }),
    ...(input.explanation !== undefined && { explanation: input.explanation }),
    ...(input.importance !== undefined && { importance: input.importance }),
    ...(input.status !== undefined && { status: input.status }),
    ...(input.sourceReferences !== undefined && { sourceReferences: input.sourceReferences }),
    ...(input.chatReferences !== undefined && { chatReferences: input.chatReferences }),
    updatedAt: new Date().toISOString(),
  };

  document.items[index] = genreKnowledgeItemSchema.parse(updated);

  const bumped = await bumpRevision(document);
  await saveKnowledgeDocument(genreId, bumped);
  await rebuildGenreIndexEntry(genreId);

  return document.items[index];
}

export async function disableKnowledgeItem(genreId: string, itemId: string): Promise<GenreKnowledgeItem> {
  return updateKnowledgeItem(genreId, itemId, { status: "disabled" });
}

export async function enableKnowledgeItem(genreId: string, itemId: string): Promise<GenreKnowledgeItem> {
  return updateKnowledgeItem(genreId, itemId, { status: "active" });
}

export async function deleteKnowledgeItem(genreId: string, itemId: string): Promise<void> {
  const document = await loadKnowledgeDocument(genreId);
  document.items = document.items.filter((item) => item.id !== itemId);

  const bumped = await bumpRevision(document);
  await saveKnowledgeDocument(genreId, bumped);
  await rebuildGenreIndexEntry(genreId);
}

export async function mergeCandidateIntoItem(
  genreId: string,
  candidateId: string,
  targetItemId: string,
  mergedStatement?: string,
  mergedExplanation?: string,
): Promise<GenreKnowledgeItem> {
  const document = await loadKnowledgeDocument(genreId);
  const candidate = document.candidates.find((c) => c.id === candidateId);
  const targetIndex = document.items.findIndex((item) => item.id === targetItemId);

  if (!candidate) {
    throw new GenreRepositoryError(`知識候補 ${candidateId} が見つかりません。`);
  }
  if (targetIndex === -1) {
    throw new GenreRepositoryError(`知識 ${targetItemId} が見つかりません。`);
  }

  const target = document.items[targetIndex];
  const now = new Date().toISOString();

  const updated: GenreKnowledgeItem = {
    ...target,
    statement: mergedStatement ?? `${target.statement}\n\n${candidate.statement}`,
    explanation: mergedExplanation ?? `${target.explanation}\n\n【統合元候補】\n${candidate.explanation}`,
    sourceReferences: [...target.sourceReferences, ...candidate.sourceReferences],
    chatReferences: [...target.chatReferences, ...candidate.chatReferences],
    updatedAt: now,
  };

  document.items[targetIndex] = genreKnowledgeItemSchema.parse(updated);
  candidate.status = "merged";
  candidate.updatedAt = now;

  const bumped = await bumpRevision(document);
  await saveKnowledgeDocument(genreId, bumped);
  await rebuildGenreIndexEntry(genreId);

  return document.items[targetIndex];
}

export function buildKnowledgeContext(
  document: GenreKnowledgeDocument,
  includeDisabled = false,
  includePendingCandidates = false,
): { accepted: GenreKnowledgeItem[]; candidates: GenreKnowledgeCandidate[] } {
  const accepted = document.items.filter((item) => includeDisabled || item.status === "active");
  const candidates = includePendingCandidates
    ? document.candidates.filter((c) => c.status === "pending")
    : [];
  return { accepted, candidates };
}
