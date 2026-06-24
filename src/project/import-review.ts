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
      alias: z
        .string()
        .optional()
        .describe("Japanese alias description or established proper name."),
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
        `- ${c.name} (${c.role || "役割未設定"}): ${limitText(c.notes || c.appearance || c.personality || "（説明なし）", 120)}`,
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
Review the recent folder-import result against the current project data and return only strongly supported corrective operations.

PERSISTED-DATA LANGUAGE RULE:
- Write every new or updated descriptive setting value, relationship description, memo title, and memo content in Japanese.
- Preserve IDs, enum values, existing proper names, exact quotations, code, URLs, filenames, and literal identifiers.
- Never write English explanatory prose into a persisted field merely because these instructions are English.

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
- Fill an empty character field only when other project data explicitly supports the value.
- Add only clearly missing relationships.
- Correct a relationship direction or description only when explicit evidence shows it is wrong.
- For family or role relationship additions, use A=the central or known person and B=the relative or role holder; use direction=b-to-a when B's role points toward A.
- Add a missed worldbuilding item or memo only when explicit imported evidence supports it.
- Never create a relationship using a character name absent from CURRENT CHARACTERS.
- Do not invent settings, relationships, or memos from weak inference.
- Return empty arrays when no correction is necessary.
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
      "Review imported creative-writing data and return only necessary corrections as structured JSON. Keep control fields in the schema unchanged. All natural-language values that will be persisted must be Japanese.",
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
    const characterNameToId = new Map(
      characters.map((c) => [c.name.toLowerCase(), c.id] as const),
    );
    const episodeTitleToId = new Map(
      episodes.map((ep) => [ep.title.toLowerCase(), ep.id] as const),
    );

    for (const rel of review.relationshipsToCreate) {
      const aId = characterNameToId.get(rel.characterAName.toLowerCase());
      const bId = characterNameToId.get(rel.characterBName.toLowerCase());
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
