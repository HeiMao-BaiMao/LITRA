import { generateObject } from "ai";
import { z } from "zod";
import { createModel } from "./provider.ts";
import { limitPromptText } from "./prompts.ts";
import type { AiSettings } from "../settings.ts";
import { loadEpisode, loadEpisodeList } from "../project/episodes.ts";
import { loadCharacters, loadWorldEntries } from "../project/settings.ts";
import { loadRelationships } from "../project/relationships.ts";
import { loadEpisodeMemo } from "../project/memos.ts";
import { listProjectMemos, type ProjectMemo } from "../project/project-memo.ts";
import { loadSummaries } from "../project/summaries.ts";
import type {
  Character,
  WorldEntry,
  CharacterRelationshipMap,
  Episode,
  EpisodeSummaryMap,
} from "../project/schema.ts";

export const consistencyCheckSchema = z.object({
  issues: z
    .array(
      z.object({
        category: z
          .enum([
            "character",
            "world",
            "timeline",
            "plot",
            "relationship",
            "description",
            "other",
          ])
          .describe("矛盾のカテゴリ"),
        location: z
          .string()
          .optional()
          .describe("該当箇所（行番号やエピソードIDなど）"),
        description: z.string().describe("矛盾・不整合の内容"),
        evidence: z
          .string()
          .describe("根拠となった本文または設定の抜粋"),
        suggestion: z.string().describe("修正案または補足すべき内容"),
      }),
    )
    .describe("発見された矛盾・不整合のリスト。問題がなければ空配列"),
  summary: z.string().describe("全体の総括"),
});

export type ConsistencyCheckResult = z.infer<typeof consistencyCheckSchema>;

interface ConsistencyContext {
  episode: Episode;
  fullText: string;
  characters: Character[];
  worldEntries: WorldEntry[];
  relationshipsMap: CharacterRelationshipMap;
  episodeMemoContent: string;
  projectMemos: ProjectMemo[];
  summaries: EpisodeSummaryMap;
  allEpisodes: Episode[];
}

const BUDGETS = {
  characters: 20000,
  worldEntries: 20000,
  relationships: 10000,
  episodeMemo: 5000,
  projectMemos: 10000,
  otherSummaries: 20000,
};

function formatCharacter(character: Character): string {
  const fields: [string, string][] = [
    ["名前", character.name],
    ["別名", character.alias],
    ["役割", character.role],
    ["性別", character.gender],
    ["年齢", character.age],
    ["誕生日", character.birthday],
    ["血液型", character.bloodType],
    ["身長", character.height],
    ["体重", character.weight],
    ["見た目", character.appearance],
    ["性格", character.personality],
    ["個性", character.individuality],
    ["能力・スキル", character.skills],
    ["特技", character.specialSkills],
    ["生い立ち", character.upbringing],
    ["背景", character.background],
    ["メモ", character.notes],
    ...(character.customFields ?? []).map((f): [string, string] => [f.label, f.value]),
  ];
  const lines = fields
    .filter(([, value]) => value.trim().length > 0)
    .map(([label, value]) => `  - ${label}: ${value}`);
  return lines.length > 0 ? `■ ${character.name || "（無題）"}\n${lines.join("\n")}` : `■ ${character.name || "（無題）"}`;
}

function formatWorldEntry(entry: WorldEntry): string {
  const fields: [string, string][] = [
    ["名称", entry.name],
    ["カテゴリ", entry.category],
    ["時代", entry.era],
    ["地理", entry.geography],
    ["気候", entry.climate],
    ["人口", entry.population],
    ["政治", entry.politics],
    ["法律", entry.laws],
    ["経済", entry.economy],
    ["軍事", entry.military],
    ["宗教", entry.religion],
    ["言語", entry.language],
    ["文化", entry.culture],
    ["歴史", entry.history],
    ["技術", entry.technology],
    ["メモ", entry.notes],
    ...(entry.customFields ?? []).map((f): [string, string] => [f.label, f.value]),
  ];
  const lines = fields
    .filter(([, value]) => value.trim().length > 0)
    .map(([label, value]) => `  - ${label}: ${value}`);
  return lines.length > 0 ? `■ ${entry.name || "（無題）"} (${entry.category})\n${lines.join("\n")}` : `■ ${entry.name || "（無題）"} (${entry.category})`;
}

function formatRelationships(map: CharacterRelationshipMap, characters: Character[]): string {
  const nameById = new Map(characters.map((c) => [c.id, c.name || c.id]));
  const lines: string[] = [];
  for (const group of map.groups) {
    const prefix = group.episodeId ? `[エピソード: ${group.episodeId}]` : "[全体]";
    for (const rel of group.relationships) {
      const a = nameById.get(rel.characterAId) ?? rel.characterAId;
      const b = nameById.get(rel.characterBId) ?? rel.characterBId;
      const dir =
        rel.direction === "a-to-b"
          ? `${a} → ${b}`
          : rel.direction === "b-to-a"
            ? `${a} ← ${b}`
            : `${a} ↔ ${b}`;
      lines.push(`${prefix} ${dir}: ${rel.description}`);
    }
  }
  return lines.join("\n");
}

