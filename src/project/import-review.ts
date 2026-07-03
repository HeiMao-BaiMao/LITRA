import { generateObject } from "ai";
import { z } from "zod";
import { createModel } from "../ai/provider.ts";
import {
  loadCharacters,
  loadWorldEntries,
  updateCharacter,
  updateWorldEntry,
} from "./settings.ts";
import { loadRelationships, saveRelationships } from "./relationships.ts";
import { loadMemos, saveEpisodeMemo } from "./memos.ts";
import {
  listProjectMemos,
  createProjectMemo,
  updateProjectMemo,
} from "./project-memo.ts";
import type { ProjectMemo } from "./project-memo.ts";
import { loadEpisodeList } from "./episodes.ts";
import type { AiSettings } from "../settings.ts";
import type {
  Character,
  CharacterRelationshipMap,
  EpisodeMemoMap,
  WorldEntry,
} from "./schema.ts";

export interface ImportReviewResult {
  updatedCharacters: number;
  updatedWorldEntries: number;
  createdRelationships: number;
  createdProjectMemos: number;
  updatedEpisodeMemos: number;
}

const reviewSchema = z.object({
  charactersToUpdate: z.array(
    z.object({
      id: z.string().describe("Character ID to update."),
      name: z
        .string()
        .optional()
        .describe(
          "Name change. Preserve an established proper-name spelling; omit when unchanged.",
        ),
      reading: z
        .string()
        .optional()
        .describe("よみがな for the character name. Use kana when explicitly supported."),
      alias: z
        .string()
        .optional()
        .describe("Japanese alias description, title form, alternate spelling, or established proper name."),
      role: z.string().optional().describe("Japanese role description."),
      gender: z
        .string()
        .optional()
        .describe("Japanese gender description when present in the source."),
      age: z.string().optional(),
      birthday: z.string().optional(),
      bloodType: z.string().optional(),
      height: z.string().optional(),
      weight: z.string().optional(),
      appearance: z
        .string()
        .optional()
        .describe("Japanese appearance description."),
      personality: z
        .string()
        .optional()
        .describe("Japanese personality description."),
      individuality: z
        .string()
        .optional()
        .describe("Japanese individuality description."),
      skills: z.string().optional().describe("Japanese skills description."),
      specialSkills: z
        .string()
        .optional()
        .describe("Japanese special-skills description."),
      upbringing: z
        .string()
        .optional()
        .describe("Japanese upbringing description."),
      background: z
        .string()
        .optional()
        .describe("Japanese background description."),
      notes: z.string().optional().describe("Japanese notes."),
    }),
  ),
  worldEntriesToUpdate: z.array(
    z.object({
      id: z.string().describe("Worldbuilding entry ID to update."),
      name: z
        .string()
        .optional()
        .describe("Japanese entry name or established proper noun."),
      category: z.string().optional().describe("Japanese category label."),
      era: z.string().optional().describe("Japanese era description."),
      geography: z
        .string()
        .optional()
        .describe("Japanese geography description."),
      climate: z.string().optional().describe("Japanese climate description."),
      population: z
        .string()
        .optional()
        .describe("Japanese population description."),
      politics: z
        .string()
        .optional()
        .describe("Japanese politics description."),
      laws: z.string().optional().describe("Japanese laws description."),
      economy: z.string().optional().describe("Japanese economy description."),
      military: z
        .string()
        .optional()
        .describe("Japanese military description."),
      religion: z
        .string()
        .optional()
        .describe("Japanese religion description."),
      language: z
        .string()
        .optional()
        .describe("Japanese description of the in-world language."),
      culture: z.string().optional().describe("Japanese culture description."),
      history: z.string().optional().describe("Japanese history description."),
      technology: z
        .string()
        .optional()
        .describe("Japanese technology description."),
      notes: z.string().optional().describe("Japanese notes."),
    }),
  ),
  relationshipsToCreate: z.array(
    z.object({
      episodeTitle: z
        .string()
        .default("")
        .describe(
          "Associated episode title. Use an empty string for a whole-work relationship.",
        ),
      characterAName: z.string().describe("Existing character A name."),
      characterBName: z.string().describe("Existing character B name."),
      direction: z
        .string()
        .default("mutual")
        .describe("Direction enum: a-to-b, b-to-a, or mutual."),
      description: z.string().describe("Japanese relationship description."),
    }),
  ),
  projectMemosToCreate: z.array(
    z.object({
      title: z.string().describe("Japanese memo title."),
      content: z.string().describe("Japanese memo content."),
    }),
  ),
  episodeMemosToUpdate: z.array(
    z.object({
      episodeTitle: z.string().describe("Existing episode title to update."),
      content: z.string().describe("Updated Japanese memo content."),
    }),
  ),
});

