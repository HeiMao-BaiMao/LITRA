import { generateObject } from "ai";
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { createModel } from "../ai/provider.ts";
import type { AiSettings } from "../settings.ts";

export type ImportItemType = "character" | "world" | "episode" | "memo" | "projectMemo" | "relationship" | "ignore" | "unknown";

export interface ImportCandidate {
  type: ImportItemType;
  filename: string;
  title: string;
}

export interface AiImportCandidate extends ImportCandidate {
  path: string;
  fields?: Record<string, string>;
  episodeTitle?: string;
  reason?: string;
}

export interface ImportRelationship {
  episodeTitle: string;
  characterAName: string;
  characterBName: string;
  direction: "a-to-b" | "b-to-a" | "mutual";
  description: string;
}

export interface ImportFileInput {
  path: string;
  filename: string;
  type: ImportItemType;
  title: string;
  content: string;
  fields?: Record<string, string>;
  episodeTitle?: string;
  relationships?: ImportRelationship[];
}

export interface ImportResult {
  characters: number;
  worldEntries: number;
  episodes: number;
  memos: number;
  skippedMemos: number;
  projectMemos: number;
  relationships: number;
  skippedRelationships: number;
}

const SNIPPET_LENGTH = 2000;

const VALID_IMPORT_TYPES: ImportItemType[] = [
  "character",
  "world",
  "episode",
  "memo",
  "projectMemo",
  "relationship",
  "ignore",
  "unknown",
];

function normalizeImportType(raw: string): ImportItemType {
  const normalized = raw.trim().toLowerCase().replace(/[-_\s]/g, "");
  switch (normalized) {
    case "character":
    case "char":
      return "character";
    case "world":
      return "world";
    case "episode":
    case "chapter":
    case "scene":
      return "episode";
    case "memo":
    case "episodememo":
      return "memo";
    case "projectmemo":
    case "projectmemos":
    case "workmemo":
    case "novelmemo":
      return "projectMemo";
    case "relationship":
    case "relationships":
    case "relation":
    case "relations":
    case "humanrelation":
    case "characterrelation":
      return "relationship";
    case "ignore":
    case "skip":
    case "other":
      return "ignore";
    default:
      return "unknown";
  }
}

const classificationSchema = z.object({
  files: z.array(
    z.object({
      path: z.string().describe("ファイルの相対パス"),
      type: z.string().describe("分類結果。character/world/episode/memo/projectMemo/relationship/ignore のいずれか"),
      title: z.string().describe("推定したタイトルや名前"),
      fields: z.record(z.string(), z.string()).optional().describe("character/world の場合の各フィールド"),
      episodeTitle: z.string().optional().describe("memo の場合に紐づくエピソードのタイトル"),
      reason: z.string().describe("分類理由"),
    }),
  ),
});

const characterTransformSchema = z.object({
  title: z.string().describe("キャラクターの名前。ファイル名や内容から最も適切な呼称を選んでください"),
  fields: z
    .record(z.string(), z.string())
    .describe(
      "name, alias, role, gender, age, birthday, bloodType, height, weight, appearance, personality, individuality, skills, specialSkills, upbringing, background, notes など。取得できない項目は空文字にしてください。",
    ),
});

const worldTransformSchema = z.object({
  title: z.string().describe("項目の名前。ファイル名や内容から最も適切な呼称を選んでください"),
  fields: z
    .record(z.string(), z.string())
    .describe(
      "name, category, era, geography, climate, population, politics, laws, economy, military, religion, language, culture, history, technology, notes など。取得できない項目は空文字にしてください。",
    ),
});

const episodeTransformSchema = z.object({
  title: z.string().describe("エピソードのタイトル"),
  content: z.string().describe("不要なメタ情報やYAMLフロントマターを除いた、整理済みの小説本文"),
});

const memoTransformSchema = z.object({
  episodeTitle: z.string().describe("紐づくエピソードのタイトル。不明な場合は空文字"),
  content: z.string().describe("整理済みのメモ本文"),
});

const projectMemoTransformSchema = z.object({
  title: z.string().describe("メモのタイトル"),
  content: z.string().describe("整理済みのメモ本文"),
});

