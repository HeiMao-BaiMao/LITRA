import { BaseDirectory, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type { EpisodeMemo, EpisodeMemoMap } from "./schema.ts";
import { isEpisodeMemoMap } from "./schema.ts";

const MEMOS_FILE = "memos.json";

function projectPath(projectId: string): string {
  return `litra/projects/${projectId}/${MEMOS_FILE}`;
}

export async function loadMemos(projectId: string): Promise<EpisodeMemoMap> {
  try {
    const text = await readTextFile(projectPath(projectId), {
      baseDir: BaseDirectory.Document,
    });
    const parsed: unknown = JSON.parse(text);
    if (isEpisodeMemoMap(parsed)) {
      return parsed;
    }
  } catch {
    // ファイルがない・壊れている場合は空を返す
  }
  return { memos: {} };
}

export async function saveMemos(
  projectId: string,
  map: EpisodeMemoMap,
): Promise<void> {
  await writeTextFile(
    projectPath(projectId),
    JSON.stringify(map, null, 2),
    { baseDir: BaseDirectory.Document },
  );
}

export async function loadEpisodeMemo(
  projectId: string,
  episodeId: string,
): Promise<EpisodeMemo | undefined> {
  const map = await loadMemos(projectId);
  return map.memos[episodeId];
}

export async function saveEpisodeMemo(
  projectId: string,
  episodeId: string,
  content: string,
): Promise<void> {
  const map = await loadMemos(projectId);
  map.memos[episodeId] = {
    content,
    updatedAt: new Date().toISOString(),
  };
  await saveMemos(projectId, map);
}