function limitText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "\n...（以下省略）";
}

function formatRelationshipMap(
  map: CharacterRelationshipMap,
  characters: Character[],
): string {
  const name = (id: string): string =>
    characters.find((c) => c.id === id)?.name || "（不明）";
  return map.groups
    .map((group) => {
      const lines = group.relationships
        .map((rel) => {
          const arrow =
            rel.direction === "a-to-b"
              ? "→"
              : rel.direction === "b-to-a"
                ? "←"
                : "↔";
          return `  - ${name(rel.characterAId)} ${arrow} ${name(rel.characterBId)}: ${rel.description}`;
        })
        .join("\n");
      return `■ ${group.episodeId || "全体"}\n${lines || "  （なし）"}`;
    })
    .join("\n\n");
}

const CHARACTER_IDENTITY_SUFFIXES = [
  "大佐",
  "中佐",
  "少佐",
  "大尉",
  "中尉",
  "少尉",
  "軍曹",
  "隊長",
  "艦長",
  "博士",
  "先生",
  "さん",
  "様",
  "くん",
  "君",
  "ちゃん",
  "殿",
  "卿",
  "colonel",
  "captain",
  "major",
  "sir",
  "lord",
  "lady",
  "dr",
  "mr",
  "ms",
  "mrs",
];

function stripCharacterIdentityAffixes(value: string): string {
  let current = value.trim();
  let changed = true;
  while (changed && current.length > 0) {
    changed = false;
    for (const affix of CHARACTER_IDENTITY_SUFFIXES) {
      if (current.endsWith(affix) && current.length > affix.length) {
        current = current.slice(0, -affix.length).trim();
        changed = true;
      }
      if (current.startsWith(affix) && current.length > affix.length) {
        current = current.slice(affix.length).trim();
        changed = true;
      }
    }
  }
  return current;
}

function hasCharacterIdentitySeparator(value: string): boolean {
  return /[\s,、，;；／\/\\・･.．_\-‐‑–—()[\]（）「」『』【】]/u.test(value);
}

function hasCharacterIdentityAffix(value: string): boolean {
  const normalized = value.normalize("NFKC").toLocaleLowerCase().trim();
  return stripCharacterIdentityAffixes(normalized) !== normalized;
}

