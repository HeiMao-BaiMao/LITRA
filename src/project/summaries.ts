import { BaseDirectory, readTextFile } from "@tauri-apps/plugin-fs";
import { writeDocumentTextFile } from "../sync/webdav.ts";
import type { EpisodeSummary, EpisodeSummaryMap } from "./schema.ts";

const SUMMARIES_FILE = "summaries.json";

function projectPath(projectId: string): string {
  return `litra/projects/${projectId}/${SUMMARIES_FILE}`;
}

function normalizeSummary(summary: Partial<EpisodeSummary>): EpisodeSummary {
  return {
    content: summary.content ?? "",
    oneLiner: summary.oneLiner ?? "",
    updatedAt: summary.updatedAt ?? new Date().toISOString(),
  };
}

export async function loadSummaries(projectId: string): Promise<EpisodeSummaryMap> {
  try {
    const text = await readTextFile(projectPath(projectId), {
      baseDir: BaseDirectory.Document,
    });
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const map = parsed as Partial<EpisodeSummaryMap>;
      const summaries: Record<string, EpisodeSummary> = {};
      for (const [key, value] of Object.entries(map.summaries ?? {})) {
        summaries[key] = normalizeSummary(value as Partial<EpisodeSummary>);
      }
      return { summaries };
    }
  } catch {
    // ファイルがない・壊れている場合は空を返す
  }
  return { summaries: {} };
}

export async function saveSummaries(
  projectId: string,
  map: EpisodeSummaryMap,
): Promise<void> {
  await writeDocumentTextFile(
    projectPath(projectId),
    JSON.stringify(map, null, 2),
  );
}

export async function loadEpisodeSummary(
  projectId: string,
  episodeId: string,
): Promise<EpisodeSummary | undefined> {
  const map = await loadSummaries(projectId);
  return map.summaries[episodeId];
}

export async function saveEpisodeSummary(
  projectId: string,
  episodeId: string,
  content: string,
): Promise<void> {
  const map = await loadSummaries(projectId);
  const existing = map.summaries[episodeId];
  map.summaries[episodeId] = {
    content,
    oneLiner: existing?.oneLiner ?? "",
    updatedAt: new Date().toISOString(),
  };
  await saveSummaries(projectId, map);
}

export async function saveEpisodeOneLiner(
  projectId: string,
  episodeId: string,
  oneLiner: string,
): Promise<void> {
  const map = await loadSummaries(projectId);
  const existing = map.summaries[episodeId];
  map.summaries[episodeId] = {
    content: existing?.content ?? "",
    oneLiner,
    updatedAt: new Date().toISOString(),
  };
  await saveSummaries(projectId, map);
}
