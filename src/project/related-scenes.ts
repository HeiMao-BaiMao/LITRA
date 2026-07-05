import { invoke } from "@tauri-apps/api/core";
import { limitPromptText } from "../ai/prompts.ts";
import type { Character } from "./schema.ts";

// 直前本文の末尾からこの文字数だけを「いまの場面」とみなして人物を探す
const TAIL_SCAN_CHARS = 3000;
// 注入する人物数・抜粋の上限(弱いモデルが長い文脈で迷子になるのを防ぐ)
const MAX_CHARACTERS = 3;
const SNIPPET_MAX_CHARS = 400;
const BLOCK_MAX_CHARS = 2400;
// 本文系の docType(search.rs 側で "fullText" のみが本文、"summary" が要約)
const FULL_TEXT_DOC_TYPE = "fullText";

interface SearchEpisodesResult {
  score: number;
  episodeId: string;
  title: string;
  docType: string;
  snippet: string;
}

interface MentionedCharacter {
  character: Character;
  lastMentionIndex: number;
}

// name / reading / alias から2文字以上の照合候補文字列を集める(1文字は誤ヒットしやすいため除外)
function candidateStringsForCharacter(character: Character): string[] {
  const raw = [character.name, character.reading, character.alias];
  return raw
    .flatMap((value) => (value ?? "").split(/[\n,、]+/u))
    .map((value) => value.trim())
    .filter((value) => value.length >= 2);
}

// 走査窓内での最終言及位置(最大の lastIndexOf)を人物ごとに求める
function findMentionedCharacters(
  characters: Character[],
  window: string,
): MentionedCharacter[] {
  const mentioned: MentionedCharacter[] = [];
  for (const character of characters) {
    const candidates = candidateStringsForCharacter(character);
    let lastMentionIndex = -1;
    for (const candidate of candidates) {
      const index = window.lastIndexOf(candidate);
      if (index > lastMentionIndex) lastMentionIndex = index;
    }
    if (lastMentionIndex >= 0) {
      mentioned.push({ character, lastMentionIndex });
    }
  }
  // 直近に言及された順(位置が大きい順)に並べる
  return mentioned.sort((a, b) => b.lastMentionIndex - a.lastMentionIndex);
}

async function findPastSceneForCharacter(options: {
  projectId: string;
  currentEpisodeId?: string;
  character: Character;
  usedEpisodeIds: Set<string>;
}): Promise<{ title: string; snippet: string; episodeId: string } | undefined> {
  const { projectId, currentEpisodeId, character, usedEpisodeIds } = options;
  try {
    const results = await invoke<SearchEpisodesResult[]>("search_episodes", {
      req: { projectId, query: character.name, limit: 5 },
    });

    const candidates = results
      .filter((r) => r.episodeId !== currentEpisodeId)
      .filter((r) => !usedEpisodeIds.has(r.episodeId));

    // 本文系(fullText)を優先し、無ければ他の docType(summary 等)から採用する
    const fullTextMatch = candidates.find((r) => r.docType === FULL_TEXT_DOC_TYPE);
    const fallbackMatch = candidates[0];
    const chosen = fullTextMatch ?? fallbackMatch;
    if (!chosen) return undefined;

    return { title: chosen.title, snippet: chosen.snippet, episodeId: chosen.episodeId };
  } catch (error) {
    console.warn("[litra] related scene search failed for", character.name, error);
    return undefined;
  }
}

/**
 * 続き生成の直前に、直前本文へ登場している人物を文字列照合で検出し、
 * 既存の全文検索インデックスからその人物の過去の登場場面を短く抜粋する。
 * LLMを使わずに一貫性(呼称・口調・関係・既知の事実)の参考資料を作るための処理で、
 * 検索や照合の失敗は全体の続き生成を止めてはならないため、ここで完全に吸収する。
 */
export async function buildRelatedScenesBlock(options: {
  projectId: string;
  currentEpisodeId?: string;
  characters: Character[];
  tailContext: string;
}): Promise<string | undefined> {
  const { projectId, currentEpisodeId, characters, tailContext } = options;

  // 個々の invoke は findPastSceneForCharacter 内で吸収済みだが、
  // 予期しない同期例外も含めてこの関数内で完全に握りつぶし、続き生成を絶対に止めない。
  try {
    const window = tailContext.slice(-TAIL_SCAN_CHARS);
    const mentioned = findMentionedCharacters(characters, window).slice(0, MAX_CHARACTERS);
    if (mentioned.length === 0) return undefined;

    const usedEpisodeIds = new Set<string>();
    const sections: string[] = [];

    for (const { character } of mentioned) {
      const found = await findPastSceneForCharacter({
        projectId,
        currentEpisodeId,
        character,
        usedEpisodeIds,
      });
      if (!found) continue;

      usedEpisodeIds.add(found.episodeId);
      const snippet = limitPromptText(found.snippet, SNIPPET_MAX_CHARS, "middle");
      sections.push(`● ${character.name}（「${found.title}」より）:\n${snippet}`);
    }

    if (sections.length === 0) return undefined;

    return limitPromptText(sections.join("\n\n"), BLOCK_MAX_CHARS, "head");
  } catch (error) {
    console.warn("[litra] related scenes lookup failed unexpectedly; skipping", error);
    return undefined;
  }
}
