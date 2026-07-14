import { BaseDirectory, readTextFile } from "@tauri-apps/plugin-fs";
import { writeDocumentTextFile } from "../sync/webdav.ts";
import type { AiSettings } from "../settings.ts";

const CACHE_FILE = "ai-cache-observability.json";
const SCHEMA_VERSION = 1;
const MAX_STATS = 5000;
const MAX_ARTIFACTS = 500;

export interface AiCacheStat {
  timestamp: string;
  step: string;
  provider: string;
  model: string;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  hitRate: number;
}

interface CachedArtifact {
  key: string;
  hash: string;
  value: string;
  updatedAt: string;
}

interface CacheDocument {
  schemaVersion: typeof SCHEMA_VERSION;
  stats: AiCacheStat[];
  artifacts: CachedArtifact[];
}

let activeProjectId: string | undefined;
let mutationQueue: Promise<void> = Promise.resolve();

export function setAiCacheProject(projectId: string | undefined): void {
  activeProjectId = projectId;
}

function path(projectId: string): string {
  return `litra/projects/${projectId}/${CACHE_FILE}`;
}

async function loadDocument(projectId: string): Promise<CacheDocument> {
  try {
    const text = await readTextFile(path(projectId), { baseDir: BaseDirectory.Document });
    const parsed = JSON.parse(text) as Partial<CacheDocument>;
    return {
      schemaVersion: SCHEMA_VERSION,
      stats: Array.isArray(parsed.stats) ? parsed.stats : [],
      artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
    };
  } catch {
    return { schemaVersion: SCHEMA_VERSION, stats: [], artifacts: [] };
  }
}

async function mutateDocument(projectId: string, mutate: (document: CacheDocument) => void): Promise<void> {
  mutationQueue = mutationQueue.then(async () => {
    const document = await loadDocument(projectId);
    mutate(document);
    await writeDocumentTextFile(path(projectId), JSON.stringify(document, null, 2));
  }).catch((error) => {
    console.warn("[litra:cache] failed to persist cache observability data", error);
  });
  await mutationQueue;
}

function finiteTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

export function extractDeepSeekCacheTokens(providerMetadata: unknown): { hit: number; miss: number } | undefined {
  if (typeof providerMetadata !== "object" || providerMetadata === null) return undefined;
  const deepseek = (providerMetadata as Record<string, unknown>).deepseek;
  if (typeof deepseek !== "object" || deepseek === null) return undefined;
  const record = deepseek as Record<string, unknown>;
  const hit = finiteTokenCount(record.promptCacheHitTokens);
  const miss = finiteTokenCount(record.promptCacheMissTokens);
  return hit === undefined || miss === undefined ? undefined : { hit, miss };
}

export function recordProviderCacheUsage(
  step: string,
  settings: AiSettings,
  providerMetadata: unknown,
): void {
  const tokens = extractDeepSeekCacheTokens(providerMetadata);
  if (!tokens) return;
  const total = tokens.hit + tokens.miss;
  const stat: AiCacheStat = {
    timestamp: new Date().toISOString(),
    step,
    provider: settings.provider,
    model: settings.model,
    promptCacheHitTokens: tokens.hit,
    promptCacheMissTokens: tokens.miss,
    hitRate: total > 0 ? tokens.hit / total : 0,
  };
  console.log(`[litra:cache] ${step}`, stat);
  const projectId = activeProjectId;
  if (!projectId) return;
  void mutateDocument(projectId, (document) => {
    document.stats.push(stat);
    document.stats = document.stats.slice(-MAX_STATS);
  });
}

export async function loadPersistentAiArtifact(key: string, hash: string): Promise<string | undefined> {
  const projectId = activeProjectId;
  if (!projectId) return undefined;
  await mutationQueue;
  const document = await loadDocument(projectId);
  return document.artifacts.find((artifact) => artifact.key === key && artifact.hash === hash)?.value;
}

export async function savePersistentAiArtifact(key: string, hash: string, value: string): Promise<void> {
  const projectId = activeProjectId;
  if (!projectId) return;
  await mutateDocument(projectId, (document) => {
    document.artifacts = document.artifacts.filter((artifact) => artifact.key !== key);
    document.artifacts.unshift({ key, hash, value, updatedAt: new Date().toISOString() });
    document.artifacts = document.artifacts.slice(0, MAX_ARTIFACTS);
  });
}