const relationshipTransformSchema = z.object({
  relationships: z
    .array(
      z.object({
        episodeTitle: z
          .string()
          .default("")
          .describe("関係が紐づくエピソードのタイトル。全体（全話共通）の場合は空文字"),
        characterAName: z.string().describe("関係の一方のキャラクター名"),
        characterBName: z.string().describe("関係のもう一方のキャラクター名"),
        direction: z
          .string()
          .default("mutual")
          .describe("関係の向き。a-to-b=A→B, b-to-a=A←B, mutual=A↔B"),
        description: z.string().default("").describe("関係の説明（例：幼馴染で互いに信頼している）"),
      }),
    )
    .default([]),
});

function normalizeRelationshipDirection(raw: string): "a-to-b" | "b-to-a" | "mutual" {
  const normalized = raw.trim().toLowerCase().replace(/[-_\s]/g, "");
  if (normalized.includes("atob") || normalized.includes("a→b") || normalized.includes("a->b")) {
    return "a-to-b";
  }
  if (normalized.includes("btoa") || normalized.includes("b→a") || normalized.includes("b->b")) {
    return "b-to-a";
  }
  return "mutual";
}

function fileNameToTitle(filename: string): string {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? filename;
  return base.replace(/\.(md|txt|csv)$/i, "").trim();
}

function getFilePath(file: File): string {
  return file.webkitRelativePath || file.name;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "\n...（以下省略）";
}

