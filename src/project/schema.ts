export interface Episode {
  id: string;
  title: string;
  order: number;
  fileName: string;
}

export interface EpisodeList {
  episodes: Episode[];
}

export interface EpisodeSummary {
  content: string;
  updatedAt: string;
}

export interface EpisodeSummaryMap {
  summaries: Record<string, EpisodeSummary>;
}

export interface EpisodeMemo {
  content: string;
  updatedAt: string;
}

export interface EpisodeMemoMap {
  memos: Record<string, EpisodeMemo>;
}

export interface CustomField {
  label: string;
  value: string;
}

export interface Character {
  id: string;
  name: string;
  alias: string;
  role: string;
  gender: string;
  age: string;
  birthday: string;
  bloodType: string;
  height: string;
  weight: string;
  appearance: string;
  personality: string;
  individuality: string;
  skills: string;
  specialSkills: string;
  upbringing: string;
  background: string;
  notes: string;
  customFields: CustomField[];
}

export interface CharacterList {
  characters: Character[];
}

export interface WorldEntry {
  id: string;
  name: string;
  category: string;
  era: string;
  geography: string;
  climate: string;
  population: string;
  politics: string;
  laws: string;
  economy: string;
  military: string;
  religion: string;
  language: string;
  culture: string;
  history: string;
  technology: string;
  notes: string;
  customFields: CustomField[];
}

export interface WorldEntryList {
  entries: WorldEntry[];
}

export type ProjectView = "episode" | "characters" | "world";

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function ensureString(value: unknown, defaultValue = ""): string {
  return isString(value) ? value : defaultValue;
}

function ensureCustomFields(value: unknown): CustomField[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Partial<CustomField> => typeof item === "object" && item !== null)
    .map((item) => ({
      label: ensureString(item.label),
      value: ensureString(item.value),
    }));
}

export function normalizeCharacter(character: Partial<Character>): Character {
  return {
    id: ensureString(character.id),
    name: ensureString(character.name),
    alias: ensureString(character.alias),
    role: ensureString(character.role),
    gender: ensureString(character.gender),
    age: ensureString(character.age),
    birthday: ensureString(character.birthday),
    bloodType: ensureString(character.bloodType),
    height: ensureString(character.height),
    weight: ensureString(character.weight),
    appearance: ensureString(character.appearance),
    personality: ensureString(character.personality),
    individuality: ensureString(character.individuality),
    skills: ensureString(character.skills),
    specialSkills: ensureString(character.specialSkills),
    upbringing: ensureString(character.upbringing),
    background: ensureString(character.background),
    notes: ensureString(character.notes),
    customFields: ensureCustomFields(character.customFields),
  };
}

export function normalizeWorldEntry(entry: Partial<WorldEntry>): WorldEntry {
  return {
    id: ensureString(entry.id),
    name: ensureString(entry.name),
    category: ensureString(entry.category),
    era: ensureString(entry.era),
    geography: ensureString(entry.geography),
    climate: ensureString(entry.climate),
    population: ensureString(entry.population),
    politics: ensureString(entry.politics),
    laws: ensureString(entry.laws),
    economy: ensureString(entry.economy),
    military: ensureString(entry.military),
    religion: ensureString(entry.religion),
    language: ensureString(entry.language),
    culture: ensureString(entry.culture),
    history: ensureString(entry.history),
    technology: ensureString(entry.technology),
    notes: ensureString(entry.notes),
    customFields: ensureCustomFields(entry.customFields),
  };
}

export function isEpisodeList(value: unknown): value is EpisodeList {
  if (typeof value !== "object" || value === null) return false;
  const list = value as Partial<EpisodeList>;
  if (!Array.isArray(list.episodes)) return false;
  return list.episodes.every((ep) => {
    const e = ep as Partial<Episode>;
    return (
      typeof e.id === "string" &&
      typeof e.title === "string" &&
      typeof e.order === "number" &&
      typeof e.fileName === "string"
    );
  });
}

export function isCharacterList(value: unknown): value is CharacterList {
  if (typeof value !== "object" || value === null) return false;
  const list = value as Partial<CharacterList>;
  if (!Array.isArray(list.characters)) return false;
  return list.characters.every((char) => {
    const c = char as Partial<Character>;
    return typeof c.id === "string" && typeof c.name === "string";
  });
}

export function isWorldEntryList(value: unknown): value is WorldEntryList {
  if (typeof value !== "object" || value === null) return false;
  const list = value as Partial<WorldEntryList>;
  if (!Array.isArray(list.entries)) return false;
  return list.entries.every((entry) => {
    const e = entry as Partial<WorldEntry>;
    return typeof e.id === "string" && typeof e.name === "string";
  });
}

export function isEpisodeSummaryMap(value: unknown): value is EpisodeSummaryMap {
  if (typeof value !== "object" || value === null) return false;
  const map = value as Partial<EpisodeSummaryMap>;
  if (typeof map.summaries !== "object" || map.summaries === null) return false;
  return Object.entries(map.summaries).every(([key, summary]) => {
    if (typeof key !== "string") return false;
    const s = summary as Partial<EpisodeSummary>;
    return typeof s.content === "string" && typeof s.updatedAt === "string";
  });
}

export function isEpisodeMemoMap(value: unknown): value is EpisodeMemoMap {
  if (typeof value !== "object" || value === null) return false;
  const map = value as Partial<EpisodeMemoMap>;
  if (typeof map.memos !== "object" || map.memos === null) return false;
  return Object.entries(map.memos).every(([key, memo]) => {
    if (typeof key !== "string") return false;
    const m = memo as Partial<EpisodeMemo>;
    return typeof m.content === "string" && typeof m.updatedAt === "string";
  });
}
