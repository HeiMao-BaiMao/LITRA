import { BaseDirectory, exists, mkdir, readTextFile } from "@tauri-apps/plugin-fs";
import { writeDocumentTextFile } from "../sync/webdav.ts";
import type { Character, CharacterList, WorldEntry, WorldEntryList } from "./schema.ts";
import { isCharacterList, isWorldEntryList, normalizeCharacter, normalizeWorldEntry } from "./schema.ts";

const SETTINGS_DIR = "settings";
const CHARACTERS_FILE = "settings/characters.json";
const WORLD_FILE = "settings/world.json";

function projectPath(projectId: string, ...parts: string[]): string {
  return `litra/projects/${projectId}/${parts.join("/")}`;
}

async function ensureSettingsDir(projectId: string): Promise<void> {
  const dir = projectPath(projectId, SETTINGS_DIR);
  const dirExists = await exists(dir, { baseDir: BaseDirectory.Document });
  if (!dirExists) {
    await mkdir(dir, { baseDir: BaseDirectory.Document, recursive: true });
  }
}

export async function loadCharacters(projectId: string): Promise<CharacterList> {
  await ensureSettingsDir(projectId);
  try {
    const text = await readTextFile(projectPath(projectId, CHARACTERS_FILE), {
      baseDir: BaseDirectory.Document,
    });
    const parsed: unknown = JSON.parse(text);
    if (isCharacterList(parsed)) {
      return {
        characters: parsed.characters.map((char) => normalizeCharacter(char as Partial<Character>)),
      };
    }
  } catch {
    // ファイルがない・壊れている場合は空を返す
  }
  return { characters: [] };
}

export async function saveCharacters(
  projectId: string,
  list: CharacterList,
): Promise<void> {
  await ensureSettingsDir(projectId);
  await writeDocumentTextFile(
    projectPath(projectId, CHARACTERS_FILE),
    JSON.stringify(list, null, 2),
  );
}

export async function createCharacter(
  projectId: string,
  name: string,
  reading = "",
): Promise<Character> {
  const list = await loadCharacters(projectId);
  const character = normalizeCharacter({
    id: crypto.randomUUID(),
    name,
    reading,
  });
  list.characters.push(character);
  await saveCharacters(projectId, list);
  return character;
}

export async function updateCharacter(
  projectId: string,
  character: Character,
): Promise<void> {
  const list = await loadCharacters(projectId);
  const index = list.characters.findIndex((c) => c.id === character.id);
  if (index === -1) return;
  list.characters[index] = character;
  await saveCharacters(projectId, list);
}

export async function deleteCharacter(projectId: string, characterId: string): Promise<void> {
  const list = await loadCharacters(projectId);
  list.characters = list.characters.filter((c) => c.id !== characterId);
  await saveCharacters(projectId, list);
}

export async function loadWorldEntries(projectId: string): Promise<WorldEntryList> {
  await ensureSettingsDir(projectId);
  try {
    const text = await readTextFile(projectPath(projectId, WORLD_FILE), {
      baseDir: BaseDirectory.Document,
    });
    const parsed: unknown = JSON.parse(text);
    if (isWorldEntryList(parsed)) {
      return {
        entries: parsed.entries.map((entry) => normalizeWorldEntry(entry as Partial<WorldEntry>)),
      };
    }
  } catch {
    // ファイルがない・壊れている場合は空を返す
  }
  return { entries: [] };
}

export async function saveWorldEntries(
  projectId: string,
  list: WorldEntryList,
): Promise<void> {
  await ensureSettingsDir(projectId);
  await writeDocumentTextFile(
    projectPath(projectId, WORLD_FILE),
    JSON.stringify(list, null, 2),
  );
}

export async function createWorldEntry(
  projectId: string,
  name: string,
  category: string,
): Promise<WorldEntry> {
  const list = await loadWorldEntries(projectId);
  const entry = normalizeWorldEntry({
    id: crypto.randomUUID(),
    name,
    category,
  });
  list.entries.push(entry);
  await saveWorldEntries(projectId, list);
  return entry;
}

export async function updateWorldEntry(
  projectId: string,
  entry: WorldEntry,
): Promise<void> {
  const list = await loadWorldEntries(projectId);
  const index = list.entries.findIndex((e) => e.id === entry.id);
  if (index === -1) return;
  list.entries[index] = entry;
  await saveWorldEntries(projectId, list);
}

export async function deleteWorldEntry(projectId: string, entryId: string): Promise<void> {
  const list = await loadWorldEntries(projectId);
  list.entries = list.entries.filter((e) => e.id !== entryId);
  await saveWorldEntries(projectId, list);
}
