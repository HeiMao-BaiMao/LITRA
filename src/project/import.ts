import type { Character, WorldEntry } from "./schema.ts";
import {
  createCharacter,
  createWorldEntry,
  loadCharacters,
  loadWorldEntries,
  saveCharacters,
  saveWorldEntries,
} from "./settings.ts";
import { createEpisode, saveEpisode } from "./episodes.ts";
import { saveEpisodeMemo } from "./memos.ts";

export type ImportItemType = "character" | "world" | "episode" | "memo" | "unknown";

export interface ImportCandidate {
  type: ImportItemType;
  filename: string;
  title: string;
}

export interface ImportResult {
  characters: number;
  worldEntries: number;
  episodes: number;
  memos: number;
  skippedMemos: number;
}

interface ParsedFile {
  frontmatter: Record<string, string>;
  body: string;
}

function splitFrontmatter(content: string): ParsedFile {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: {}, body: content };
  }

  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex === -1) {
    return { frontmatter: {}, body: content };
  }

  const frontmatter: Record<string, string> = {};
  for (let i = 1; i < endIndex; i++) {
    const line = lines[i];
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    if (key) frontmatter[key] = value;
  }

  const body = lines.slice(endIndex + 1).join("\n").trim();
  return { frontmatter, body };
}

function fileNameToTitle(filename: string): string {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? filename;
  return base.replace(/\.(md|txt|csv)$/i, "").trim();
}

