import { generateObject } from "ai";
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { createModel } from "../ai/provider.ts";
import type { AiSettings } from "../settings.ts";

export type ImportItemType = "character" | "world" | "episode" | "memo" | "projectMemo" | "ignore" | "unknown";

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

export interface ImportFileInput {
  path: string;
  filename: string;
  type: ImportItemType;
  title: string;
  content: string;
  fields?: Record<string, string>;
  episodeTitle?: string;
}

export interface ImportResult {
  characters: number;
  worldEntries: number;
  episodes: number;
  memos: number;
  skippedMemos: number;
  projectMemos: number;
}

const SNIPPET_LENGTH = 2000;

const VALID_IMPORT_TYPES: ImportItemType[] = [
  "character",
  "world",
  "episode",
  "memo",
  "projectMemo",
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
      type: z.string().describe("分類結果。character/world/episode/memo/projectMemo/ignore のいずれか"),
      title: z.string().describe("推定したタイトルや名前"),
      fields: z.record(z.string(), z.string()).optional().describe("character/world の場合の各フィールド"),
      episodeTitle: z.string().optional().describe("memo の場合に紐づくエピソードのタイトル"),
      reason: z.string().describe("分類理由"),
    }),
  ),
});

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
- ignore: 取り込みに不向きなファイル（索引、履歴、一時メモなど）

各ファイルの内容の先頭部分を参考に判断してください。
ファイル名やフォルダ名もヒントとして使って構いません。

キャラクター用フィールド名: name, alias, role, gender, age, birthday, bloodType, height, weight, appearance, personality, individuality, skills, specialSkills, upbringing, background, notes
世界観用フィールド名: name, category, era, geography, climate, population, politics, laws, economy, military, religion, language, culture, history, technology, notes

エピソードの場合は title を抽出してください。
memo の場合は episodeTitle に紐づくエピソードのタイトルを推定してください。紐づくエピソードが不明な場合は空文字にしてください。
projectMemo の場合は title をメモのタイトルとして抽出してください。
分類理由を reason に簡潔に書いてください。

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

function toImportFileInput(
  candidate: AiImportCandidate,
  file: File,
): Promise<ImportFileInput> {
  return file.text().then((content) => ({
    path: candidate.path,
    filename: candidate.filename,
    type: candidate.type,
    title: candidate.title,
    content,
    fields: candidate.fields,
    episodeTitle: candidate.episodeTitle,
  }));
}

export async function applyImport(
  projectId: string,
  candidates: AiImportCandidate[],
  files: File[],
): Promise<ImportResult> {
  const pathToFile = new Map(files.map((file) => [getFilePath(file), file]));

  const inputs: ImportFileInput[] = [];
  for (const candidate of candidates) {
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
