import { tool } from "ai";
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { checkConsistency } from "./consistency.ts";
import type { AiSettings } from "../settings.ts";
import type { CustomField } from "../project/schema.ts";
import {
  loadRelationships,
  saveRelationships,
} from "../project/relationships.ts";
import type {
  Character,
  WorldEntry,
  Episode,
  CharacterRelationshipMap,
  CharacterRelationship,
  EpisodeMemoMap,
} from "../project/schema.ts";
import { loadMemos, saveEpisodeMemo } from "../project/memos.ts";
import {
  createProjectMemo,
  listProjectMemos,
  updateProjectMemo,
  type ProjectMemo,
} from "../project/project-memo.ts";
import {
  listGenres,
  loadGenre,
} from "../genres/repository.ts";
import { loadGenreKnowledge } from "../genres/knowledge.ts";
import {
  listGenreSources,
  loadGenreSource,
} from "../genres/sources.ts";
import { extractSegmentContent } from "../genres/segmentation.ts";
import { genreKnowledgeCategorySchema } from "../genres/schema.ts";

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

function validateCustomFields(
  value: unknown,
): ValidationResult<CustomField[]> | ValidationError {
  if (!Array.isArray(value)) {
    return {
      success: false,
      error:
        "customFields は配列である必要があります。例: [{label: '二人称', value: '君'}]",
    };
  }

  const normalized: CustomField[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!isPlainObject(item)) {
      return {
        success: false,
        error: `customFields[${i}] はオブジェクトである必要があります。`,
      };
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
      return {
        success: false,
        error: `customFields[${i}].value は文字列である必要があります。`,
      };
    }

    normalized.push({ label: labelRaw.trim(), value: valueRaw });
  }

  return { success: true, data: normalized };
}