function extractHeading(body: string): string | undefined {
  const match = body.match(/^#\s+(.+)$/m);
  return match?.[1].trim();
}

function extractCustomFields(
  frontmatter: Record<string, string>,
  knownKeys: string[],
): { label: string; value: string }[] {
  const lowerKnown = knownKeys.map((k) => k.toLowerCase());
  return Object.entries(frontmatter)
    .filter(([key]) => !lowerKnown.includes(key.toLowerCase()))
    .map(([label, value]) => ({ label, value }));
}

export function parseCharacterFile(content: string, filename: string): Partial<Character> {
  const { frontmatter, body } = splitFrontmatter(content);
  const name = frontmatter.name || fileNameToTitle(filename);
  const knownKeys = [
    "name", "alias", "role", "gender", "age", "birthday", "bloodtype", "height", "weight",
    "appearance", "personality", "individuality", "skills", "specialskills", "upbringing",
    "background", "notes",
  ];

  return {
    name,
    alias: frontmatter.alias ?? "",
    role: frontmatter.role ?? "",
    gender: frontmatter.gender ?? "",
    age: frontmatter.age ?? "",
    birthday: frontmatter.birthday ?? "",
    bloodType: frontmatter.bloodtype ?? frontmatter.bloodType ?? "",
    height: frontmatter.height ?? "",
    weight: frontmatter.weight ?? "",
    appearance: frontmatter.appearance ?? "",
    personality: frontmatter.personality ?? "",
    individuality: frontmatter.individuality ?? "",
    skills: frontmatter.skills ?? "",
    specialSkills: frontmatter.specialskills ?? frontmatter.specialSkills ?? "",
    upbringing: frontmatter.upbringing ?? "",
    background: frontmatter.background ?? "",
    notes: frontmatter.notes ?? body,
    customFields: extractCustomFields(frontmatter, knownKeys),
  };
}

export function parseWorldEntryFile(content: string, filename: string): Partial<WorldEntry> {
  const { frontmatter, body } = splitFrontmatter(content);
  const name = frontmatter.name || fileNameToTitle(filename);
  const knownKeys = [
    "name", "category", "era", "geography", "climate", "population", "politics", "laws",
    "economy", "military", "religion", "language", "culture", "history", "technology", "notes",
  ];

  return {
    name,
    category: frontmatter.category ?? "",
    era: frontmatter.era ?? "",
    geography: frontmatter.geography ?? "",
    climate: frontmatter.climate ?? "",
    population: frontmatter.population ?? "",
    politics: frontmatter.politics ?? "",
    laws: frontmatter.laws ?? "",
    economy: frontmatter.economy ?? "",
    military: frontmatter.military ?? "",
    religion: frontmatter.religion ?? "",
    language: frontmatter.language ?? "",
    culture: frontmatter.culture ?? "",
    history: frontmatter.history ?? "",
    technology: frontmatter.technology ?? "",
    notes: frontmatter.notes ?? body,
    customFields: extractCustomFields(frontmatter, knownKeys),
  };
}

export interface EpisodeCandidate {
  type: "episode";
  filename: string;
  title: string;
  content: string;
}

export interface MemoCandidate {
  type: "memo";
  filename: string;
  episodeTitle: string;
  content: string;
}

export function parseEpisodeFile(content: string, filename: string): EpisodeCandidate {
  const { frontmatter, body } = splitFrontmatter(content);
  const title = frontmatter.title || extractHeading(body) || fileNameToTitle(filename);
  return { type: "episode", filename, title, content: body };
}

export function parseMemoFile(content: string, filename: string): MemoCandidate {
  const { frontmatter, body } = splitFrontmatter(content);
  const episodeTitle = frontmatter.episode || frontmatter.title || fileNameToTitle(filename);
  return { type: "memo", filename, episodeTitle, content: body };
}

function classifyFile(file: File): ImportCandidate & { content?: string } {
  const path = file.webkitRelativePath || file.name;
  const lowerPath = path.toLowerCase();
  const filename = file.name;

  if (!/\.(md|txt|csv)$/i.test(filename)) {
    return { type: "unknown", filename, title: filename };
  }

  if (lowerPath.includes("/characters/")) {
    return { type: "character", filename, title: fileNameToTitle(filename) };
  }
  if (lowerPath.includes("/world/")) {
    return { type: "world", filename, title: fileNameToTitle(filename) };
  }
  if (lowerPath.includes("/episodes/")) {
    return { type: "episode", filename, title: fileNameToTitle(filename) };
  }
  if (lowerPath.includes("/memos/")) {
    return { type: "memo", filename, title: fileNameToTitle(filename) };
  }

  // ルート直下はエピソード本文として扱う
  return { type: "episode", filename, title: fileNameToTitle(filename) };
}

export async function scanImportFiles(files: File[]): Promise<ImportCandidate[]> {
  const candidates: ImportCandidate[] = [];
  for (const file of files) {
    candidates.push(classifyFile(file));
  }
  return candidates;
}

export async function importFolder(projectId: string, files: File[]): Promise<ImportResult> {
  const result: ImportResult = {
    characters: 0,
    worldEntries: 0,
    episodes: 0,
    memos: 0,
    skippedMemos: 0,
  };

  const [characterList, worldList] = await Promise.all([
    loadCharacters(projectId),
    loadWorldEntries(projectId),
  ]);

  const episodeTitleToId = new Map<string, string>();

  for (const file of files) {
    const candidate = classifyFile(file);
    if (candidate.type === "unknown") continue;

    const text = await file.text();

    if (candidate.type === "character") {
      const partial = parseCharacterFile(text, file.name);
      const character = await createCharacter(projectId, partial.name || candidate.title);
      Object.assign(character, partial);
      characterList.characters.push(character);
      result.characters++;
      continue;
    }

    if (candidate.type === "world") {
      const partial = parseWorldEntryFile(text, file.name);
      const entry = await createWorldEntry(
        projectId,
        partial.name || candidate.title,
        partial.category || "",
      );
      Object.assign(entry, partial);
      worldList.entries.push(entry);
      result.worldEntries++;
      continue;
    }
  }

  await Promise.all([saveCharacters(projectId, characterList), saveWorldEntries(projectId, worldList)]);

  // エピソードはファイル名順にソートして作成し、order を保つ
  const episodeFiles = files
    .map((file) => ({ file, candidate: classifyFile(file) }))
    .filter(({ candidate }) => candidate.type === "episode")
    .sort((a, b) => a.file.name.localeCompare(b.file.name));

  for (const { file } of episodeFiles) {
    const text = await file.text();
    const candidate = parseEpisodeFile(text, file.name);
    const episode = await createEpisode(projectId, candidate.title);
    await saveEpisode(projectId, episode.fileName, candidate.content);
    episodeTitleToId.set(candidate.title, episode.id);
    result.episodes++;
  }

  // メモは紐づくエピソードタイトルから ID を解決して保存
  const memoFiles = files.filter((file) => classifyFile(file).type === "memo");
  for (const file of memoFiles) {
    const text = await file.text();
    const candidate = parseMemoFile(text, file.name);
    const episodeId = episodeTitleToId.get(candidate.episodeTitle);
    if (episodeId) {
      await saveEpisodeMemo(projectId, episodeId, candidate.content);
      result.memos++;
    } else {
      console.warn(`[phenex:import] memo target episode not found: ${candidate.episodeTitle}`);
      result.skippedMemos++;
    }
  }

  return result;
}
