import { tool } from "ai";
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import type { CustomField } from "../project/schema.ts";

interface ValidationResult<T> {
  success: true;
  data: T;
}

interface ValidationError {
  success: false;
  error: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateCustomFields(value: unknown): ValidationResult<CustomField[]> | ValidationError {
  if (!Array.isArray(value)) {
    return { success: false, error: "customFields は配列である必要があります。例: [{label: '二人称', value: '君'}]" };
  }

  const normalized: CustomField[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!isPlainObject(item)) {
      return { success: false, error: `customFields[${i}] はオブジェクトである必要があります。` };
    }

    // label の代わりに key が使われていた場合は寛容に変換する
    const labelRaw = item.label ?? item.key;
    const valueRaw = item.value;

    if (typeof labelRaw !== "string" || labelRaw.trim() === "") {
      return {
        success: false,
        error: `customFields[${i}] には label（文字列）が必要です。誤って key を使っていないか確認してください。`,
      };
    }
    if (typeof valueRaw !== "string") {
      return { success: false, error: `customFields[${i}].value は文字列である必要があります。` };
    }

    normalized.push({ label: labelRaw.trim(), value: valueRaw });
  }

  return { success: true, data: normalized };
}

function validateStringField(name: string, value: unknown): ValidationResult<string> | ValidationError {
  if (typeof value === "string") {
    return { success: true, data: value };
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return { success: true, data: String(value) };
  }
  return {
    success: false,
    error: `"${name}" は文字列である必要があります。受け取った型: ${Array.isArray(value) ? "array" : typeof value}。`,
  };
}

function validateSettingsUpdates(
  updates: Record<string, unknown>,
  allowedFields: readonly string[],
): ValidationResult<Record<string, string | CustomField[]>> | ValidationError {
  const normalized: Record<string, string | CustomField[]> = {};
  const allowed = new Set(allowedFields);

  for (const [key, value] of Object.entries(updates)) {
    if (!allowed.has(key)) {
      return {
        success: false,
        error: `フィールド "${key}" は更新できません。使用可能なフィールド: ${allowedFields.join(", ")}。`,
      };
    }

    if (key === "customFields") {
      const result = validateCustomFields(value);
      if (!result.success) return result;
      normalized[key] = result.data;
      continue;
    }

    if (typeof value === "string") {
      normalized[key] = value;
      continue;
    }

    // 数値などは文字列に変換して寛容に受け入れる
    if (typeof value === "number" || typeof value === "boolean") {
      normalized[key] = String(value);
      continue;
    }

    return {
      success: false,
      error: `フィールド "${key}" の値が不正です。文字列（改行は \\n を使用）または customFields 配列のみ許可されています。受け取った型: ${Array.isArray(value) ? "array" : typeof value}。`,
    };
  }

  return { success: true, data: normalized };
}

function limitToolText(text: string, maxChars = 12000): string {
  if (text.length <= maxChars) return text;

  const marker = "\n\n【中略】\n\n";
  const available = Math.max(0, maxChars - marker.length);
  if (available <= 0) return text.slice(0, maxChars);

  const headChars = Math.ceil(available / 2);
  const tailChars = Math.floor(available / 2);
  return `${text.slice(0, headChars)}${marker}${text.slice(text.length - tailChars)}`;
}

function findById<T extends { id: string }>(items: T[], id: string): T | undefined {
  return items.find((item) => item.id === id);
}

async function rebuildSearchIndexQuietly(projectId: string): Promise<boolean> {
  try {
    await invoke("rebuild_search_index", { projectId });
    return true;
  } catch (error) {
    console.warn("[phenex] failed to rebuild search index after tool mutation:", error);
    return false;
  }
}

