import { BaseDirectory, exists, mkdir, readTextFile, remove, writeTextFile } from "@tauri-apps/plugin-fs";
import type { Episode, EpisodeList } from "./schema.ts";
import { isEpisodeList } from "./schema.ts";

const EPISODES_DIR = "episodes";
const EPISODES_FILE = "episodes.json";
const MANUSCRIPT_FILE = "manuscript.md";

function projectPath(projectId: string, ...parts: string[]): string {
  return `phenex/projects/${projectId}/${parts.join("/")}`;
}

function padEpisodeNumber(index: number): string {
  return String(index + 1).padStart(3, "0") + ".md";
}

export async function episodeFileExists(projectId: string): Promise<boolean> {
  return exists(projectPath(projectId, EPISODES_FILE), { baseDir: BaseDirectory.Document });
}

export async function loadEpisodeList(projectId: string): Promise<EpisodeList> {
  try {
    const text = await readTextFile(projectPath(projectId, EPISODES_FILE), {
      baseDir: BaseDirectory.Document,
    });
    const parsed: unknown = JSON.parse(text);
    if (isEpisodeList(parsed)) {
      return parsed;
    }
  } catch {
    // ファイルがない・壊れている場合は空のリストを返す
  }
  return { episodes: [] };
}

export async function saveEpisodeList(projectId: string, list: EpisodeList): Promise<void> {
  await writeTextFile(projectPath(projectId, EPISODES_FILE), JSON.stringify(list, null, 2), {
    baseDir: BaseDirectory.Document,
  });
}

export async function loadEpisode(projectId: string, fileName: string): Promise<string> {
  try {
    return await readTextFile(projectPath(projectId, EPISODES_DIR, fileName), {
      baseDir: BaseDirectory.Document,
    });
  } catch {
    return "";
  }
}

export async function saveEpisode(
  projectId: string,
  fileName: string,
  text: string,
): Promise<void> {
  await writeTextFile(projectPath(projectId, EPISODES_DIR, fileName), text, {
    baseDir: BaseDirectory.Document,
  });
}

export async function createEpisode(projectId: string, title: string): Promise<Episode> {
  const list = await loadEpisodeList(projectId);
  const order = list.episodes.length;
  const fileName = padEpisodeNumber(order);
  const id = crypto.randomUUID();
  const episode: Episode = { id, title, order, fileName };

  const dir = projectPath(projectId, EPISODES_DIR);
  const dirExists = await exists(dir, { baseDir: BaseDirectory.Document });
  if (!dirExists) {
    await mkdir(dir, { baseDir: BaseDirectory.Document, recursive: true });
  }

  await saveEpisode(projectId, fileName, "");
  list.episodes.push(episode);
  await saveEpisodeList(projectId, list);

  return episode;
}

export async function deleteEpisode(projectId: string, episodeId: string): Promise<void> {
  const list = await loadEpisodeList(projectId);
  const index = list.episodes.findIndex((ep) => ep.id === episodeId);
  if (index === -1) return;

  const [removed] = list.episodes.splice(index, 1);
  await remove(projectPath(projectId, EPISODES_DIR, removed.fileName), {
    baseDir: BaseDirectory.Document,
  });

  // order を振り直す
  for (let i = 0; i < list.episodes.length; i++) {
    list.episodes[i].order = i;
  }

  await saveEpisodeList(projectId, list);
}

export async function updateEpisodeTitle(
  projectId: string,
  episodeId: string,
  title: string,
): Promise<void> {
  const list = await loadEpisodeList(projectId);
  const episode = list.episodes.find((ep) => ep.id === episodeId);
  if (!episode) return;
  episode.title = title;
  await saveEpisodeList(projectId, list);
}

export async function migrateFromManuscript(projectId: string): Promise<void> {
  const manuscriptPath = projectPath(projectId, MANUSCRIPT_FILE);
  const hasManuscript = await exists(manuscriptPath, { baseDir: BaseDirectory.Document });
  const hasEpisodes = await episodeFileExists(projectId);
  if (!hasManuscript || hasEpisodes) return;

  const text = await readTextFile(manuscriptPath, { baseDir: BaseDirectory.Document });
  const dir = projectPath(projectId, EPISODES_DIR);
  await mkdir(dir, { baseDir: BaseDirectory.Document, recursive: true });

  const fileName = padEpisodeNumber(0);
  const episode: Episode = {
    id: crypto.randomUUID(),
    title: "第1話",
    order: 0,
    fileName,
  };

  await saveEpisode(projectId, fileName, text);
  await saveEpisodeList(projectId, { episodes: [episode] });
}
