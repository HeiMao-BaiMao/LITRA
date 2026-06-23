import { generateObject } from "ai";
import { z } from "zod";
import { createModel } from "../ai/provider.ts";
import { loadCharacters, loadWorldEntries, updateCharacter, updateWorldEntry } from "./settings.ts";
import { loadRelationships, saveRelationships } from "./relationships.ts";
import { loadMemos, saveEpisodeMemo } from "./memos.ts";
import { listProjectMemos, createProjectMemo, updateProjectMemo } from "./project-memo.ts";
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
      id: z.string().describe("更新対象のキャラクターID"),
      name: z.string().optional().describe("名前（変更しない場合は省略）"),
      alias: z.string().optional(),
      role: z.string().optional(),
      gender: z.string().optional(),
      age: z.string().optional(),
      birthday: z.string().optional(),
      bloodType: z.string().optional(),
      height: z.string().optional(),
      weight: z.string().optional(),
      appearance: z.string().optional(),
      personality: z.string().optional(),
      individuality: z.string().optional(),
      skills: z.string().optional(),
      specialSkills: z.string().optional(),
      upbringing: z.string().optional(),
      background: z.string().optional(),
      notes: z.string().optional(),
    }),
  ),
  worldEntriesToUpdate: z.array(
    z.object({
      id: z.string().describe("更新対象の世界観項目ID"),
      name: z.string().optional(),
      category: z.string().optional(),
      era: z.string().optional(),
      geography: z.string().optional(),
      climate: z.string().optional(),
      population: z.string().optional(),
      politics: z.string().optional(),
      laws: z.string().optional(),
      economy: z.string().optional(),
      military: z.string().optional(),
      religion: z.string().optional(),
      language: z.string().optional(),
      culture: z.string().optional(),
      history: z.string().optional(),
      technology: z.string().optional(),
      notes: z.string().optional(),
    }),
  ),
  relationshipsToCreate: z.array(
    z.object({
      episodeTitle: z
        .string()
        .default("")
        .describe("紐づくエピソードのタイトル。全体（全話共通）の場合は空文字"),
      characterAName: z.string().describe("関係の一方のキャラクター名"),
      characterBName: z.string().describe("関係のもう一方のキャラクター名"),
      direction: z.string().default("mutual").describe("a-to-b / b-to-a / mutual"),
      description: z.string().describe("関係の説明"),
    }),
  ),
  projectMemosToCreate: z.array(
    z.object({
      title: z.string().describe("メモのタイトル"),
      content: z.string().describe("メモの内容"),
    }),
  ),
  episodeMemosToUpdate: z.array(
    z.object({
      episodeTitle: z.string().describe("更新対象のエピソードタイトル"),
      content: z.string().describe("更新後のメモ内容"),
    }),
  ),
});

function limitText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "\n...（以下省略）";
}

function formatRelationshipMap(map: CharacterRelationshipMap, characters: Character[]): string {
  const name = (id: string): string => characters.find((c) => c.id === id)?.name || "（不明）";
  return map.groups
    .map((group) => {
      const lines = group.relationships
        .map((rel) => {
          const arrow =
            rel.direction === "a-to-b" ? "→" : rel.direction === "b-to-a" ? "←" : "↔";
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
    .map((c) => `- ${c.name} (${c.role || "役割未設定"}): ${limitText(c.notes || c.appearance || c.personality || "（説明なし）", 120)}`)
    .join("\n");

  const worldLines = params.worldEntries
    .map((e) => `- ${e.name} [${e.category}]: ${limitText(e.notes || e.geography || e.history || "（説明なし）", 120)}`)
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

  return `あなたは創作支援アプリの編集アシスタントです。
先ほど行ったフォルダ取り込みの結果と、現在のプロジェクトデータを照らし合わせて、足りない項目や不適切な点を修正してください。

## 今回の取り込みサマリー
${params.importSummary}

## 現在のキャラクター一覧
${characterLines || "（なし）"}

## 現在の世界観項目一覧
${worldLines || "（なし）"}

## 現在のエピソード一覧
${episodeLines || "（なし）"}

## 現在の人間関係
${formatRelationshipMap(params.relationships, params.characters) || "（なし）"}

## 現在の作品メモ
${projectMemoLines || "（なし）"}

## 現在のエピソード覚え書き
${episodeMemoLines || "（なし）"}

## 指示
- キャラクターの空欄フィールドが、他のデータ（関係、エピソード、世界観など）から推定できる場合は埋めてください。
- 明らかに不足している人間関係があれば追加してください。
- 矛盾している関係の方向や説明があれば修正してください。
- 取り込みで見落とされた可能性のある世界観項目やメモがあれば追加してください。
- 存在しないキャラクター名を使った関係追加は行わないでください。必ず「現在のキャラクター一覧」にいる名前を使ってください。
- 変更が必要ない場合は空の配列を返してください。

出力は指定された JSON 形式に従ってください。`;
}

function normalizeDirection(raw: string): "a-to-b" | "b-to-a" | "mutual" {
  const normalized = raw.trim().toLowerCase().replace(/[-_\s]/g, "");
  if (normalized.includes("atob") || normalized.includes("a→b") || normalized.includes("a->b")) {
    return "a-to-b";
  }
  if (normalized.includes("btoa") || normalized.includes("b→a") || normalized.includes("b->a")) {
    return "b-to-a";
  }
  return "mutual";
}

export async function reviewAndFixImportedData(
  projectId: string,
  settings: AiSettings,
  importSummary: string,
): Promise<ImportReviewResult> {
  const [characterList, worldList, episodeList, relationshipsMap, memos, projectMemoList] =
    await Promise.all([
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
      "創作データの整合性を確認し、修正が必要な箇所を構造化された JSON で返してください。",
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
        Object.entries(update).filter(([, value]) => value !== undefined && value !== ""),
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
        Object.entries(update).filter(([, value]) => value !== undefined && value !== ""),
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

      let group = relationshipsMap.groups.find((g) => g.episodeId === episodeId);
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
  const episodeTitleToId = new Map(episodes.map((ep) => [ep.title.toLowerCase(), ep.id] as const));
  for (const memo of review.episodeMemosToUpdate) {
    const episodeId = episodeTitleToId.get(memo.episodeTitle.toLowerCase());
    if (!episodeId) continue;
    await saveEpisodeMemo(projectId, episodeId, memo.content);
    reviewResult.updatedEpisodeMemos += 1;
  }

  return reviewResult;
}