function buildClassifyPrompt(files: { path: string; snippet: string }[]): string {
  const lines = files.map((file) => {
    const escapedSnippet = file.snippet.replace(/```/g, "`\u200B`\u200B`");
    return `### ${file.path}\n\`\`\`\n${escapedSnippet}\n\`\`\``;
  });

  return `あなたは創作支援アプリのデータ取り込みアシスタントです。
ユーザーが指定したフォルダ内のテキストファイルを、以下のいずれかに分類してください。

- character: キャラクター設定（名前、外見、性格、背景、能力などが主体）
- world: 世界観設定（場所、組織、魔法体系、歴史、文化などが主体）
- episode: 小説の本文（話のプロットやシーン展開が主体）
- memo: 特定のエピソードに紐づく覚え書きやメモ
- projectMemo: プロジェクト全体の自由メモ・設定覚書き（エピソードに紐づかない雑多なメモ、全体方針、TODOなど）
- relationship: キャラクター間の人間関係・相関図（「AとBは幼馴染」「CはDを憎んでいる」など）
- ignore: 取り込みに不向きなファイル（索引、履歴、一時メモなど）

分類例:
- 「名前: 太郎 / 年齢: 20 / 性格は明るい」→ character
- 「王都は中央に位置し、四大貴族が支配する」→ world
- 「# 第一話\n\n　かつてこの地には——」→ episode
- 「第一話の戦闘シーンで使う術の覚え書き」→ memo（episodeTitle は「第一話」）
- 「全体の時間軸整理メモ。あとで改稿する」→ projectMemo
- 「太郎と花子は幼馴染。三郎は太郎を尊敬している」→ relationship
- 「ファイル一覧 / 更新履歴 / 仮メモの断片」→ ignore

各ファイルの内容の先頭部分を参考に判断してください。
ファイル名やフォルダ名もヒントとして使って構いません。

キャラクター用フィールド名: name, alias, role, gender, age, birthday, bloodType, height, weight, appearance, personality, individuality, skills, specialSkills, upbringing, background, notes
世界観用フィールド名: name, category, era, geography, climate, population, politics, laws, economy, military, religion, language, culture, history, technology, notes

出力は次の JSON 形式にしてください。type は必ず character/world/episode/memo/projectMemo/relationship/ignore のいずれかの文字列を使用してください。

\`\`\`json
{
  "files": [
    {
      "path": "chars/hero.md",
      "type": "character",
      "title": "主人公",
      "fields": { "name": "太郎", "age": "20" },
      "reason": "名前や年齢、性格が書かれているため"
    },
    {
      "path": "world/kingdom.md",
      "type": "world",
      "title": "王都",
      "fields": { "category": "場所" },
      "reason": "世界観の地理と政治が主体"
    },
    {
      "path": "episodes/01.md",
      "type": "episode",
      "title": "第一話",
      "reason": "本文のプロット"
    },
    {
      "path": "memos/battle.md",
      "type": "memo",
      "title": "戦闘覚え書き",
      "episodeTitle": "第一話",
      "reason": "特定エピソードの覚え書き"
    },
    {
      "path": "memos/plan.md",
      "type": "projectMemo",
      "title": "全体方針",
      "reason": "エピソードに紐づかない全体メモ"
    },
    {
      "path": "relations/main.md",
      "type": "relationship",
      "title": "キャラクター相関図",
      "reason": "キャラクター間の関係が主体"
    },
    {
      "path": "draft/index.md",
      "type": "ignore",
      "title": "索引",
      "reason": "取り込みに不向きな索引"
    }
  ]
}
\`\`\`

以下のファイルを分類してください。

${lines.join("\n\n")}`;
}

export async function classifyFilesWithAI(
  files: File[],
  settings: AiSettings,
): Promise<AiImportCandidate[]> {
  const textFiles = files.filter((file) => /\.(md|txt|csv)$/i.test(file.name));
  if (textFiles.length === 0) return [];

  const fileInfos = await Promise.all(
    textFiles.map(async (file) => ({
      path: getFilePath(file),
      snippet: truncate(await file.text(), SNIPPET_LENGTH),
    })),
  );

  const result = await generateObject({
    model: createModel(settings),
    schema: classificationSchema,
    system:
      "創作データの取り込みを支援するアシスタントです。与えられたファイルを適切なカテゴリに分類し、構造化された JSON を返してください。",
    prompt: buildClassifyPrompt(fileInfos),
    maxOutputTokens: 16384,
    temperature: 0.3,
  });

  const classified = result.object.files ?? [];
  const pathToFile = new Map(textFiles.map((file) => [getFilePath(file), file]));

  return classified
    .map((item): AiImportCandidate | null => {
      const file = pathToFile.get(item.path);
      if (!file) return null;
      const type = normalizeImportType(item.type);
      if (!VALID_IMPORT_TYPES.includes(type)) return null;
      return {
        type,
        filename: file.name,
        title: item.title || fileNameToTitle(file.name),
        path: item.path,
        fields: item.fields,
        episodeTitle: item.episodeTitle,
        reason: item.reason,
      };
    })
    .filter((item): item is AiImportCandidate => item != null);
}

function buildCharacterTransformPrompt(title: string, content: string): string {
  return `あなたは創作支援アプリの編集アシスタントです。
以下のテキストを読み込み、キャラクター設定として整理・書き換えてください。

元のファイルの推定タイトル: ${title}

---
${content}
---

出力は次の JSON 形式にしてください。
- title: キャラクターの名前（最も適切な呼称）
- fields: name, alias, role, gender, age, birthday, bloodType, height, weight, appearance, personality, individuality, skills, specialSkills, upbringing, background, notes などを含むオブジェクト。取得できない項目は空文字にしてください。`;
}

function buildWorldTransformPrompt(title: string, content: string): string {
  return `あなたは創作支援アプリの編集アシスタントです。
以下のテキストを読み込み、世界観設定項目として整理・書き換えてください。

元のファイルの推定タイトル: ${title}

---
${content}
---

出力は次の JSON 形式にしてください。
- title: 項目の名前（最も適切な呼称）
- fields: name, category, era, geography, climate, population, politics, laws, economy, military, religion, language, culture, history, technology, notes などを含むオブジェクト。取得できない項目は空文字にしてください。`;
}

function buildEpisodeTransformPrompt(title: string, content: string): string {
  return `あなたは創作支援アプリの編集アシスタントです。
以下のテキストを読み込み、小説のエピソード本文として整理・書き換えてください。

元のファイルの推定タイトル: ${title}

---
${content}
---

出力は次の JSON 形式にしてください。
- title: エピソードのタイトル
- content: 不要なメタ情報やYAMLフロントマターを除いた、整理済みの小説本文`;
}

function buildMemoTransformPrompt(title: string, content: string): string {
  return `あなたは創作支援アプリの編集アシスタントです。
以下のテキストを読み込み、エピソードに紐づく覚え書きとして整理・書き換えてください。

元のファイルの推定タイトル: ${title}

---
${content}
---

出力は次の JSON 形式にしてください。
- episodeTitle: 紐づくエピソードのタイトル。不明な場合は空文字
- content: 整理済みのメモ本文`;
}

function buildProjectMemoTransformPrompt(title: string, content: string): string {
  return `あなたは創作支援アプリの編集アシスタントです。
以下のテキストを読み込み、作品全体の自由メモとして整理・書き換えてください。

元のファイルの推定タイトル: ${title}

---
${content}
---

出力は次の JSON 形式にしてください。
- title: メモのタイトル
- content: 整理済みのメモ本文`;
}

function buildRelationshipTransformPrompt(
  title: string,
  content: string,
  characterNames: string[],
  episodeTitles: string[],
): string {
  const characterList = characterNames.length > 0 ? characterNames.join(", ") : "（なし）";
  const episodeList = episodeTitles.length > 0 ? episodeTitles.join(", ") : "（なし）";

  return `あなたは創作支援アプリの編集アシスタントです。
以下のテキストを読み込み、キャラクター間の人間関係を **すべて** 抽出・整理してください。

元のファイルの推定タイトル: ${title}

---
${content}
---

この取り込みバッチで検出されているキャラクター名: ${characterList}
検出されているエピソードタイトル: ${episodeList}

上記の名前を優先的に使って関係を記述してください。
ファイル内の呼び方が異なる場合（愛称・姓・役割名など）は、検出されているキャラクター名に置き換えて出力してください。

出力は次の JSON 形式にしてください。
- relationships: 関係の配列。各要素は次のフィールドを持ちます。
  - episodeTitle: 関係が紐づくエピソードのタイトル。全体（全話共通）の場合は空文字。検出されているエピソードタイトルから選んでください。
  - characterAName: 関係の一方のキャラクター名。検出されているキャラクター名から選んでください。
  - characterBName: 関係のもう一方のキャラクター名。検出されているキャラクター名から選んでください。
  - direction: 関係の向き。a-to-b（A→B）/ b-to-a（A←B）/ mutual（A↔B）のいずれか
  - description: 関係の説明

例:
\`\`\`json
{
  "relationships": [
    {
      "episodeTitle": "第一話",
      "characterAName": "太郎",
      "characterBName": "花子",
      "direction": "mutual",
      "description": "幼馴染で互いに信頼している"
    },
    {
      "episodeTitle": "",
      "characterAName": "三郎",
      "characterBName": "太郎",
      "direction": "b-to-a",
      "description": "三郎は太郎を尊敬している"
    }
  ]
}
\`\`\`

同じ行に複数の関係があっても、個別の要素に分解してください。
関係が見つからない場合は空の配列 [] を返してください。`;
}

interface TransformContext {
  characterNames: string[];
  episodeTitles: string[];
}

async function transformOne(
  candidate: AiImportCandidate,
  content: string,
  settings: AiSettings,
  context: TransformContext,
): Promise<
  Partial<Pick<AiImportCandidate, "title" | "fields" | "episodeTitle">> & {
    content?: string;
    relationships?: ImportRelationship[];
  }
> {
  const system =
    "与えられた創作データを読み込み、アプリの項目に合わせて整理・書き換え、構造化された JSON を返してください。";

  switch (candidate.type) {
    case "character": {
      const result = await generateObject({
        model: createModel(settings),
        schema: characterTransformSchema,
        system,
        prompt: buildCharacterTransformPrompt(candidate.title, content),
        maxOutputTokens: 8192,
        temperature: 0.3,
      });
      return { title: result.object.title, fields: result.object.fields };
    }
    case "world": {
      const result = await generateObject({
        model: createModel(settings),
        schema: worldTransformSchema,
        system,
        prompt: buildWorldTransformPrompt(candidate.title, content),
        maxOutputTokens: 8192,
        temperature: 0.3,
      });
      return { title: result.object.title, fields: result.object.fields };
    }
    case "episode": {
      const result = await generateObject({
        model: createModel(settings),
        schema: episodeTransformSchema,
        system,
        prompt: buildEpisodeTransformPrompt(candidate.title, content),
        maxOutputTokens: 16384,
        temperature: 0.3,
      });
      return { title: result.object.title, content: result.object.content };
    }
    case "memo": {
      const result = await generateObject({
        model: createModel(settings),
        schema: memoTransformSchema,
        system,
        prompt: buildMemoTransformPrompt(candidate.title, content),
        maxOutputTokens: 8192,
        temperature: 0.3,
      });
      return { episodeTitle: result.object.episodeTitle, content: result.object.content };
    }
    case "projectMemo": {
      const result = await generateObject({
        model: createModel(settings),
        schema: projectMemoTransformSchema,
        system,
        prompt: buildProjectMemoTransformPrompt(candidate.title, content),
        maxOutputTokens: 8192,
        temperature: 0.3,
      });
      return { title: result.object.title, content: result.object.content };
    }
    case "relationship": {
      const result = await generateObject({
        model: createModel(settings),
        schema: relationshipTransformSchema,
        system,
        prompt: buildRelationshipTransformPrompt(
          candidate.title,
          content,
          context.characterNames,
          context.episodeTitles,
        ),
        maxOutputTokens: 8192,
        temperature: 0.3,
      });
      const relationships: ImportRelationship[] = result.object.relationships
        .map((rel) => ({
          episodeTitle: rel.episodeTitle.trim(),
          characterAName: rel.characterAName.trim(),
          characterBName: rel.characterBName.trim(),
          direction: normalizeRelationshipDirection(rel.direction),
          description: rel.description.trim(),
        }))
        .filter(
          (rel) =>
            rel.characterAName.length > 0 &&
            rel.characterBName.length > 0 &&
            rel.characterAName !== rel.characterBName,
        );
      console.log(
        `[phenex:import:transform] extracted ${relationships.length} relationships from ${candidate.path}`,
      );
      return { relationships };
    }
    default:
      return {};
  }
}

export async function transformImportFilesWithAI(
  candidates: AiImportCandidate[],
  files: File[],
  settings: AiSettings,
): Promise<AiImportCandidate[]> {
  const pathToFile = new Map(files.map((file) => [getFilePath(file), file]));
  const pathToContent = new Map<string, string>();

  const characterNames = new Set<string>();
  const episodeTitles = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.type === "character") {
      if (candidate.title) characterNames.add(candidate.title);
      if (candidate.fields?.name) characterNames.add(candidate.fields.name);
      if (candidate.fields?.alias) characterNames.add(candidate.fields.alias);
    } else if (candidate.type === "episode") {
      if (candidate.title) episodeTitles.add(candidate.title);
    }
  }
  const context: TransformContext = {
    characterNames: Array.from(characterNames),
    episodeTitles: Array.from(episodeTitles),
  };

  const results = await Promise.all(
    candidates.map(async (candidate) => {
      if (candidate.type === "ignore" || candidate.type === "unknown") {
        return candidate;
      }
      const file = pathToFile.get(candidate.path);
      if (!file) return candidate;

      const content = await file.text();
      pathToContent.set(candidate.path, content);

      try {
        const transformed = await transformOne(candidate, content, settings, context);
        return {
          ...candidate,
          title: transformed.title ?? candidate.title,
          fields: transformed.fields ?? candidate.fields,
          episodeTitle: transformed.episodeTitle ?? candidate.episodeTitle,
          transformedContent: transformed.content,
          relationships: transformed.relationships,
        };
      } catch (error) {
        console.error(`[phenex:import:transform] failed for ${candidate.path}`, error);
        return candidate;
      }
    }),
  );

  return results;
}

interface TransformableCandidate extends AiImportCandidate {
  transformedContent?: string;
  relationships?: ImportRelationship[];
}

function toImportFileInput(
  candidate: TransformableCandidate,
  file: File,
): Promise<ImportFileInput> {
  return file.text().then((content) => ({
    path: candidate.path,
    filename: candidate.filename,
    type: candidate.type,
    title: candidate.title,
    content: candidate.transformedContent ?? content,
    fields: candidate.fields,
    episodeTitle: candidate.episodeTitle,
    relationships: candidate.relationships,
  }));
}

export async function applyImport(
  projectId: string,
  candidates: AiImportCandidate[],
  files: File[],
  settings: AiSettings,
): Promise<ImportResult> {
  const pathToFile = new Map(files.map((file) => [getFilePath(file), file]));

  const transformed = await transformImportFilesWithAI(candidates, files, settings);

  const inputs: ImportFileInput[] = [];
  for (const candidate of transformed) {
    if (candidate.type === "ignore" || candidate.type === "unknown") continue;
    const file = pathToFile.get(candidate.path);
    if (!file) continue;
    inputs.push(await toImportFileInput(candidate, file));
  }

  return await invoke<ImportResult>("import_files", {
    projectId,
    files: inputs,
  });
}
