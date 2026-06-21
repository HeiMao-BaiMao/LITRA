import { tool } from "ai";
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

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

const editInputSchema = z.object({
  startLine: z.number().int().min(1).describe("置き換え開始行（1始まり）"),
  endLine: z.number().int().min(1).describe("置き換え終了行（1始まり）"),
  expectedText: z.string().describe("該当行範囲の現在の正確なテキスト"),
  replacementText: z.string().describe("挿入する置き換え後のテキスト"),
});

export function createEditEpisodeTool(deps: EditToolDependencies) {
  return tool({
    description:
      "指定した行範囲の内容が一致している場合に、その範囲を置き換えます。行番号は1始まりです。expectedText には該当行範囲の正確なテキスト、replacementText には置き換え後の正確なテキストを指定してください。",
    inputSchema: editInputSchema,
    execute: async ({ startLine, endLine, expectedText, replacementText }) => {
      const result = await invoke<{
        success: boolean;
        message: string;
        newText?: string;
        actualText?: string;
        totalLines?: number;
      }>("edit_episode_text", {
        projectId: deps.projectId,
        episodeId: deps.episodeId,
        startLine,
        endLine,
        expectedText,
        replacementText,
      });
      if (result.success && result.newText != null) {
        deps.onApply(result.newText);
      }
      return result;
    },
  });
}

export function createListEpisodesTool(deps: SearchDependencies) {
  return tool({
    description:
      "登録されているエピソードの一行要約一覧を取得します。過去話の内容を確認したい場合に、まずこのツールで該当エピソードを特定してください。",
    inputSchema: z.object({}),
    execute: async () => {
      return await invoke<{
        episodeId: string;
        order: number;
        title: string;
        oneLineSummary: string;
      }[]>("list_episodes_with_summaries", { projectId: deps.projectId });
    },
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
      "指定したエピソードの要約または本文を取得します。listEpisodes で特定したエピソードの詳細を確認する場合に使用してください。",
    inputSchema: retrieveInputSchema,
    execute: async ({ episodeId, type }) => {
      return await invoke<{
        episodeId: string;
        title: string;
        order: number;
        contentType: string;
        content: string;
      }>("retrieve_episode_content", {
        projectId: deps.projectId,
        episodeId,
        contentType: type,
      });
    },
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
    execute: async ({ query, limit }) => {
      return await invoke<{
        score: number;
        episodeId: string;
        title: string;
        docType: string;
        snippet: string;
      }[]>("search_episodes", {
        projectId: deps.projectId,
        query,
        limit,
      });
    },
  });
}

export function createRebuildSearchIndexTool(deps: SearchDependencies) {
  return tool({
    description:
      "内部検索インデックスを最新のエピソード内容で再構築します。インデックスが古い可能性がある場合や、検索結果がない場合に使用してください。",
    inputSchema: z.object({}),
    execute: async () => {
      return await invoke<{
        success: boolean;
        message: string;
        indexedDocuments: number;
      }>("rebuild_search_index", { projectId: deps.projectId });
    },
  });
}

const saveSummaryInputSchema = z.object({
  episodeId: z.string().describe("要約を保存するエピソードのID"),
  content: z.string().describe("エピソードの要約文。本文の内容を簡潔にまとめたもの。"),
});

export function createSaveEpisodeSummaryTool(deps: SummaryToolDependencies) {
  return tool({
    description:
      "指定したエピソードの要約を保存または更新します。retrieveEpisode で本文を確認し、内容を要約してから呼び出してください。",
    inputSchema: saveSummaryInputSchema,
    execute: async ({ episodeId, content }) => {
      await invoke("save_episode_summary", {
        projectId: deps.projectId,
        episodeId,
        content,
      });
      deps.onSaveSummary?.(episodeId, content);
      return { success: true, message: "要約を保存しました。" };
    },
  });
}

const saveOneLinerInputSchema = z.object({
  episodeId: z.string().describe("一行要約を保存するエピソードのID"),
  oneLiner: z.string().describe("エピソードの一行要約。100文字以内を目安に。"),
});

export function createSaveEpisodeOneLinerTool(deps: SummaryToolDependencies) {
  return tool({
    description:
      "指定したエピソードの一行要約を保存または更新します。要約をさらに短く圧縮したものを saveEpisodeSummary の後などに呼び出してください。",
    inputSchema: saveOneLinerInputSchema,
    execute: async ({ episodeId, oneLiner }) => {
      await invoke("save_episode_one_liner", {
        projectId: deps.projectId,
        episodeId,
        oneLiner,
      });
      deps.onSaveOneLiner?.(episodeId, oneLiner);
      return { success: true, message: "一行要約を保存しました。" };
    },
  });
}

export interface SettingsToolDependencies {
  projectId: string;
  onUpdateCharacters: (characters: Character[]) => void;
  onUpdateWorldEntries: (entries: WorldEntry[]) => void;
}

import type { Character, WorldEntry } from "../project/schema.ts";

export function createListCharactersTool(deps: SettingsToolDependencies) {
  return tool({
    description:
      "登録されているキャラクター設定一覧を取得します。キャラクターのIDと各項目を確認してから updateCharacter で編集してください。",
    inputSchema: z.object({}),
    execute: async () => {
      const result = await invoke<{ characters: Character[] }>("list_characters", {
        projectId: deps.projectId,
      });
      deps.onUpdateCharacters(result.characters);
      return result;
    },
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
    execute: async ({ characterId, updates }) => {
      const result = await invoke<{ characters: Character[] }>("update_character", {
        projectId: deps.projectId,
        characterId,
        updates,
      });
      deps.onUpdateCharacters(result.characters);
      return { success: true, message: "キャラクター設定を更新しました。" };
    },
  });
}

const createCharacterInputSchema = z.object({
  name: z.string().describe("新しいキャラクターの名前"),
});

export function createCreateCharacterTool(deps: SettingsToolDependencies) {
  return tool({
    description: "新しいキャラクター設定を作成します。",
    inputSchema: createCharacterInputSchema,
    execute: async ({ name }) => {
      const result = await invoke<{ characters: Character[] }>("create_character", {
        projectId: deps.projectId,
        name,
      });
      deps.onUpdateCharacters(result.characters);
      return { success: true, message: `キャラクター「${name}」を作成しました。` };
    },
  });
}

export function createListWorldEntriesTool(deps: SettingsToolDependencies) {
  return tool({
    description:
      "登録されている世界観設定一覧を取得します。世界観のIDと各項目を確認してから updateWorldEntry で編集してください。",
    inputSchema: z.object({}),
    execute: async () => {
      const result = await invoke<{ entries: WorldEntry[] }>("list_world_entries", {
        projectId: deps.projectId,
      });
      deps.onUpdateWorldEntries(result.entries);
      return result;
    },
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
    execute: async ({ entryId, updates }) => {
      const result = await invoke<{ entries: WorldEntry[] }>("update_world_entry", {
        projectId: deps.projectId,
        entryId,
        updates,
      });
      deps.onUpdateWorldEntries(result.entries);
      return { success: true, message: "世界観設定を更新しました。" };
    },
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
    execute: async ({ name, category }) => {
      const result = await invoke<{ entries: WorldEntry[] }>("create_world_entry", {
        projectId: deps.projectId,
        name,
        category,
      });
      deps.onUpdateWorldEntries(result.entries);
      return { success: true, message: `世界観「${name}」を作成しました。` };
    },
  });
}
