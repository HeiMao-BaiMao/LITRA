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
  return `${String(index + 1).padStart(3, "0")}.md`;
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
  return (await tryLoadEpisode(projectId, fileName)) ?? "";
}

async function tryLoadEpisode(projectId: string, fileName: string): Promise<string | undefined> {
  try {
    return await readTextFile(projectPath(projectId, EPISODES_DIR, fileName), {
      baseDir: BaseDirectory.Document,
    });
  } catch {
    return undefined;
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

function episodeFileName(episodeId: string): string {
  return `${episodeId}.md`;
}

async function loadEpisodeForReindex(
  projectId: string,
  episode: Episode,
  newIndex: number,
): Promise<{ text: string; sourceFileName: string }> {
  const candidates = [
    episode.fileName,
    episodeFileName(episode.id),
    padEpisodeNumber(episode.order),
    padEpisodeNumber(newIndex),
  ].filter(
    (fileName, index, self) => fileName && self.indexOf(fileName) === index,
  );

  let emptyCandidate: { text: string; sourceFileName: string } | null = null;
  for (const fileName of candidates) {
    const text = await tryLoadEpisode(projectId, fileName);
    if (text === undefined) continue;
    if (text.length > 0) {
      if (fileName !== episode.fileName) {
        console.warn(
          `[phenex] recovered episode text for ${episode.id} from ${fileName}; listed file was ${episode.fileName}`,
        );
      }
      return { text, sourceFileName: fileName };
    }
    emptyCandidate ??= { text, sourceFileName: fileName };
  }

  if (emptyCandidate) return emptyCandidate;
  throw new Error(
    `Episode file is missing: ${episode.title || episode.id} (${candidates.join(", ")})`,
  );
}

export async function createEpisode(projectId: string, title: string): Promise<Episode> {
  const list = await loadEpisodeList(projectId);
  const order = list.episodes.length;
  const id = crypto.randomUUID();
  const fileName = episodeFileName(id);
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

async function reindexEpisodes(projectId: string, list: EpisodeList): Promise<void> {
  // 書き換え前に全本文を読み込んでおく。逐次リネームすると、
  // まだ処理していないエピソードのファイル名を上書きして本文が失われる恐れがある。
  const texts = new Map<string, { text: string; sourceFileName: string }>();
  for (let i = 0; i < list.episodes.length; i++) {
    const ep = list.episodes[i];
    texts.set(ep.id, await loadEpisodeForReindex(projectId, ep, i));
  }

  const oldFileNames = list.episodes.map((ep) => ep.fileName);

  for (let i = 0; i < list.episodes.length; i++) {
    const ep = list.episodes[i];
    const newFileName = episodeFileName(ep.id);
    const loaded = texts.get(ep.id);
    if (ep.fileName !== newFileName || loaded?.sourceFileName !== newFileName) {
      await saveEpisode(projectId, newFileName, loaded?.text ?? "");
      ep.fileName = newFileName;
    }
    ep.order = i;
  }

  for (const oldFileName of oldFileNames) {
    const stillUsed = list.episodes.some((ep) => ep.fileName === oldFileName);
    if (!stillUsed) {
      await remove(projectPath(projectId, EPISODES_DIR, oldFileName), {
        baseDir: BaseDirectory.Document,
      });
    }
  }
}

export async function moveEpisode(
  projectId: string,
  episodeId: string,
  direction: "up" | "down",
): Promise<void> {
  const list = await loadEpisodeList(projectId);
  const index = list.episodes.findIndex((ep) => ep.id === episodeId);
  if (index === -1) return;

  const targetIndex = direction === "up" ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= list.episodes.length) return;

  const [moved] = list.episodes.splice(index, 1);
  list.episodes.splice(targetIndex, 0, moved);

  await reindexEpisodes(projectId, list);
  await saveEpisodeList(projectId, list);
}

export async function moveEpisodeToIndex(
  projectId: string,
  fromIndex: number,
  toIndex: number,
): Promise<void> {
  const list = await loadEpisodeList(projectId);
  if (
    fromIndex < 0 ||
    fromIndex >= list.episodes.length ||
    toIndex < 0 ||
    toIndex >= list.episodes.length ||
    fromIndex === toIndex
  ) {
    return;
  }

  const [moved] = list.episodes.splice(fromIndex, 1);
  list.episodes.splice(toIndex, 0, moved);

  await reindexEpisodes(projectId, list);
  await saveEpisodeList(projectId, list);
}

export async function reorderEpisodes(
  projectId: string,
  orderedIds: string[],
): Promise<void> {
  const list = await loadEpisodeList(projectId);
  const newEpisodes: Episode[] = [];
  for (const id of orderedIds) {
    const episode = list.episodes.find((ep) => ep.id === id);
    if (episode) {
      newEpisodes.push(episode);
    }
  }
  if (newEpisodes.length !== list.episodes.length) {
    console.warn("[phenex] reorderEpisodes: some episode IDs were missing, ignoring reorder");
    return;
  }
  list.episodes = newEpisodes;

  await reindexEpisodes(projectId, list);
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

  const id = crypto.randomUUID();
  const fileName = episodeFileName(id);
  const episode: Episode = {
    id,
    title: "第1話",
    order: 0,
    fileName,
  };

  await saveEpisode(projectId, fileName, text);
  await saveEpisodeList(projectId, { episodes: [episode] });
}