function formatProjectMemos(memos: ProjectMemo[]): string {
  return memos
    .map((m) => `■ ${m.title}\n${m.content}`)
    .join("\n\n");
}

function formatOtherEpisodeSummaries(
  targetEpisodeId: string,
  allEpisodes: Episode[],
  summaries: EpisodeSummaryMap,
): string {
  const lines: string[] = [];
  for (const ep of allEpisodes) {
    if (ep.id === targetEpisodeId) continue;
    const summary = summaries.summaries[ep.id];
    if (!summary) continue;
    lines.push(
      `■ ${ep.title || "無題"} (${ep.order + 1}話)\n${summary.oneLiner}\n${summary.content}`,
    );
  }
  return lines.join("\n\n");
}

async function loadConsistencyContext(
  projectId: string,
  episodeId: string,
): Promise<ConsistencyContext> {
  const [episodeList, characters, worldEntries, relationshipsMap, projectMemos, summaries] =
    await Promise.all([
      loadEpisodeList(projectId),
      loadCharacters(projectId),
      loadWorldEntries(projectId),
      loadRelationships(projectId),
      listProjectMemos(projectId),
      loadSummaries(projectId),
    ]);

  const episode = episodeList.episodes.find((ep) => ep.id === episodeId);
  if (!episode) {
    throw new Error(`エピソードが見つかりません: ${episodeId}`);
  }

  const [fullText, episodeMemo] = await Promise.all([
    loadEpisode(projectId, episode.fileName),
    loadEpisodeMemo(projectId, episodeId),
  ]);

  return {
    episode,
    fullText,
    characters: characters.characters,
    worldEntries: worldEntries.entries,
    relationshipsMap,
    episodeMemoContent: episodeMemo?.content ?? "",
    projectMemos,
    summaries,
    allEpisodes: episodeList.episodes,
  };
}

function buildConsistencyPrompt(context: ConsistencyContext, focus?: string): string {
  const charactersText = limitPromptText(
    context.characters.map(formatCharacter).join("\n\n"),
    BUDGETS.characters,
    "head",
  );
  const worldText = limitPromptText(
    context.worldEntries.map(formatWorldEntry).join("\n\n"),
    BUDGETS.worldEntries,
    "head",
  );
  const relationshipsText = limitPromptText(
    formatRelationships(context.relationshipsMap, context.characters),
    BUDGETS.relationships,
    "head",
  );
  const projectMemosText = limitPromptText(
    formatProjectMemos(context.projectMemos),
    BUDGETS.projectMemos,
    "head",
  );
  const otherSummariesText = limitPromptText(
    formatOtherEpisodeSummaries(context.episode.id, context.allEpisodes, context.summaries),
    BUDGETS.otherSummaries,
    "head",
  );

  const focusSection = focus
    ? `\n【重点的に確認してほしい点】\n${focus}\n`
    : "";

  return `以下の小説本文と設定資料を照らし合わせて、矛盾・不整合・設定違反を検出してください。
${focusSection}
【対象エピソード】
タイトル: ${context.episode.title || "無題"}
ID: ${context.episode.id}

【本文】
${context.fullText}

【キャラクター設定】
${charactersText}

【世界観設定】
${worldText}

【人間関係】
${relationshipsText}

【エピソード覚え書き】
${context.episodeMemoContent || "（なし）"}

【作品メモ】
${projectMemosText || "（なし）"}

【他エピソード要約】
${otherSummariesText || "（なし）"}

以上を基に、以下の観点でチェックしてください。
- キャラクターの見た目・性格・年齢・能力などが本文と一致しているか
- 世界観・歴史・技術・地理などに違反していないか
- 時系列や過去の出来事と矛盾していないか
- 人間関係や立場が設定と整合しているか
- 同じ人物の口調・一人称・呼び方が一貫しているか
- 描写が場面内で矛盾していないか

問題がなければ issues は空配列にしてください。`;
}

export async function checkConsistency(
  settings: AiSettings,
  projectId: string,
  episodeId: string,
  focus?: string,
): Promise<ConsistencyCheckResult> {
  const context = await loadConsistencyContext(projectId, episodeId);
  const prompt = buildConsistencyPrompt(context, focus);

  const result = await generateObject({
    model: createModel(settings),
    schema: consistencyCheckSchema,
    system:
      "あなたは日本語創作小説の設定整合性を専門にチェックする編集者です。本文と設定資料を厳密に照らし合わせ、客観的な根拠に基づいて矛盾を指摘してください。推測で断定せず、資料に基づくものだけを挙げてください。",
    prompt,
    maxOutputTokens: 4096,
    temperature: 0.2,
  });

  return result.object;
}