function compactCharacterIdentityKey(value: string): string {
  return stripCharacterIdentityAffixes(value)
    .replace(/[\s,、，.．・･／\/\\_\-‐‑–—'’"“”()[\]（）「」『』【】]/g, "")
    .trim();
}

function uniqueCharacterIdentityKeys(values: string[]): string[] {
  return [...new Set(values.map(compactCharacterIdentityKey).filter((key) => key.length >= 2))];
}

function characterPrimaryIdentityKeysFromText(value: string | undefined): string[] {
  if (!value) return [];
  const normalized = value.normalize("NFKC").toLocaleLowerCase().trim();
  if (!normalized) return [];
  return uniqueCharacterIdentityKeys([normalized, stripCharacterIdentityAffixes(normalized)]);
}

function characterIdentityKeysFromText(value: string | undefined): string[] {
  if (!value) return [];
  const normalized = value.normalize("NFKC").toLocaleLowerCase().trim();
  if (!normalized) return [];
  const parts = normalized
    .split(/[\s,、，;；／\/\\・･.．_\-‐‑–—()[\]（）「」『』【】]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  return uniqueCharacterIdentityKeys([normalized, stripCharacterIdentityAffixes(normalized), ...parts]);
}

function characterReferenceIdentityKeysFromText(value: string | undefined): string[] {
  if (!value) return [];
  const normalized = value.normalize("NFKC").toLocaleLowerCase().trim();
  if (!normalized) return [];
  if (!hasCharacterIdentitySeparator(normalized) || hasCharacterIdentityAffix(normalized)) {
    return characterIdentityKeysFromText(normalized);
  }
  return characterPrimaryIdentityKeysFromText(normalized);
}

function buildCharacterNameToIdMap(characters: Character[]): Map<string, string> {
  const map = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const character of characters) {
    for (const key of [
      ...characterIdentityKeysFromText(character.name),
      ...characterIdentityKeysFromText(character.reading),
      ...characterIdentityKeysFromText(character.alias),
    ]) {
      const existing = map.get(key);
      if (existing && existing !== character.id) {
        ambiguous.add(key);
        map.delete(key);
      } else if (!ambiguous.has(key)) {
        map.set(key, character.id);
      }
    }
  }
  return map;
}

function buildReviewPrompt(params: {
  characters: Character[];
  worldEntries: WorldEntry[];
  episodes: { id: string; title: string }[];
  relationships: CharacterRelationshipMap;
  projectMemos: ProjectMemo[];
  episodeMemos: EpisodeMemoMap;
  importSummary: string;
}): string {
  const characterLines = params.characters
    .map(
      (c) =>
        `- ${c.name} / よみがな:${c.reading || "未設定"} / 別名:${c.alias || "未設定"} (${c.role || "役割未設定"}): ${limitText(c.notes || c.appearance || c.personality || "（説明なし）", 120)}`,
    )
    .join("\n");

  const worldLines = params.worldEntries
    .map(
      (e) =>
        `- ${e.name} [${e.category}]: ${limitText(e.notes || e.geography || e.history || "（説明なし）", 120)}`,
    )
    .join("\n");

  const episodeLines = params.episodes.map((e) => `- ${e.title}`).join("\n");

  const projectMemoLines = params.projectMemos
    .map((m) => `- ${m.title}: ${limitText(m.content, 120)}`)
    .join("\n");

  const episodeMemoLines = params.episodes
    .filter((ep) => params.episodeMemos.memos[ep.id]?.content)
    .map((ep) => {
      const content = params.episodeMemos.memos[ep.id]?.content ?? "";
      return `- ${ep.title}: ${limitText(content, 120)}`;
    })
    .join("\n");

  return `TASK:
Review the recent folder-import result against the current project data. Return ONLY corrections that the data strongly supports. When in doubt, return nothing.

LANGUAGE RULES:
- Write every new or updated descriptive value, relationship description, memo title, and memo content in Japanese. 保存する説明文は必ず日本語で書くこと。
- Keep unchanged: IDs, enum values, existing proper names, exact quotations, code, URLs, filenames, and literal identifiers.
- These instructions are English. That is NEVER a reason to write English prose into a persisted field.

CURRENT IMPORT SUMMARY:
${params.importSummary}

CURRENT CHARACTERS:
${characterLines || "（なし）"}

CURRENT WORLDBUILDING ENTRIES:
${worldLines || "（なし）"}

CURRENT EPISODES:
${episodeLines || "（なし）"}

CURRENT RELATIONSHIPS:
${formatRelationshipMap(params.relationships, params.characters) || "（なし）"}

CURRENT PROJECT MEMOS:
${projectMemoLines || "（なし）"}

CURRENT EPISODE MEMOS:
${episodeMemoLines || "（なし）"}

CORRECTION RULES:
- Treat two names as the same character only when the evidence is clear. Compare names, readings, aliases, surnames, ranks/titles, forms of address, and English/Japanese spelling variants.
- IF a newly imported character duplicates an existing character → update the existing character's empty reading/alias/details. NEVER suggest that a separate character should exist.
- Fill an empty character field only when other project data explicitly states the value.
- Add a relationship only when it is clearly missing.
- Change a relationship direction or description only when explicit evidence shows it is wrong.
- For family or role relationship additions: A = the central or known person. B = the relative or role holder. Use direction=b-to-a when B's role points toward A.
- Add a missed worldbuilding item or memo only when explicit imported evidence supports it.
- NEVER create a relationship using a character name that is absent from CURRENT CHARACTERS.
- NEVER invent settings, relationships, or memos from weak inference.
- IF no correction is necessary → return empty arrays.
- Follow the JSON schema exactly.`;
}

function normalizeDirection(raw: string): "a-to-b" | "b-to-a" | "mutual" {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[-_\s]/g, "");
  if (
    normalized.includes("atob") ||
    normalized.includes("a→b") ||
    normalized.includes("a->b")
  ) {
    return "a-to-b";
  }
  if (
    normalized.includes("btoa") ||
    normalized.includes("b→a") ||
    normalized.includes("b->a")
  ) {
    return "b-to-a";
  }
  return "mutual";
}

export async function reviewAndFixImportedData(
  projectId: string,
  settings: AiSettings,
  importSummary: string,
): Promise<ImportReviewResult> {
  const [
    characterList,
    worldList,
    episodeList,
    relationshipsMap,
    memos,
    projectMemoList,
  ] = await Promise.all([
    loadCharacters(projectId),
    loadWorldEntries(projectId),
    loadEpisodeList(projectId),
    loadRelationships(projectId),
    loadMemos(projectId),
    listProjectMemos(projectId),
  ]);

  const characters = characterList.characters;
  const worldEntries = worldList.entries;
  const episodes = episodeList.episodes;

  const result = await generateObject({
    model: createModel(settings),
    schema: reviewSchema,
    system:
      "You review imported creative-writing data. Return only necessary corrections, as structured JSON that follows the schema exactly. Keep IDs and enum values unchanged. Write every natural-language value that will be persisted in Japanese. 保存する説明文は必ず日本語で書くこと。",
    prompt: buildReviewPrompt({
      characters,
      worldEntries,
      episodes,
      relationships: relationshipsMap,
      projectMemos: projectMemoList,
      episodeMemos: memos,
      importSummary,
    }),
    maxOutputTokens: 16384,
    temperature: 0.3,
  });

  const review = result.object;
  const reviewResult: ImportReviewResult = {
    updatedCharacters: 0,
    updatedWorldEntries: 0,
    createdRelationships: 0,
    createdProjectMemos: 0,
    updatedEpisodeMemos: 0,
  };

  // キャラクター更新
  for (const update of review.charactersToUpdate) {
    const target = characters.find((c) => c.id === update.id);
    if (!target) continue;
    const updated: Character = {
      ...target,
      ...Object.fromEntries(
        Object.entries(update).filter(
          ([, value]) => value !== undefined && value !== "",
        ),
      ),
    } as Character;
    await updateCharacter(projectId, updated);
    reviewResult.updatedCharacters += 1;
  }

  // 世界観項目更新
  for (const update of review.worldEntriesToUpdate) {
    const target = worldEntries.find((e) => e.id === update.id);
    if (!target) continue;
    const updated: WorldEntry = {
      ...target,
      ...Object.fromEntries(
        Object.entries(update).filter(
          ([, value]) => value !== undefined && value !== "",
        ),
      ),
    } as WorldEntry;
    await updateWorldEntry(projectId, updated);
    reviewResult.updatedWorldEntries += 1;
  }

  // 人間関係追加
  if (review.relationshipsToCreate.length > 0) {
    const characterNameToId = buildCharacterNameToIdMap(characters);
    const episodeTitleToId = new Map(
      episodes.map((ep) => [ep.title.toLowerCase(), ep.id] as const),
    );

    for (const rel of review.relationshipsToCreate) {
      const aId = characterReferenceIdentityKeysFromText(rel.characterAName)
        .map((key) => characterNameToId.get(key))
        .find((id): id is string => typeof id === "string");
      const bId = characterReferenceIdentityKeysFromText(rel.characterBName)
        .map((key) => characterNameToId.get(key))
        .find((id): id is string => typeof id === "string");
      if (!aId || !bId || aId === bId) continue;

      const episodeId = rel.episodeTitle
        ? (episodeTitleToId.get(rel.episodeTitle.toLowerCase()) ?? "")
        : "";

      let group = relationshipsMap.groups.find(
        (g) => g.episodeId === episodeId,
      );
      if (!group) {
        group = { episodeId, relationships: [] };
        relationshipsMap.groups.push(group);
      }
      group.relationships.push({
        id: crypto.randomUUID(),
        characterAId: aId,
        characterBId: bId,
        direction: normalizeDirection(rel.direction),
        description: rel.description,
      });
      reviewResult.createdRelationships += 1;
    }

    await saveRelationships(projectId, relationshipsMap);
  }

  // 作品メモ追加
  for (const memo of review.projectMemosToCreate) {
    const created = await createProjectMemo(projectId, memo.title);
    await updateProjectMemo(projectId, created.id, { content: memo.content });
    reviewResult.createdProjectMemos += 1;
  }

  // エピソード覚え書き更新
  const episodeTitleToId = new Map(
    episodes.map((ep) => [ep.title.toLowerCase(), ep.id] as const),
  );
  for (const memo of review.episodeMemosToUpdate) {
    const episodeId = episodeTitleToId.get(memo.episodeTitle.toLowerCase());
    if (!episodeId) continue;
    await saveEpisodeMemo(projectId, episodeId, memo.content);
    reviewResult.updatedEpisodeMemos += 1;
  }

  return reviewResult;
}