function wrapToolExecute<TInput, TOutput>(
  name: string,
  execute: (input: TInput) => Promise<TOutput>,
): (input: TInput) => Promise<TOutput | { error: string }> {
  return async (input) => {
    try {
      return await execute(input);
    } catch (error) {
      console.error(`[phenex] tool ${name} error:`, error);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };
}

export interface EditToolDependencies {
  projectId: string;
  episodeId: string;
  onApply: (newText: string) => void;
}

export interface SearchDependencies {
  projectId: string;
}

export interface SummaryToolDependencies {
  projectId: string;
  onSaveSummary?: (episodeId: string, content: string) => void;
  onSaveOneLiner?: (episodeId: string, oneLiner: string) => void;
}

interface EpisodeLineResult {
  lineNumber: number;
  text: string;
}

interface EpisodeLinesResponse {
  episodeId: string;
  title: string;
  order: number;
  totalLines: number;
  startLine: number;
  endLine: number;
  lines: EpisodeLineResult[];
  lineNumberedText: string;
}

interface EpisodeLineSearchMatch {
  startLine: number;
  endLine: number;
  expectedText: string;
  excerptStartLine: number;
  excerptEndLine: number;
  lineNumberedText: string;
}

interface EpisodeLineSearchResponse {
  episodeId: string;
  title: string;
  order: number;
  totalLines: number;
  query: string;
  matches: EpisodeLineSearchMatch[];
}

const editInputSchema = z
  .object({
    startLine: z.number().int().min(1).describe("置き換え開始行（1始まり）"),
    endLine: z.number().int().min(1).describe("置き換え終了行（1始まり）"),
    expectedText: z.string().describe("該当行範囲の現在の正確なテキスト"),
    replacementText: z.string().describe("挿入する置き換え後のテキスト"),
  })
  .refine((value) => value.endLine >= value.startLine, {
    message: "endLine は startLine 以上である必要があります。",
    path: ["endLine"],
  });

export function createEditEpisodeTool(deps: EditToolDependencies) {
  return tool({
    description:
      "指定した行範囲の内容が一致している場合に、その範囲を置き換えます。行番号は1始まりです。expectedText には該当行範囲の正確なテキスト、replacementText には置き換え後の正確なテキストを指定してください。",
    inputSchema: editInputSchema,
    execute: wrapToolExecute("editEpisode", async ({ startLine, endLine, expectedText, replacementText }) => {
      const result = await invoke<{
        success: boolean;
        message: string;
        newText?: string;
        actualText?: string;
        totalLines?: number;
      }>("edit_episode_text", {
        req: {
          projectId: deps.projectId,
          episodeId: deps.episodeId,
          startLine,
          endLine,
          expectedText,
          replacementText,
        },
      });
      if (result.success && result.newText != null) {
        deps.onApply(result.newText);
      }
      const searchIndexUpdated = result.success ? await rebuildSearchIndexQuietly(deps.projectId) : false;
      return {
        success: result.success,
        message: result.message,
        totalLines: result.totalLines,
        actualText: result.actualText != null ? limitToolText(result.actualText) : undefined,
        applied: result.success,
        editedLineRange: { startLine, endLine },
        replacementLineCount: replacementText.split("\n").length,
        searchIndexUpdated,
      };
    }),
  });
}

const getEpisodeLinesInputSchema = z.object({
  episodeId: z.string().describe("行番号付きで取得するエピソードのID"),
  startLine: z.number().int().min(1).optional().describe("取得開始行（1始まり）。省略時は1行目"),
  endLine: z.number().int().min(1).optional().describe("取得終了行（1始まり、両端含む）。省略時は最終行"),
});

export function createGetEpisodeLinesTool(deps: SearchDependencies) {
  return tool({
    description:
      "指定したエピソード本文を行番号付きで取得します。editEpisode の startLine/endLine/expectedText を決めるために使ってください。行範囲を指定するとその範囲だけ返します。",
    inputSchema: getEpisodeLinesInputSchema,
    execute: wrapToolExecute("getEpisodeLines", async ({ episodeId, startLine, endLine }) => {
      return await invoke<EpisodeLinesResponse>("get_episode_lines", {
        req: {
          projectId: deps.projectId,
          episodeId,
          startLine,
          endLine,
        },
      });
    }),
  });
}

const findEpisodeLinesInputSchema = z.object({
  episodeId: z.string().describe("検索するエピソードのID"),
  query: z.string().describe("探したい本文中の正確な語句・一文・一部フレーズ"),
  contextLines: z.number().int().min(0).max(50).optional().describe("一致行の前後に付ける行数（デフォルト3）"),
  maxMatches: z.number().int().min(1).max(200).optional().describe("返す候補数（デフォルト20）"),
  caseSensitive: z.boolean().optional().describe("大文字小文字を区別するか（デフォルトtrue）"),
});

export function createFindEpisodeLinesTool(deps: SearchDependencies) {
  return tool({
    description:
      "指定したエピソード本文から語句を検索し、一致した行番号、周辺の行番号付き本文、editEpisode に使える expectedText を返します。行番号を数える代わりに必ずこのツールを使ってください。",
    inputSchema: findEpisodeLinesInputSchema,
    execute: wrapToolExecute("findEpisodeLines", async ({ episodeId, query, contextLines, maxMatches, caseSensitive }) => {
      return await invoke<EpisodeLineSearchResponse>("find_episode_lines", {
        req: {
          projectId: deps.projectId,
          episodeId,
          query,
          contextLines,
          maxMatches,
          caseSensitive,
        },
      });
    }),
  });
}

export function createListEpisodesTool(deps: SearchDependencies) {
  return tool({
    description:
      "登録されているエピソードの一行要約一覧を取得します。過去話の内容を確認したい場合に、まずこのツールで該当エピソードを特定してください。",
    inputSchema: z.object({}),
    execute: wrapToolExecute("listEpisodes", async () => {
      return await invoke<{
        episodeId: string;
        order: number;
        title: string;
        oneLineSummary: string;
      }[]>("list_episodes_with_summaries", { projectId: deps.projectId });
    }),
  });
}

const retrieveInputSchema = z.object({
  episodeId: z.string().describe("取得するエピソードのID"),
  type: z
    .enum(["summary", "fullText"])
    .describe("取得する内容。summary=要約、fullText=本文"),
});

export function createRetrieveEpisodeTool(deps: SearchDependencies) {
  return tool({
    description:
      "指定したエピソードの要約または本文全文を取得します。行番号が必要な本文編集では findEpisodeLines または getEpisodeLines を使ってください。",
    inputSchema: retrieveInputSchema,
    execute: wrapToolExecute("retrieveEpisode", async ({ episodeId, type }) => {
      return await invoke<{
        episodeId: string;
        title: string;
        order: number;
        contentType: string;
        content: string;
      }>("retrieve_episode_content", {
        req: {
          projectId: deps.projectId,
          episodeId,
          contentType: type,
        },
      });
    }),
  });
}

const searchInputSchema = z.object({
  query: z.string().describe("検索キーワードやフレーズ"),
  limit: z.number().int().min(1).max(50).optional().describe("返す結果の最大数（デフォルト5）"),
});

export function createSearchEpisodesTool(deps: SearchDependencies) {
  return tool({
    description:
      "エピソード本文・要約を全文検索します。登場人物の名前、地名、過去の出来事などを探したい場合に使用してください。",
    inputSchema: searchInputSchema,
    execute: wrapToolExecute("searchEpisodes", async ({ query, limit }) => {
      return await invoke<{
        score: number;
        episodeId: string;
        title: string;
        docType: string;
        snippet: string;
      }[]>("search_episodes", {
        req: {
          projectId: deps.projectId,
          query,
          limit,
        },
      });
    }),
  });
}

export function createRebuildSearchIndexTool(deps: SearchDependencies) {
  return tool({
    description:
      "内部検索インデックスを最新のエピソード内容で再構築します。インデックスが古い可能性がある場合や、検索結果がない場合に使用してください。",
    inputSchema: z.object({}),
    execute: wrapToolExecute("rebuildSearchIndex", async () => {
      return await invoke<{
        success: boolean;
        message: string;
        indexedDocuments: number;
      }>("rebuild_search_index", { projectId: deps.projectId });
    }),
  });
}

const saveSummaryInputSchema = z.object({
  episodeId: z.string().describe("要約を保存するエピソードのID"),
  content: z.string().describe("エピソードの要約文。本文の内容をまとめたもの。長文や改行を含んでも構いません。"),
});

export function createSaveEpisodeSummaryTool(deps: SummaryToolDependencies) {
  return tool({
    description:
      "指定したエピソードの要約を保存または更新します。retrieveEpisode で本文を確認し、内容を要約してから呼び出してください。要約は長くても構いません。",
    inputSchema: saveSummaryInputSchema,
    execute: wrapToolExecute("saveEpisodeSummary", async ({ episodeId, content }) => {
      const validation = validateStringField("content", content);
      if (!validation.success) {
        return { error: `saveEpisodeSummary の入力が不正です: ${validation.error}` };
      }

      await invoke("save_episode_summary", {
        req: {
          projectId: deps.projectId,
          episodeId,
          content: validation.data,
        },
      });
      const searchIndexUpdated = await rebuildSearchIndexQuietly(deps.projectId);
      deps.onSaveSummary?.(episodeId, validation.data);
      return { success: true, message: "要約を保存しました。", searchIndexUpdated };
    }),
  });
}

const saveOneLinerInputSchema = z.object({
  episodeId: z.string().describe("一行要約を保存するエピソードのID"),
  oneLiner: z.string().describe("エピソードの一行要約。短くまとめたもの。"),
});

export function createSaveEpisodeOneLinerTool(deps: SummaryToolDependencies) {
  return tool({
    description:
      "指定したエピソードの一行要約を保存または更新します。saveEpisodeSummary の後に、さらに短く圧縮したものを保存する際に使用してください。",
    inputSchema: saveOneLinerInputSchema,
    execute: wrapToolExecute("saveEpisodeOneLiner", async ({ episodeId, oneLiner }) => {
      const validation = validateStringField("oneLiner", oneLiner);
      if (!validation.success) {
        return { error: `saveEpisodeOneLiner の入力が不正です: ${validation.error}` };
      }

      await invoke("save_episode_one_liner", {
        req: {
          projectId: deps.projectId,
          episodeId,
          oneLiner: validation.data,
        },
      });
      deps.onSaveOneLiner?.(episodeId, validation.data);
      return { success: true, message: "一行要約を保存しました。" };
    }),
  });
}

import type { Character, WorldEntry } from "../project/schema.ts";

const CHARACTER_UPDATE_FIELDS = [
  "name",
  "alias",
  "role",
  "gender",
  "age",
  "birthday",
  "bloodType",
  "height",
  "weight",
  "appearance",
  "personality",
  "individuality",
  "skills",
  "specialSkills",
  "upbringing",
  "background",
  "notes",
  "customFields",
] as const;

const WORLD_ENTRY_UPDATE_FIELDS = [
  "name",
  "category",
  "era",
  "geography",
  "climate",
  "population",
  "politics",
  "laws",
  "economy",
  "military",
  "religion",
  "language",
  "culture",
  "history",
  "technology",
  "notes",
  "customFields",
] as const;

export interface SettingsToolDependencies {
  projectId: string;
  onUpdateCharacters: (characters: Character[]) => void;
  onUpdateWorldEntries: (entries: WorldEntry[]) => void;
}

export function createListCharactersTool(deps: SettingsToolDependencies) {
  return tool({
    description:
      "登録されているキャラクター設定一覧を取得します。キャラクターのIDと各項目を確認してから updateCharacter で編集してください。",
    inputSchema: z.object({}),
    execute: wrapToolExecute("listCharacters", async () => {
      const result = await invoke<{ characters: Character[] }>("list_characters", {
        projectId: deps.projectId,
      });
      deps.onUpdateCharacters(result.characters);
      return result;
    }),
  });
}

const updateCharacterInputSchema = z.object({
  characterId: z.string().describe("更新するキャラクターのID"),
  updates: z
    .record(z.string(), z.union([z.string(), z.array(z.object({ label: z.string(), value: z.string() }))]))
    .describe("更新するフィールドのマップ。例: { personality: '...', customFields: [{label:'...', value:'...'}] }"),
});

export function createUpdateCharacterTool(deps: SettingsToolDependencies) {
  return tool({
    description:
      "指定したキャラクターの設定を部分更新します。更新可能なフィールド例: name, alias, role, gender, age, birthday, bloodType, height, weight, appearance, personality, individuality, skills, specialSkills, upbringing, background, notes, customFields。",
    inputSchema: updateCharacterInputSchema,
    execute: wrapToolExecute("updateCharacter", async ({ characterId, updates }) => {
      const validation = validateSettingsUpdates(updates as Record<string, unknown>, CHARACTER_UPDATE_FIELDS);
      if (!validation.success) {
        return { error: `updateCharacter の入力が不正です: ${validation.error}` };
      }

      const result = await invoke<{ characters: Character[] }>("update_character", {
        req: {
          projectId: deps.projectId,
          characterId,
          updates: validation.data,
        },
      });
      deps.onUpdateCharacters(result.characters);
      return {
        success: true,
        message: "キャラクター設定を更新しました。",
        character: findById(result.characters, characterId),
      };
    }),
  });
}

const createCharacterInputSchema = z.object({
  name: z.string().describe("新しいキャラクターの名前"),
});

export function createCreateCharacterTool(deps: SettingsToolDependencies) {
  return tool({
    description: "新しいキャラクター設定を作成します。",
    inputSchema: createCharacterInputSchema,
    execute: wrapToolExecute("createCharacter", async ({ name }) => {
      const validation = validateStringField("name", name);
      if (!validation.success) {
        return { error: `createCharacter の入力が不正です: ${validation.error}` };
      }

      const result = await invoke<{ characters: Character[] }>("create_character", {
        req: {
          projectId: deps.projectId,
          name: validation.data,
        },
      });
      deps.onUpdateCharacters(result.characters);
      return {
        success: true,
        message: `キャラクター「${validation.data}」を作成しました。`,
        character: result.characters[result.characters.length - 1],
      };
    }),
  });
}

export function createListWorldEntriesTool(deps: SettingsToolDependencies) {
  return tool({
    description:
      "登録されている世界観設定一覧を取得します。世界観のIDと各項目を確認してから updateWorldEntry で編集してください。",
    inputSchema: z.object({}),
    execute: wrapToolExecute("listWorldEntries", async () => {
      const result = await invoke<{ entries: WorldEntry[] }>("list_world_entries", {
        projectId: deps.projectId,
      });
      deps.onUpdateWorldEntries(result.entries);
      return result;
    }),
  });
}

const updateWorldEntryInputSchema = z.object({
  entryId: z.string().describe("更新する世界観のID"),
  updates: z
    .record(z.string(), z.union([z.string(), z.array(z.object({ label: z.string(), value: z.string() }))]))
    .describe("更新するフィールドのマップ。例: { geography: '...', customFields: [{label:'...', value:'...'}] }"),
});

export function createUpdateWorldEntryTool(deps: SettingsToolDependencies) {
  return tool({
    description:
      "指定した世界観設定を部分更新します。更新可能なフィールド例: name, category, era, geography, climate, population, politics, laws, economy, military, religion, language, culture, history, technology, notes, customFields。",
    inputSchema: updateWorldEntryInputSchema,
    execute: wrapToolExecute("updateWorldEntry", async ({ entryId, updates }) => {
      const validation = validateSettingsUpdates(updates as Record<string, unknown>, WORLD_ENTRY_UPDATE_FIELDS);
      if (!validation.success) {
        return { error: `updateWorldEntry の入力が不正です: ${validation.error}` };
      }

      const result = await invoke<{ entries: WorldEntry[] }>("update_world_entry", {
        req: {
          projectId: deps.projectId,
          entryId,
          updates: validation.data,
        },
      });
      deps.onUpdateWorldEntries(result.entries);
      return {
        success: true,
        message: "世界観設定を更新しました。",
        entry: findById(result.entries, entryId),
      };
    }),
  });
}

const createWorldEntryInputSchema = z.object({
  name: z.string().describe("新しい世界観の名前"),
  category: z.string().describe("世界観のカテゴリ（場所・時代・制度 など）"),
});

export function createCreateWorldEntryTool(deps: SettingsToolDependencies) {
  return tool({
    description: "新しい世界観設定を作成します。",
    inputSchema: createWorldEntryInputSchema,
    execute: wrapToolExecute("createWorldEntry", async ({ name, category }) => {
      const nameValidation = validateStringField("name", name);
      if (!nameValidation.success) {
        return { error: `createWorldEntry の入力が不正です: ${nameValidation.error}` };
      }
      const categoryValidation = validateStringField("category", category);
      if (!categoryValidation.success) {
        return { error: `createWorldEntry の入力が不正です: ${categoryValidation.error}` };
      }

      const result = await invoke<{ entries: WorldEntry[] }>("create_world_entry", {
        req: {
          projectId: deps.projectId,
          name: nameValidation.data,
          category: categoryValidation.data,
        },
      });
      deps.onUpdateWorldEntries(result.entries);
      return {
        success: true,
        message: `世界観「${nameValidation.data}」を作成しました。`,
        entry: result.entries[result.entries.length - 1],
      };
    }),
  });
}