function validateStringField(
  name: string,
  value: unknown,
): ValidationResult<string> | ValidationError {
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

function findById<T extends { id: string }>(
  items: T[],
  id: string,
): T | undefined {
  return items.find((item) => item.id === id);
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

function compactCharacterIdentityKey(value: string): string {
  return stripCharacterIdentityAffixes(value.normalize("NFKC").toLocaleLowerCase())
    .replace(/[\s,、，.．・･／\/\\_\-‐‑–—'’"“”()[\]（）「」『』【】]/g, "")
    .trim();
}

function hasCharacterIdentitySeparator(value: string): boolean {
  return /[\s,、，;；／\/\\・･.．_\-‐‑–—()[\]（）「」『』【】]/u.test(value);
}

function hasCharacterIdentityAffix(value: string): boolean {
  const normalized = value.normalize("NFKC").toLocaleLowerCase().trim();
  return stripCharacterIdentityAffixes(normalized) !== normalized;
}

function uniqueCharacterIdentityKeys(values: string[]): string[] {
  return [...new Set(values.map(compactCharacterIdentityKey).filter((key) => key.length >= 2))];
}

function characterPrimaryIdentityKeysFromText(value: string | undefined): string[] {
  if (!value) return [];
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) return [];
  return uniqueCharacterIdentityKeys([normalized, stripCharacterIdentityAffixes(normalized)]);
}

function characterIdentityKeysFromText(value: string | undefined): string[] {
  if (!value) return [];
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) return [];
  const parts = normalized
    .split(/[\s,、，;；／\/\\・･.．_\-‐‑–—()[\]（）「」『』【】]+/u)
    .map((part) => part.trim())
    .filter(Boolean);

  return uniqueCharacterIdentityKeys([normalized, stripCharacterIdentityAffixes(normalized), ...parts]);
}

function characterReferenceIdentityKeysFromText(value: string | undefined): string[] {
  if (!value) return [];
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) return [];
  if (!hasCharacterIdentitySeparator(normalized) || hasCharacterIdentityAffix(normalized)) {
    return characterIdentityKeysFromText(normalized);
  }
  return characterPrimaryIdentityKeysFromText(normalized);
}

function characterCandidateIdentityKeys(input: {
  name: string;
  reading?: string;
  alias?: string;
}): Set<string> {
  const aliasKeys = (input.alias ?? "")
    .split(/[\n,、]+/u)
    .flatMap(characterReferenceIdentityKeysFromText);
  return new Set([
    ...characterReferenceIdentityKeysFromText(input.name),
    ...characterPrimaryIdentityKeysFromText(input.reading),
    ...aliasKeys,
  ]);
}

function characterIdentityKeys(character: Pick<Character, "name" | "reading" | "alias">): Set<string> {
  return new Set([
    ...characterIdentityKeysFromText(character.name),
    ...characterIdentityKeysFromText(character.reading),
    ...characterIdentityKeysFromText(character.alias),
  ]);
}

function findCharacterByIdentityKeys(
  characters: Character[],
  keys: Set<string>,
): Character | undefined {
  if (keys.size === 0) return undefined;
  return characters.find((character) => {
    const existingKeys = characterIdentityKeys(character);
    for (const key of keys) {
      if (existingKeys.has(key)) return true;
    }
    return false;
  });
}

async function rebuildSearchIndexQuietly(projectId: string): Promise<boolean> {
  try {
    await invoke("rebuild_search_index", { projectId });
    return true;
  } catch (error) {
    console.warn(
      "[litra] failed to rebuild search index after tool mutation:",
      error,
    );
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
      console.error(`[litra] tool ${name} error:`, error);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };
}

export interface EditToolDependencies {
  projectId: string;
  episodeId: string;
  onApply: (newText: string, targetEpisodeId: string) => void;
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

interface BatchEditItemResponse {
  index: number;
  startLine: number;
  endLine: number;
  success: boolean;
  message: string;
  actualText?: string;
  replacementLineCount: number;
}

interface EditLineRangeSummary {
  index?: number;
  startLine: number;
  endLine: number;
  replacementLineCount: number;
}

interface FailedEditLineRangeSummary extends EditLineRangeSummary {
  message: string;
}

function formatEditLineRange(
  range: Pick<EditLineRangeSummary, "startLine" | "endLine">,
): string {
  return range.startLine === range.endLine
    ? `${range.startLine}行目`
    : `${range.startLine}-${range.endLine}行`;
}

function formatEditLineRanges(
  ranges: Array<Pick<EditLineRangeSummary, "startLine" | "endLine">>,
): string {
  const labels = ranges.map(formatEditLineRange);
  if (labels.length <= 8) return labels.join(", ");
  return `${labels.slice(0, 8).join(", ")} ほか${labels.length - 8}件`;
}

function toEditLineRangeSummary(
  item: Pick<
    BatchEditItemResponse,
    "index" | "startLine" | "endLine" | "replacementLineCount"
  >,
): EditLineRangeSummary {
  return {
    index: item.index,
    startLine: item.startLine,
    endLine: item.endLine,
    replacementLineCount: item.replacementLineCount,
  };
}

function buildAppliedEditSummary(
  appliedEdits: number,
  editedLineRanges: EditLineRangeSummary[],
  batch: boolean,
): string {
  const prefix = batch
    ? `${appliedEdits}件の編集を一括適用しました`
    : "1件の編集を適用しました";
  const ranges =
    editedLineRanges.length > 0
      ? `: ${formatEditLineRanges(editedLineRanges)}`
      : "";
  return `${prefix}${ranges}。`;
}

function buildRejectedEditSummary(
  message: string,
  failedLineRanges: FailedEditLineRangeSummary[],
): string {
  if (failedLineRanges.length === 0) {
    return `編集は適用されませんでした。${message}`;
  }
  return `編集は適用されませんでした: ${formatEditLineRanges(
    failedLineRanges,
  )}。${message}`;
}

const editInputSchema = z
  .object({
    episodeId: z
      .string()
      .optional()
      .describe("Episode ID to edit. Omit to use the currently open episode."),
    startLine: z
      .number()
      .int()
      .min(1)
      .describe("First line to replace, using 1-based numbering."),
    endLine: z
      .number()
      .int()
      .min(1)
      .describe("Last line to replace, using 1-based numbering."),
    expectedText: z
      .string()
      .describe(
        "Exact current text in the selected line range. Preserve every character and line break.",
      ),
    replacementText: z
      .string()
      .describe(
        "Replacement text. Write natural-language prose in Japanese unless exact source preservation or an explicit user request requires otherwise.",
      ),
  })
  .refine((value) => value.endLine >= value.startLine, {
    message: "endLine must be greater than or equal to startLine.",
    path: ["endLine"],
  });

export function createEditEpisodeTool(deps: EditToolDependencies) {
  return tool({
    description:
      "Replaces a line range only when expectedText exactly matches the current manuscript. Line numbers are 1-based and must be within the episode. Use getEpisodeLines first when uncertain. expectedText must preserve every character, line break, space, and width variant. replacementText must contain the final replacement; write natural-language prose in Japanese unless exact source preservation or an explicit user request requires otherwise. On success, report editSummary or editedLineRanges once instead of restating tool arguments.",

    inputSchema: editInputSchema,
    execute: wrapToolExecute(
      "editEpisode",
      async ({
        episodeId,
        startLine,
        endLine,
        expectedText,
        replacementText,
      }) => {
        const targetEpisodeId = episodeId ?? deps.episodeId;
        const result = await invoke<{
          success: boolean;
          message: string;
          newText?: string;
          actualText?: string;
          totalLines?: number;
        }>("edit_episode_text", {
          req: {
            projectId: deps.projectId,
            episodeId: targetEpisodeId,
            startLine,
            endLine,
            expectedText,
            replacementText,
          },
        });
        if (result.success && result.newText != null) {
          deps.onApply(result.newText, targetEpisodeId);
        }
        const searchIndexUpdated = result.success
          ? await rebuildSearchIndexQuietly(deps.projectId)
          : false;
        const replacementLineCount = replacementText.split("\n").length;
        const editedLineRanges: EditLineRangeSummary[] = result.success
          ? [{ startLine, endLine, replacementLineCount }]
          : [];
        const failedLineRanges: FailedEditLineRangeSummary[] = result.success
          ? []
          : [
              {
                startLine,
                endLine,
                replacementLineCount,
                message: result.message,
              },
            ];
        return {
          success: result.success,
          message: result.message,
          totalLines: result.totalLines,
          actualText:
            result.actualText != null
              ? limitToolText(result.actualText)
              : undefined,
          applied: result.success,
          editedLineRange: { startLine, endLine },
          editedLineRanges,
          failedLineRanges,
          replacementLineCount,
          editSummary: result.success
            ? buildAppliedEditSummary(1, editedLineRanges, false)
            : buildRejectedEditSummary(result.message, failedLineRanges),
          searchIndexUpdated,
        };
      },
    ),
  });
}

const batchEditInputSchema = z.object({
  episodeId: z
    .string()
    .optional()
    .describe("Episode ID to edit. Omit to use the currently open episode."),
  edits: z
    .array(editInputSchema)
    .min(1)
    .max(50)
    .describe(
      "Edits to apply atomically. Every range uses 1-based line numbers from the same pre-edit manuscript, and ranges must not overlap.",
    ),
});

export function createEditEpisodeBatchTool(deps: EditToolDependencies) {
  return tool({
    description:
      "Atomically replaces multiple non-contiguous ranges in one episode. Use this instead of repeated editEpisode calls when multiple clear ranges are requested. Every expectedText must exactly match the current text, including line breaks, spacing, and width variants. All ranges use 1-based line numbers from the same pre-edit manuscript and must not overlap. Use getEpisodeLines first when uncertain. All replacementText values must be Japanese natural-language prose unless exact source preservation or an explicit user request requires otherwise. On success, report editSummary or editedLineRanges once instead of asking for per-range confirmation.",
    inputSchema: batchEditInputSchema,
    execute: wrapToolExecute(
      "editEpisodeBatch",
      async ({ episodeId, edits }) => {
        const targetEpisodeId = episodeId ?? deps.episodeId;
        const result = await invoke<{
          success: boolean;
          message: string;
          newText?: string;
          totalLines: number;
          appliedEdits: number;
          editResults: BatchEditItemResponse[];
        }>("edit_episode_text_batch", {
          req: {
            projectId: deps.projectId,
            episodeId: targetEpisodeId,
            edits,
          },
        });
        if (result.success && result.newText != null) {
          deps.onApply(result.newText, targetEpisodeId);
        }
        const searchIndexUpdated = result.success
          ? await rebuildSearchIndexQuietly(deps.projectId)
          : false;
        const editResults = result.editResults.map((item) => ({
          ...item,
          actualText:
            item.actualText != null ? limitToolText(item.actualText) : undefined,
        }));
        const editedLineRanges = editResults
          .filter((item) => item.success)
          .map(toEditLineRangeSummary);
        const failedLineRanges: FailedEditLineRangeSummary[] = editResults
          .filter((item) => !item.success)
          .map((item) => ({
            ...toEditLineRangeSummary(item),
            message: item.message,
          }));
        return {
          success: result.success,
          message: result.message,
          totalLines: result.totalLines,
          appliedEdits: result.appliedEdits,
          editResults,
          editedLineRanges,
          failedLineRanges,
          editSummary: result.success
            ? buildAppliedEditSummary(result.appliedEdits, editedLineRanges, true)
            : buildRejectedEditSummary(result.message, failedLineRanges),
          searchIndexUpdated,
        };
      },
    ),
  });
}

export interface CheckConsistencyToolDependencies {
  projectId: string;
  settings: AiSettings;
  /**
   * 実行時に最新の AiSettings を解決する関数。
   * バックグラウンドタスク用設定（要約や整合性チェックなど）の上書きを反映するため、
   * クロージャで固定した settings ではなく、この関数が返す最新の解決済み settings を使う。
   */
  resolveSettings?: () => AiSettings;
  currentEpisodeId?: string;
}

const checkConsistencyInputSchema = z.object({
  episodeId: z
    .string()
    .optional()
    .describe("Episode ID to check. Omit to use the currently open episode."),
  focus: z
    .string()
    .optional()
    .describe(
      "Optional focus, such as a character, worldbuilding entry, prior episode, chronology, or scene state. Write this focus in Japanese when it is natural-language content.",
    ),
});

export function createCheckConsistencyTool(
  deps: CheckConsistencyToolDependencies,
) {
  return tool({
    description:
      "Checks an episode against character settings, worldbuilding, relationships, memos, and other episode summaries to detect explicit contradictions or continuity errors. Use when the user asks for a consistency audit. The returned report must be Japanese.",
    inputSchema: checkConsistencyInputSchema,
    execute: wrapToolExecute(
      "checkConsistency",
      async ({ episodeId, focus }) => {
        const targetEpisodeId = episodeId ?? deps.currentEpisodeId;
        if (!targetEpisodeId) {
          return {
            success: false,
            message:
              "エピソードIDが指定されていないか、現在開いているエピソードがありません。",
            issues: [],
            summary: "",
          };
        }
        const result = await checkConsistency(
          deps.resolveSettings?.() ?? deps.settings,
          deps.projectId,
          targetEpisodeId,
          focus,
        );
        return {
          success: true,
          message: `整合性チェックが完了しました。${result.issues.length} 件の指摘がありました。`,
          ...result,
        };
      },
    ),
  });
}

const getEpisodeLinesInputSchema = z.object({
  episodeId: z
    .string()
    .describe("Episode ID whose text should be returned with line numbers."),
  startLine: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("First line to retrieve, 1-based. Omit to start at line 1."),
  endLine: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Last line to retrieve, 1-based and inclusive. Omit to end at the final line.",
    ),
});

export function createGetEpisodeLinesTool(deps: SearchDependencies) {
  return tool({
    description:
      "Returns episode text with 1-based line numbers. Use it to determine startLine, endLine, and exact expectedText for editEpisode. Optional range arguments limit the returned text.",
    inputSchema: getEpisodeLinesInputSchema,
    execute: wrapToolExecute(
      "getEpisodeLines",
      async ({ episodeId, startLine, endLine }) => {
        return await invoke<EpisodeLinesResponse>("get_episode_lines", {
          req: {
            projectId: deps.projectId,
            episodeId,
            startLine,
            endLine,
          },
        });
      },
    ),
  });
}

const findEpisodeLinesInputSchema = z.object({
  episodeId: z.string().describe("Episode ID to search."),
  query: z
    .string()
    .describe(
      "Exact word, sentence, or partial phrase to find in the manuscript.",
    ),
  contextLines: z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe(
      "Number of context lines before and after each match. Default: 3.",
    ),
  maxMatches: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Maximum number of matches to return. Default: 20."),
  caseSensitive: z
    .boolean()
    .optional()
    .describe("Whether matching is case-sensitive. Default: true."),
});

export function createFindEpisodeLinesTool(deps: SearchDependencies) {
  return tool({
    description:
      "Searches an episode and returns matching line numbers, numbered context, and exact expectedText suitable for editEpisode. Use this instead of manually counting lines.",
    inputSchema: findEpisodeLinesInputSchema,
    execute: wrapToolExecute(
      "findEpisodeLines",
      async ({ episodeId, query, contextLines, maxMatches, caseSensitive }) => {
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
      },
    ),
  });
}

export function createListEpisodesTool(deps: SearchDependencies) {
  return tool({
    description:
      "Lists registered episodes with one-line summaries. Use this first to identify a past episode.",
    inputSchema: z.object({}),
    execute: wrapToolExecute("listEpisodes", async () => {
      return await invoke<
        {
          episodeId: string;
          order: number;
          title: string;
          oneLineSummary: string;
        }[]
      >("list_episodes_with_summaries", { projectId: deps.projectId });
    }),
  });
}

const retrieveInputSchema = z.object({
  episodeId: z.string().describe("Episode ID to retrieve."),
  type: z
    .enum(["summary", "fullText"])
    .describe(
      "Content type: summary for the saved synopsis, fullText for the complete manuscript.",
    ),
});

export function createRetrieveEpisodeTool(deps: SearchDependencies) {
  return tool({
    description:
      "Retrieves either a saved episode summary or the full manuscript. Use findEpisodeLines or getEpisodeLines when an edit requires line numbers.",
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
  query: z.string().describe("Search query or phrase."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Maximum number of results. Default: 5."),
});

export function createSearchEpisodesTool(deps: SearchDependencies) {
  return tool({
    description:
      "Full-text search across episode manuscripts and summaries. Use it to find names, locations, past events, or exact phrases.",
    inputSchema: searchInputSchema,
    execute: wrapToolExecute("searchEpisodes", async ({ query, limit }) => {
      return await invoke<
        {
          score: number;
          episodeId: string;
          title: string;
          docType: string;
          snippet: string;
        }[]
      >("search_episodes", {
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
      "Rebuilds the internal episode search index. Use only when the index may be stale or expected search results are missing.",
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
  episodeId: z.string().describe("Episode ID whose summary will be saved."),
  content: z
    .string()
    .describe(
      "Detailed episode summary. Write the complete natural-language value in Japanese; line breaks are allowed.",
    ),
});

export function createSaveEpisodeSummaryTool(deps: SummaryToolDependencies) {
  return tool({
    description:
      "Saves or updates an episode summary. Inspect the manuscript first. The content value must be Japanese and may be long.",
    inputSchema: saveSummaryInputSchema,
    execute: wrapToolExecute(
      "saveEpisodeSummary",
      async ({ episodeId, content }) => {
        const validation = validateStringField("content", content);
        if (!validation.success) {
          return {
            error: `saveEpisodeSummary の入力が不正です: ${validation.error}`,
          };
        }

        await invoke("save_episode_summary", {
          req: {
            projectId: deps.projectId,
            episodeId,
            content: validation.data,
          },
        });
        const searchIndexUpdated = await rebuildSearchIndexQuietly(
          deps.projectId,
        );
        deps.onSaveSummary?.(episodeId, validation.data);
        return {
          success: true,
          message: "要約を保存しました。",
          searchIndexUpdated,
        };
      },
    ),
  });
}

const saveOneLinerInputSchema = z.object({
  episodeId: z.string().describe("Episode ID whose one-line summary will be saved."),
  oneLiner: z
    .string()
    .describe("A concise one-sentence episode summary written in Japanese."),
});

const saveSummaryAndOneLinerInputSchema = z.object({
  episodeId: z.string().describe("Episode ID whose summary will be saved."),
  content: z
    .string()
    .describe(
      "Detailed episode summary. Write the complete natural-language value in Japanese; line breaks are allowed.",
    ),
  oneLiner: z
    .string()
    .describe("A concise one-sentence episode summary written in Japanese."),
});

export function createSaveEpisodeOneLinerTool(deps: SummaryToolDependencies) {
  return tool({
    description: "Saves or updates a Japanese one-line episode summary.",
    inputSchema: saveOneLinerInputSchema,
    execute: wrapToolExecute(
      "saveEpisodeOneLiner",
      async ({ episodeId, oneLiner }) => {
        const validation = validateStringField("oneLiner", oneLiner);
        if (!validation.success) {
          return {
            error: `saveEpisodeOneLiner の入力が不正です: ${validation.error}`,
          };
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
      },
    ),
  });
}

export function createSaveEpisodeSummaryAndOneLinerTool(
  deps: SummaryToolDependencies,
) {
  return tool({
    description:
      "Saves or updates both the detailed summary and one-line summary in one call. Both natural-language values must be Japanese. Use this single tool when both are required.",
    inputSchema: saveSummaryAndOneLinerInputSchema,
    execute: wrapToolExecute(
      "saveEpisodeSummaryAndOneLiner",
      async ({ episodeId, content, oneLiner }) => {
        const contentValidation = validateStringField("content", content);
        if (!contentValidation.success) {
          return { error: `content が不正です: ${contentValidation.error}` };
        }
        const oneLinerValidation = validateStringField("oneLiner", oneLiner);
        if (!oneLinerValidation.success) {
          return { error: `oneLiner が不正です: ${oneLinerValidation.error}` };
        }

        await invoke("save_episode_summary", {
          req: {
            projectId: deps.projectId,
            episodeId,
            content: contentValidation.data,
          },
        });
        await invoke("save_episode_one_liner", {
          req: {
            projectId: deps.projectId,
            episodeId,
            oneLiner: oneLinerValidation.data,
          },
        });
        const searchIndexUpdated = await rebuildSearchIndexQuietly(
          deps.projectId,
        );
        deps.onSaveSummary?.(episodeId, contentValidation.data);
        deps.onSaveOneLiner?.(episodeId, oneLinerValidation.data);
        return {
          success: true,
          message: "要約と一行要約を保存しました。",
          searchIndexUpdated,
        };
      },
    ),
  });
}

const CHARACTER_UPDATE_FIELDS = [
  "name",
  "reading",
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
      "Lists registered character settings. Inspect IDs, names, readings, aliases, and current fields before updateCharacter or createCharacter.",
    inputSchema: z.object({}),
    execute: wrapToolExecute("listCharacters", async () => {
      const result = await invoke<{ characters: Character[] }>(
        "list_characters",
        {
          projectId: deps.projectId,
        },
      );
      deps.onUpdateCharacters(result.characters);
      return result;
    }),
  });
}

const updateCharacterInputSchema = z.object({
  characterId: z.string().describe("ID of the character to update."),
  updates: z
    .record(
      z.string(),
      z.union([
        z.string(),
        z.array(z.object({ label: z.string(), value: z.string() })),
      ]),
    )
    .describe(
      "Map of fields to update. Use reading for よみがな. Write all descriptive natural-language values in Japanese. Preserve field keys, IDs, established foreign proper nouns, and literal codes. Example: { reading: 'りちゃーど・はーとまん', personality: '慎重だが好奇心が強い', customFields: [{label:'二人称', value:'君'}] }",
    ),
});

export function createUpdateCharacterTool(deps: SettingsToolDependencies) {
  return tool({
    description:
      "Partially updates one character. Allowed fields include name, reading, alias, role, gender, age, birthday, bloodType, height, weight, appearance, personality, individuality, skills, specialSkills, upbringing, background, notes, and customFields. Use reading for よみがな. All descriptive natural-language values must be Japanese; keep IDs, field keys, literal codes, and established foreign proper nouns unchanged.",
    inputSchema: updateCharacterInputSchema,
    execute: wrapToolExecute(
      "updateCharacter",
      async ({ characterId, updates }) => {
        const validation = validateSettingsUpdates(
          updates as Record<string, unknown>,
          CHARACTER_UPDATE_FIELDS,
        );
        if (!validation.success) {
          return {
            error: `updateCharacter の入力が不正です: ${validation.error}`,
          };
        }

        const result = await invoke<{ characters: Character[] }>(
          "update_character",
          {
            req: {
              projectId: deps.projectId,
              characterId,
              updates: validation.data,
            },
          },
        );
        deps.onUpdateCharacters(result.characters);
        return {
          success: true,
          message: "キャラクター設定を更新しました。",
          character: findById(result.characters, characterId),
        };
      },
    ),
  });
}

const createCharacterInputSchema = z.object({
  name: z
    .string()
    .describe(
      "Name of the new character. Preserve the established proper-name spelling; do not translate a foreign proper name merely to satisfy the Japanese prose rule.",
    ),
  reading: z
    .string()
    .optional()
    .describe("よみがな for the character name when known. Use kana when available; omit when unknown."),
  alias: z
    .string()
    .optional()
    .describe("Known alternate names, titles, spellings, or forms of address for the same person. Preserve established proper nouns."),
});

export function createCreateCharacterTool(deps: SettingsToolDependencies) {
  // モデルが同一ターン内で同じ createCharacter を並列・反復実行しても、
  // 実際の書き込みは一度だけにする。ツールインスタンスはAI実行ごとに作られるため、
  // このガードは別ターンの意図的な作成までは妨げない。
  const createdInThisRun = new Map<string, Character>();
  let creationQueue: Promise<void> = Promise.resolve();

  const normalizeNameKey = (value: string): string =>
    value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();

  const serializeCreation = async <T>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    const previous = creationQueue;
    let release!: () => void;
    creationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  return tool({
    description:
      "Creates a new character record. Before calling, use listCharacters and check names, readings, aliases, titles, surnames, spacing, width variants, English/Japanese spellings, and obvious spelling variants. Call at most once per person. Do not create when the same person already exists.",
    inputSchema: createCharacterInputSchema,
    execute: wrapToolExecute("createCharacter", async ({ name, reading, alias }) => {
      const validation = validateStringField("name", name);
      if (!validation.success) {
        return {
          error: `createCharacter の入力が不正です: ${validation.error}`,
        };
      }
      const readingValidation = reading == null ? undefined : validateStringField("reading", reading);
      if (readingValidation && !readingValidation.success) {
        return {
          error: `createCharacter の入力が不正です: ${readingValidation.error}`,
        };
      }
      const aliasValidation = alias == null ? undefined : validateStringField("alias", alias);
      if (aliasValidation && !aliasValidation.success) {
        return {
          error: `createCharacter の入力が不正です: ${aliasValidation.error}`,
        };
      }

      const normalizedName = validation.data.trim();
      const normalizedReading = readingValidation?.success ? readingValidation.data.trim() : "";
      const normalizedAlias = aliasValidation?.success ? aliasValidation.data.trim() : "";
      if (!normalizedName) {
        return {
          error: "createCharacter の入力が不正です: 名前を空にはできません。",
        };
      }
      const identityKeys = characterCandidateIdentityKeys({
        name: normalizedName,
        reading: normalizedReading,
        alias: normalizedAlias,
      });
      const nameKey = [...identityKeys][0] ?? normalizeNameKey(normalizedName);

      return await serializeCreation(async () => {
        const alreadyCreated = [...identityKeys]
          .map((key) => createdInThisRun.get(key))
          .find((character): character is Character => character != null);
        if (alreadyCreated) {
          return {
            success: true,
            created: false,
            duplicatePrevented: true,
            message: `キャラクター「${normalizedName}」はこの実行内ですでに作成済みのため、二重登録を防止しました。`,
            character: alreadyCreated,
          };
        }

        const current = await invoke<{ characters: Character[] }>(
          "list_characters",
          {
            projectId: deps.projectId,
          },
        );
        const existing = findCharacterByIdentityKeys(current.characters, identityKeys);
        if (existing) {
          deps.onUpdateCharacters(current.characters);
          for (const key of identityKeys) createdInThisRun.set(key, existing);
          return {
            success: true,
            created: false,
            duplicatePrevented: true,
            message: `キャラクター「${normalizedName}」はすでに登録されているため、新規作成しませんでした。`,
            character: existing,
          };
        }

        const result = await invoke<{ characters: Character[] }>(
          "create_character",
          {
            req: {
              projectId: deps.projectId,
              name: normalizedName,
              ...(normalizedReading ? { reading: normalizedReading } : {}),
              ...(normalizedAlias ? { alias: normalizedAlias } : {}),
            },
          },
        );
        deps.onUpdateCharacters(result.characters);
        const character =
          result.characters.find(
            (item) => characterIdentityKeys(item).has(nameKey),
          ) ?? result.characters[result.characters.length - 1];
        if (character) {
          for (const key of identityKeys) createdInThisRun.set(key, character);
        }
        return {
          success: true,
          created: true,
          message: `キャラクター「${normalizedName}」を作成しました。`,
          character,
        };
      });
    }),
  });
}

export function createListWorldEntriesTool(deps: SettingsToolDependencies) {
  return tool({
    description:
      "Lists registered worldbuilding entries. Inspect entry IDs and current fields before updateWorldEntry or createWorldEntry.",
    inputSchema: z.object({}),
    execute: wrapToolExecute("listWorldEntries", async () => {
      const result = await invoke<{ entries: WorldEntry[] }>(
        "list_world_entries",
        {
          projectId: deps.projectId,
        },
      );
      deps.onUpdateWorldEntries(result.entries);
      return result;
    }),
  });
}

const updateWorldEntryInputSchema = z.object({
  entryId: z.string().describe("ID of the worldbuilding entry to update."),
  updates: z
    .record(
      z.string(),
      z.union([
        z.string(),
        z.array(z.object({ label: z.string(), value: z.string() })),
      ]),
    )
    .describe(
      "Map of fields to update. Write all descriptive natural-language values in Japanese. Preserve field keys, IDs, established proper nouns, and literal codes. Example: { geography: '北部に高い山脈が連なる', customFields: [{label:'通貨', value:'銀貨'}] }",
    ),
});

export function createUpdateWorldEntryTool(deps: SettingsToolDependencies) {
  return tool({
    description:
      "Partially updates one worldbuilding entry. Allowed fields include name, category, era, geography, climate, population, politics, laws, economy, military, religion, language, culture, history, technology, notes, and customFields. All descriptive natural-language values must be Japanese; preserve IDs, keys, literal codes, and established proper nouns.",
    inputSchema: updateWorldEntryInputSchema,
    execute: wrapToolExecute(
      "updateWorldEntry",
      async ({ entryId, updates }) => {
        const validation = validateSettingsUpdates(
          updates as Record<string, unknown>,
          WORLD_ENTRY_UPDATE_FIELDS,
        );
        if (!validation.success) {
          return {
            error: `updateWorldEntry の入力が不正です: ${validation.error}`,
          };
        }

        const result = await invoke<{ entries: WorldEntry[] }>(
          "update_world_entry",
          {
            req: {
              projectId: deps.projectId,
              entryId,
              updates: validation.data,
            },
          },
        );
        deps.onUpdateWorldEntries(result.entries);
        return {
          success: true,
          message: "世界観設定を更新しました。",
          entry: findById(result.entries, entryId),
        };
      },
    ),
  });
}

const createWorldEntryInputSchema = z.object({
  name: z
    .string()
    .describe(
      "Name of the new worldbuilding entry. Preserve an established proper noun when applicable.",
    ),
  category: z
    .string()
    .describe(
      "Japanese category label for the entry, such as 場所, 時代, 制度, 組織, or 技術.",
    ),
});

export function createCreateWorldEntryTool(deps: SettingsToolDependencies) {
  return tool({
    description:
      "Creates a new worldbuilding entry. Write category in Japanese and preserve established proper nouns in name.",
    inputSchema: createWorldEntryInputSchema,
    execute: wrapToolExecute("createWorldEntry", async ({ name, category }) => {
      const nameValidation = validateStringField("name", name);
      if (!nameValidation.success) {
        return {
          error: `createWorldEntry の入力が不正です: ${nameValidation.error}`,
        };
      }
      const categoryValidation = validateStringField("category", category);
      if (!categoryValidation.success) {
        return {
          error: `createWorldEntry の入力が不正です: ${categoryValidation.error}`,
        };
      }

      const result = await invoke<{ entries: WorldEntry[] }>(
        "create_world_entry",
        {
          req: {
            projectId: deps.projectId,
            name: nameValidation.data,
            category: categoryValidation.data,
          },
        },
      );
      deps.onUpdateWorldEntries(result.entries);
      return {
        success: true,
        message: `世界観「${nameValidation.data}」を作成しました。`,
        entry: result.entries[result.entries.length - 1],
      };
    }),
  });
}

export interface RelationshipToolDependencies {
  projectId: string;
  characters: Character[];
  episodes: Episode[];
  relationshipsMap: CharacterRelationshipMap;
  onUpdateRelationships: (map: CharacterRelationshipMap) => void;
}

function formatRelationshipsForAi(deps: RelationshipToolDependencies): string {
  const charName = (id: string): string =>
    deps.characters.find((c) => c.id === id)?.name || "（不明）";
  const episodeTitle = (id: string): string => {
    if (!id) return "全体（全話共通）";
    return deps.episodes.find((e) => e.id === id)?.title || "（不明）";
  };

  return deps.relationshipsMap.groups
    .map((group) => {
      const lines = group.relationships
        .map((rel) => {
          const arrow =
            rel.direction === "a-to-b"
              ? "→"
              : rel.direction === "b-to-a"
                ? "←"
                : "↔";
          return `  - ${rel.id}: ${charName(rel.characterAId)} ${arrow} ${charName(rel.characterBId)} / ${rel.description || "（説明なし）"}`;
        })
        .join("\n");
      return `■ ${episodeTitle(group.episodeId)}\n${lines}`;
    })
    .join("\n\n");
}

export function createListRelationshipsTool(
  deps: RelationshipToolDependencies,
) {
  return tool({
    description:
      "Lists character relationships. Confirm relationshipId and current values before update or deletion.",
    inputSchema: z.object({}),
    execute: wrapToolExecute("listRelationships", async () => {
      const map = await loadRelationships(deps.projectId);
      deps.onUpdateRelationships(map);
      return {
        relationships: formatRelationshipsForAi({
          ...deps,
          relationshipsMap: map,
        }),
      };
    }),
  });
}

const createRelationshipInputSchema = z.object({
  episodeId: z
    .string()
    .describe(
      "Episode ID for this relationship. Use an empty string for a relationship that applies to the whole work.",
    ),
  characterAId: z.string().describe("ID of character A."),
  characterBId: z.string().describe("ID of character B."),
  direction: z
    .enum(["a-to-b", "b-to-a", "mutual"])
    .describe(
      "Direction: a-to-b means A directs the relationship toward B; b-to-a means B directs it toward A; mutual is symmetric or reciprocal.",
    ),
  description: z
    .string()
    .describe(
      "Japanese description of the relationship, for example 「敵対しており、互いを警戒している」.",
    ),
});

export function createCreateRelationshipTool(
  deps: RelationshipToolDependencies,
) {
  return tool({
    description:
      "Creates a character relationship. The description must be Japanese and its meaning must match direction.",
    inputSchema: createRelationshipInputSchema,
    execute: wrapToolExecute("createRelationship", async (input) => {
      if (!input.characterAId || !input.characterBId) {
        return {
          error:
            "characterAId と characterBId は必須です。listCharacters でIDを確認してください。",
        };
      }
      if (input.characterAId === input.characterBId) {
        return { error: "同じキャラクター同士の関係は登録できません。" };
      }

      const map = await loadRelationships(deps.projectId);
      const group = map.groups.find((g) => g.episodeId === input.episodeId) ?? {
        episodeId: input.episodeId,
        relationships: [],
      };
      if (!map.groups.includes(group)) {
        map.groups.push(group);
      }

      const created: CharacterRelationship = {
        id: crypto.randomUUID(),
        characterAId: input.characterAId,
        characterBId: input.characterBId,
        direction: input.direction,
        description: input.description,
      };
      group.relationships.push(created);

      await saveRelationships(deps.projectId, map);
      deps.onUpdateRelationships(map);
      return {
        success: true,
        message: "人間関係を作成しました。",
        relationship: created,
      };
    }),
  });
}

const updateRelationshipInputSchema = z.object({
  relationshipId: z.string().describe("ID of the relationship to update."),
  updates: z
    .object({
      characterAId: z.string().optional().describe("New character A ID."),
      characterBId: z.string().optional().describe("New character B ID."),
      direction: z
        .enum(["a-to-b", "b-to-a", "mutual"])
        .optional()
        .describe("New direction enum value."),
      description: z
        .string()
        .optional()
        .describe("New Japanese relationship description."),
    })
    .describe(
      "Fields to update. Only supplied fields are changed. Any description value must be Japanese.",
    ),
});

export function createUpdateRelationshipTool(
  deps: RelationshipToolDependencies,
) {
  return tool({
    description:
      "Updates a relationship direction or description. Confirm the ID with listRelationships. Any description must be Japanese.",
    inputSchema: updateRelationshipInputSchema,
    execute: wrapToolExecute(
      "updateRelationship",
      async ({ relationshipId, updates }) => {
        const map = await loadRelationships(deps.projectId);
        let target: CharacterRelationship | undefined;
        for (const group of map.groups) {
          target = group.relationships.find((r) => r.id === relationshipId);
          if (target) break;
        }
        if (!target) {
          return { error: `指定した関係IDが見つかりません: ${relationshipId}` };
        }

        if (updates.characterAId !== undefined)
          target.characterAId = updates.characterAId;
        if (updates.characterBId !== undefined)
          target.characterBId = updates.characterBId;
        if (updates.direction !== undefined)
          target.direction = updates.direction;
        if (updates.description !== undefined)
          target.description = updates.description;

        if (
          target.characterAId &&
          target.characterBId &&
          target.characterAId === target.characterBId
        ) {
          return { error: "同じキャラクター同士の関係にはできません。" };
        }

        await saveRelationships(deps.projectId, map);
        deps.onUpdateRelationships(map);
        return {
          success: true,
          message: "人間関係を更新しました。",
          relationship: target,
        };
      },
    ),
  });
}

const deleteRelationshipInputSchema = z.object({
  relationshipId: z.string().describe("ID of the relationship to delete."),
});

export function createDeleteRelationshipTool(
  deps: RelationshipToolDependencies,
) {
  return tool({
    description: "Deletes the specified relationship.",
    inputSchema: deleteRelationshipInputSchema,
    execute: wrapToolExecute(
      "deleteRelationship",
      async ({ relationshipId }) => {
        const map = await loadRelationships(deps.projectId);
        for (const group of map.groups) {
          const index = group.relationships.findIndex(
            (r) => r.id === relationshipId,
          );
          if (index !== -1) {
            group.relationships.splice(index, 1);
            break;
          }
        }
        map.groups = map.groups.filter((g) => g.relationships.length > 0);

        await saveRelationships(deps.projectId, map);
        deps.onUpdateRelationships(map);
        return { success: true, message: "人間関係を削除しました。" };
      },
    ),
  });
}

export interface MemoToolDependencies {
  projectId: string;
  episodes: Episode[];
  episodeMemos: EpisodeMemoMap;
  onUpdateMemos: (memos: EpisodeMemoMap) => void;
}

export function createListEpisodeMemosTool(deps: MemoToolDependencies) {
  return tool({
    description:
      "Lists episode memos and returns episode IDs, titles, and content previews.",
    inputSchema: z.object({}),
    execute: wrapToolExecute("listEpisodeMemos", async () => {
      const memos = deps.episodeMemos.memos;
      const items = deps.episodes
        .filter((episode) => memos[episode.id]?.content)
        .map((episode) => {
          const content = memos[episode.id]?.content ?? "";
          return {
            episodeId: episode.id,
            title: episode.title || "（無題）",
            preview: limitToolText(content, 240),
          };
        });
      return { count: items.length, memos: items };
    }),
  });
}

const getEpisodeMemoInputSchema = z.object({
  episodeId: z.string().describe("Episode ID whose memo should be retrieved."),
});

export function createGetEpisodeMemoTool(deps: MemoToolDependencies) {
  return tool({
    description: "Retrieves the complete memo associated with an episode.",
    inputSchema: getEpisodeMemoInputSchema,
    execute: wrapToolExecute("getEpisodeMemo", async ({ episodeId }) => {
      const content = deps.episodeMemos.memos[episodeId]?.content ?? "";
      const episode = deps.episodes.find((e) => e.id === episodeId);
      return {
        episodeId,
        title: episode?.title || "（無題）",
        content: limitToolText(content),
      };
    }),
  });
}

const saveEpisodeMemoInputSchema = z.object({
  episodeId: z.string().describe("Episode ID whose memo will be saved."),
  content: z
    .string()
    .describe(
      "Memo content. Write natural-language content in Japanese; long text and line breaks are allowed.",
    ),
});

export function createSaveEpisodeMemoTool(deps: MemoToolDependencies) {
  return tool({
    description:
      "Saves or updates an episode memo. The content must be Japanese except for exact quotations, code, identifiers, URLs, or established proper nouns.",
    inputSchema: saveEpisodeMemoInputSchema,
    execute: wrapToolExecute(
      "saveEpisodeMemo",
      async ({ episodeId, content }) => {
        const validation = validateStringField("content", content);
        if (!validation.success) {
          return {
            error: `saveEpisodeMemo の入力が不正です: ${validation.error}`,
          };
        }

        await saveEpisodeMemo(deps.projectId, episodeId, validation.data);
        const updated = await loadMemos(deps.projectId);
        deps.onUpdateMemos(updated);
        return { success: true, message: "覚え書きを保存しました。" };
      },
    ),
  });
}

export interface ProjectMemoToolDependencies {
  projectId: string;
  onUpdateMemos: (memos: ProjectMemo[]) => void;
}

export function createListProjectMemosTool(deps: ProjectMemoToolDependencies) {
  return tool({
    description: "Lists project memos and returns each memo ID and title.",
    inputSchema: z.object({}),
    execute: wrapToolExecute("listProjectMemos", async () => {
      const memos = await listProjectMemos(deps.projectId);
      deps.onUpdateMemos(memos);
      return {
        count: memos.length,
        memos: memos.map((memo) => ({
          id: memo.id,
          title: memo.title || "（無題）",
        })),
      };
    }),
  });
}

const getProjectMemoInputSchema = z.object({
  memoId: z.string().describe("ID of the project memo to retrieve."),
});

export function createGetProjectMemoTool(deps: ProjectMemoToolDependencies) {
  return tool({
    description: "Retrieves the title and full content of a project memo.",
    inputSchema: getProjectMemoInputSchema,
    execute: wrapToolExecute("getProjectMemo", async ({ memoId }) => {
      const memos = await listProjectMemos(deps.projectId);
      const memo = memos.find((m) => m.id === memoId);
      if (!memo) {
        return { error: `指定したメモが見つかりません: ${memoId}` };
      }
      return {
        id: memo.id,
        title: memo.title || "（無題）",
        content: limitToolText(memo.content),
      };
    }),
  });
}

const updateProjectMemoInputSchema = z.object({
  memoId: z.string().describe("ID of the project memo to update."),
  title: z.string().optional().describe("New Japanese title."),
  content: z.string().optional().describe("New Japanese memo content."),
});

export function createUpdateProjectMemoTool(deps: ProjectMemoToolDependencies) {
  return tool({
    description:
      "Updates a project memo title or content. Confirm the ID with listProjectMemos. Any new natural-language value must be Japanese.",
    inputSchema: updateProjectMemoInputSchema,
    execute: wrapToolExecute(
      "updateProjectMemo",
      async ({ memoId, title, content }) => {
        const updates: { title?: string; content?: string } = {};
        if (title !== undefined) updates.title = title;
        if (content !== undefined) updates.content = content;
        if (Object.keys(updates).length === 0) {
          return {
            error: "title または content のいずれかを指定してください。",
          };
        }

        await updateProjectMemo(deps.projectId, memoId, updates);
        const memos = await listProjectMemos(deps.projectId);
        deps.onUpdateMemos(memos);
        const updated = memos.find((m) => m.id === memoId);
        return {
          success: true,
          message: "作品メモを更新しました。",
          memo: updated
            ? {
                id: updated.id,
                title: updated.title || "（無題）",
                content: limitToolText(updated.content),
              }
            : undefined,
        };
      },
    ),
  });
}

const createProjectMemoInputSchema = z.object({
  title: z.string().describe("Japanese title for the new project memo."),
});

export function createCreateProjectMemoTool(deps: ProjectMemoToolDependencies) {
  return tool({
    description: "Creates a new project memo with a Japanese title.",
    inputSchema: createProjectMemoInputSchema,
    execute: wrapToolExecute("createProjectMemo", async ({ title }) => {
      const validation = validateStringField("title", title);
      if (!validation.success) {
        return {
          error: `createProjectMemo の入力が不正です: ${validation.error}`,
        };
      }

      await createProjectMemo(deps.projectId, validation.data);
      const memos = await listProjectMemos(deps.projectId);
      deps.onUpdateMemos(memos);
      return {
        success: true,
        message: `作品メモ「${validation.data}」を作成しました。`,
        memo: memos[memos.length - 1],
      };
    }),
  });
}

export function createListGenresTool() {
  return tool({
    description:
      "Lists genres registered in the genre library. Use this before reading genre-specific guidance when the target genre is unclear.",
    inputSchema: z.object({
      query: z
        .string()
        .optional()
        .describe("Optional text used to filter by genre name, alias-like description, or tags."),
    }),
    execute: wrapToolExecute("listGenres", async ({ query }) => {
      const genres = await listGenres();
      const normalizedQuery = query?.trim().toLocaleLowerCase();
      const filtered = normalizedQuery
        ? genres.filter((genre) =>
            [
              genre.name,
              genre.description,
              genre.status,
              genre.id,
            ]
              .join("\n")
              .toLocaleLowerCase()
              .includes(normalizedQuery),
          )
        : genres;

      return {
        count: filtered.length,
        genres: filtered.map((genre) => ({
          id: genre.id,
          name: genre.name,
          description: limitToolText(genre.description, 500),
          revision: genre.revision,
          sourceCount: genre.sourceCount,
          acceptedKnowledgeCount: genre.acceptedKnowledgeCount,
          candidateKnowledgeCount: genre.candidateKnowledgeCount,
          updatedAt: genre.updatedAt,
        })),
      };
    }),
  });
}

const genreIdInputSchema = z.object({
  genreId: z.string().describe("Genre ID returned by listGenres."),
});

export function createGetGenreOverviewTool() {
  return tool({
    description:
      "Reads a genre overview: name, aliases, description, user definition, notes, tags, and library counts.",
    inputSchema: genreIdInputSchema,
    execute: wrapToolExecute("getGenreOverview", async ({ genreId }) => {
      const { listAnalysisRuns } = await import("../genres/analyzer.ts");
      const [genre, knowledge, sources, analyses] = await Promise.all([
        loadGenre(genreId),
        loadGenreKnowledge(genreId),
        listGenreSources(genreId),
        listAnalysisRuns(genreId),
      ]);
      const activeKnowledge = knowledge.items.filter((item) => item.status === "active");

      return {
        genre: {
          id: genre.id,
          name: genre.name,
          aliases: genre.aliases,
          description: limitToolText(genre.description, 2000),
          userDefinition: limitToolText(genre.userDefinition, 4000),
          notes: limitToolText(genre.notes, 4000),
          tags: genre.tags,
          revision: genre.revision,
          updatedAt: genre.updatedAt,
        },
        counts: {
          sources: sources.length,
          acceptedKnowledge: activeKnowledge.length,
          pendingKnowledgeCandidates: knowledge.candidates.filter((candidate) => candidate.status === "pending").length,
          analyses: analyses.length,
        },
        keyKnowledge: activeKnowledge.slice(0, 20).map((item) => ({
          id: item.id,
          category: item.category,
          importance: item.importance,
          title: item.title,
          statement: limitToolText(item.statement, 800),
        })),
      };
    }),
  });
}

export function createListGenreKnowledgeTool() {
  return tool({
    description:
      "Lists accepted knowledge items for a genre, such as core requirements, prose style, scene patterns, reader contract, generation guidance, prohibitions, and failure modes.",
    inputSchema: z.object({
      genreId: z.string().describe("Genre ID returned by listGenres."),
      category: genreKnowledgeCategorySchema.optional(),
      includeDisabled: z.boolean().optional(),
      maxItems: z.number().int().min(1).max(100).optional(),
    }),
    execute: wrapToolExecute(
      "listGenreKnowledge",
      async ({ genreId, category, includeDisabled, maxItems }) => {
        const knowledge = await loadGenreKnowledge(genreId);
        const items = knowledge.items
          .filter((item) => includeDisabled || item.status === "active")
          .filter((item) => !category || item.category === category)
          .slice(0, maxItems ?? 50);

        return {
          genreId,
          revision: knowledge.revision,
          count: items.length,
          items: items.map((item) => ({
            id: item.id,
            category: item.category,
            importance: item.importance,
            status: item.status,
            confidence: item.confidence,
            title: item.title,
            statement: limitToolText(item.statement, 1200),
            explanation: limitToolText(item.explanation, 1200),
          })),
        };
      },
    ),
  });
}

const getGenreKnowledgeItemInputSchema = z.object({
  genreId: z.string().describe("Genre ID returned by listGenres."),
  itemId: z.string().describe("Knowledge item ID returned by listGenreKnowledge."),
});

export function createGetGenreKnowledgeItemTool() {
  return tool({
    description:
      "Reads a complete accepted genre knowledge item, including explanation and evidence/chat references.",
    inputSchema: getGenreKnowledgeItemInputSchema,
    execute: wrapToolExecute("getGenreKnowledgeItem", async ({ genreId, itemId }) => {
      const knowledge = await loadGenreKnowledge(genreId);
      const item = knowledge.items.find((candidate) => candidate.id === itemId);
      if (!item) {
        return { error: `ジャンル知識が見つかりません: ${itemId}` };
      }

      return {
        item: {
          ...item,
          statement: limitToolText(item.statement),
          explanation: limitToolText(item.explanation),
        },
      };
    }),
  });
}

export function createListGenreSourcesTool() {
  return tool({
    description:
      "Lists reference sources registered for a genre. Use this to identify examples, explanations, counterexamples, or user notes before reading source text.",
    inputSchema: genreIdInputSchema,
    execute: wrapToolExecute("listGenreSources", async ({ genreId }) => {
      const sources = await listGenreSources(genreId);
      return {
        count: sources.length,
        sources: sources.map((source) => ({
          id: source.id,
          title: source.title,
          author: source.author,
          sourceType: source.sourceType,
          sourceRole: source.sourceRole,
          preference: source.preference,
          sourceNote: limitToolText(source.sourceNote, 500),
          userInterpretation: limitToolText(source.userInterpretation, 500),
          characterCount: source.characterCount,
          segmentCount: source.segmentCount,
          analysisStatus: source.analysisStatus,
          latestAnalysisRunId: source.latestAnalysisRunId,
          updatedAt: source.updatedAt,
        })),
      };
    }),
  });
}

const getGenreSourceInputSchema = z.object({
  genreId: z.string().describe("Genre ID returned by listGenres."),
  sourceId: z.string().describe("Source ID returned by listGenreSources."),
  includeContent: z
    .boolean()
    .optional()
    .describe("When true, returns a trimmed version of the source text."),
});

export function createGetGenreSourceTool() {
  return tool({
    description:
      "Reads metadata and optionally source text for a genre reference source. Use includeContent only when exact source details or examples are needed.",
    inputSchema: getGenreSourceInputSchema,
    execute: wrapToolExecute(
      "getGenreSource",
      async ({ genreId, sourceId, includeContent }) => {
        const { metadata, content, segments } = await loadGenreSource(genreId, sourceId);
        return {
          source: {
            ...metadata,
            sourceNote: limitToolText(metadata.sourceNote, 1000),
            userInterpretation: limitToolText(metadata.userInterpretation, 1000),
          },
          segments: segments.map((segment) => ({
            id: segment.id,
            ordinal: segment.ordinal,
            heading: segment.heading,
            startOffset: segment.startOffset,
            endOffset: segment.endOffset,
            segmentationMethod: segment.segmentationMethod,
          })),
          content: includeContent ? limitToolText(content, 16000) : undefined,
        };
      },
    ),
  });
}

export function createSearchGenreSourceTextTool() {
  return tool({
    description:
      "Searches registered genre reference source text and returns source IDs, segment IDs, headings, and snippets.",
    inputSchema: z.object({
      genreId: z.string().describe("Genre ID returned by listGenres."),
      query: z.string().describe("Search phrase to find in source text."),
      sourceIds: z.array(z.string()).optional(),
      maxResults: z.number().int().min(1).max(30).optional(),
    }),
    execute: wrapToolExecute(
      "searchGenreSourceText",
      async ({ genreId, query, sourceIds, maxResults }) => {
        const normalizedQuery = query.trim().toLocaleLowerCase();
        if (!normalizedQuery) return { results: [] };

        const sources = await listGenreSources(genreId);
        const targetSources = sourceIds?.length
          ? sources.filter((source) => sourceIds.includes(source.id))
          : sources;
        const limit = maxResults ?? 10;
        const results: Array<{
          sourceId: string;
          title: string;
          segmentId: string;
          heading: string;
          snippet: string;
        }> = [];

        for (const source of targetSources) {
          if (results.length >= limit) break;
          const { content, segments } = await loadGenreSource(genreId, source.id);
          for (const segment of segments) {
            if (results.length >= limit) break;
            const segmentText = extractSegmentContent(content, segment);
            const searchText = segmentText.toLocaleLowerCase();
            const matchIndex = searchText.indexOf(normalizedQuery);
            if (matchIndex === -1) continue;

            const start = Math.max(0, matchIndex - 160);
            const end = Math.min(segmentText.length, matchIndex + query.length + 160);
            results.push({
              sourceId: source.id,
              title: source.title,
              segmentId: segment.id,
              heading: segment.heading,
              snippet: limitToolText(segmentText.slice(start, end), 500),
            });
          }
        }

        return { count: results.length, results };
      },
    ),
  });
}

export function createListGenreAnalysesTool() {
  return tool({
    description:
      "Lists genre analysis runs. Use this to find analysis IDs before reading detailed genre analysis.",
    inputSchema: z.object({
      genreId: z.string().describe("Genre ID returned by listGenres."),
      sourceId: z.string().optional(),
    }),
    execute: wrapToolExecute("listGenreAnalyses", async ({ genreId, sourceId }) => {
      const { listAnalysisRuns } = await import("../genres/analyzer.ts");
      const runs = await listAnalysisRuns(genreId);
      const filtered = sourceId ? runs.filter((run) => run.sourceId === sourceId) : runs;
      return {
        count: filtered.length,
        analyses: filtered.map((run) => ({
          id: run.id,
          sourceId: run.sourceId,
          status: run.status,
          provider: run.provider,
          model: run.model,
          totalSegments: run.totalSegments,
          completedSegments: run.completedSegments,
          failedSegments: run.failedSegments,
          hasSynthesis: Boolean(run.synthesis),
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          error: run.error,
        })),
      };
    }),
  });
}

const getGenreAnalysisInputSchema = z.object({
  genreId: z.string().describe("Genre ID returned by listGenres."),
  analysisRunId: z.string().describe("Analysis run ID returned by listGenreAnalyses."),
  maxSegments: z.number().int().min(1).max(20).optional(),
});

export function createGetGenreAnalysisTool() {
  return tool({
    description:
      "Reads a genre source analysis run, including synthesis and trimmed segment summaries/features.",
    inputSchema: getGenreAnalysisInputSchema,
    execute: wrapToolExecute(
      "getGenreAnalysis",
      async ({ genreId, analysisRunId, maxSegments }) => {
        const { loadAnalysisRun } = await import("../genres/analyzer.ts");
        const run = await loadAnalysisRun(genreId, analysisRunId);
        if (!run) {
          return { error: `ジャンル分析が見つかりません: ${analysisRunId}` };
        }

        return {
          analysis: {
            id: run.id,
            genreId: run.genreId,
            sourceId: run.sourceId,
            status: run.status,
            provider: run.provider,
            model: run.model,
            totalSegments: run.totalSegments,
            completedSegments: run.completedSegments,
            failedSegments: run.failedSegments,
            synthesis: run.synthesis
              ? {
                  sourceSummary: limitToolText(run.synthesis.sourceSummary, 2000),
                  contributionToGenre: run.synthesis.contributionToGenre,
                  deviationsFromGenre: run.synthesis.deviationsFromGenre,
                  workSpecificElements: run.synthesis.workSpecificElements,
                  readerExpectations: run.synthesis.readerExpectations,
                  structuralPatterns: run.synthesis.structuralPatterns,
                  stylisticPatterns: run.synthesis.stylisticPatterns,
                  failureRisks: run.synthesis.failureRisks,
                }
              : undefined,
            segmentResults: run.segmentResults.slice(0, maxSegments ?? 5).map((segment) => ({
              id: segment.id,
              sourceId: segment.sourceId,
              segmentId: segment.segmentId,
              summary: limitToolText(segment.summary, 1200),
              pointOfView: segment.pointOfView,
              narratorCharacteristics: segment.narratorCharacteristics,
              genreSignals: segment.genreSignals.map((item) => ({
                statement: limitToolText(item.statement, 500),
                confidence: item.confidence,
              })),
              proseFeatures: segment.proseFeatures.map((item) => ({
                statement: limitToolText(item.statement, 500),
                confidence: item.confidence,
              })),
              scenePatterns: segment.scenePatterns.map((pattern) => ({
                name: pattern.name,
                purpose: limitToolText(pattern.purpose, 500),
                expectedEffect: limitToolText(pattern.expectedEffect, 500),
                confidence: pattern.confidence,
              })),
              generationGuidance: segment.generationGuidance.map((item) => ({
                statement: limitToolText(item.statement, 500),
                confidence: item.confidence,
              })),
              possibleFailureModes: segment.possibleFailureModes.map((item) => ({
                statement: limitToolText(item.statement, 500),
                confidence: item.confidence,
              })),
              confidence: segment.confidence,
            })),
            error: run.error,
            startedAt: run.startedAt,
            completedAt: run.completedAt,
          },
        };
      },
    ),
  });
}
