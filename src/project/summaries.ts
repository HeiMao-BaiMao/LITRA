import { BaseDirectory, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type { EpisodeSummary, EpisodeSummaryMap } from "./schema.ts";
import { isEpisodeSummaryMap } from "./schema.ts";

const SUMMARIES_FILE = "summaries.json";

function projectPath(projectId: string): string {
  return `phenex/projects/${projectId}/${SUMMARIES_FILE}`;
}

export async function loadSummaries(projectId: string): Promise<EpisodeSummaryMap> {
  try {
    const text = await readTextFile(projectPath(projectId), {
      baseDir: BaseDirectory.Document,
    });
    const parsed: unknown = JSON.parse(text);
    if (isEpisodeSummaryMap(parsed)) {
      return parsed;
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
  await writeTextFile(
    projectPath(projectId),
    JSON.stringify(map, null, 2),
    { baseDir: BaseDirectory.Document },
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
  map.summaries[episodeId] = {
    content,
    updatedAt: new Date().toISOString(),
  };
  await saveSummaries(projectId, map);
}
