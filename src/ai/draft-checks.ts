// 続き生成ドラフトの決定論的な検問+サニタイザ(提案4)。
// LLM を使わない機械検査のみ。判定はすべてこのモジュール側のコードで完結させ、
// 弱いモデルに「良い/悪い」の判断そのものをさせない。

import { splitJapaneseSentences } from "./text-stats.ts";

// 20文字未満の反復は「そうか」等の相槌的な短文で誤検知しやすいため対象外にする
const MIN_REPEAT_SENTENCE_LENGTH = 10;
// 直前本文とドラフト先頭の一致がこの文字数以上なら「ほぼそのまま反復」とみなす
const MIN_CONTEXT_OVERLAP_LENGTH = 18;
const CONTEXT_TAIL_SCAN_CHARS = 200;
const DRAFT_HEAD_SCAN_CHARS = 200;
const FIRST_PERSON_CONTEXT_TAIL_CHARS = 1500;

const PREAMBLE_LINE_PATTERN =
  /^\s*(以下(が|は)?[^\n]{0,20}(続き|本文)[^\n]{0,10}[:：]?|承知(いたし)?しました[。!]?|かしこまりました[。!]?|それでは(続きを)?(書き|お書き)?します[。!]?)\s*\n+/;
const LEADING_CODE_FENCE_PATTERN = /^\s*```[^\n]*\n/;
const TRAILING_CODE_FENCE_PATTERN = /\n```\s*$/;
const LEADING_HEADING_PATTERN = /^\s*#{1,6}\s+[^\n]*\n+/;

/**
 * 前置き・コードフェンス・見出しの混入を除去する(検出ではなく無条件の除去)。
 * 弱いモデルが「承知しました」等の応答的な前置きを本文に混ぜてしまう事故を潰す。
 */
export function sanitizeDraftText(draft: string): string {
  let text = draft;
  text = text.replace(LEADING_CODE_FENCE_PATTERN, "");
  text = text.replace(TRAILING_CODE_FENCE_PATTERN, "");
  text = text.replace(PREAMBLE_LINE_PATTERN, "");
  text = text.replace(LEADING_HEADING_PATTERN, "");
  return text;
}

function longestCommonSubstring(a: string, b: string): string {
  if (!a || !b) return "";
  let previousRow = new Array(b.length + 1).fill(0);
  let maxLen = 0;
  let endIndexInA = 0;

  for (let i = 1; i <= a.length; i++) {
    const currentRow = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        currentRow[j] = previousRow[j - 1] + 1;
        if (currentRow[j] > maxLen) {
          maxLen = currentRow[j];
          endIndexInA = i;
        }
      }
    }
    previousRow = currentRow;
  }

  return a.slice(endIndexInA - maxLen, endIndexInA);
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(needle, index)) !== -1) {
    count++;
    index += needle.length;
  }
  return count;
}

const FIRST_PERSON_PRONOUNS = ["私", "僕", "俺", "わたし", "あたし", "わし", "拙者", "うち", "小生"];

function dominantFirstPerson(text: string): string | undefined {
  let best: string | undefined;
  let bestCount = 0;
  for (const pronoun of FIRST_PERSON_PRONOUNS) {
    const count = countOccurrences(text, pronoun);
    if (count > bestCount) {
      best = pronoun;
      bestCount = count;
    }
  }
  return best;
}

/**
 * 直前本文で確立している一人称が、ドラフト中に一度も現れず、
 * 別の一人称に置き換わっている場合だけを違反とする(混在は視点交代等の可能性があるため許容)。
 */
function detectFirstPersonDrift(draft: string, context: string): string | undefined {
  const contextTail = context.slice(-FIRST_PERSON_CONTEXT_TAIL_CHARS);
  const expected = dominantFirstPerson(contextTail);
  if (!expected) return undefined;
  if (countOccurrences(draft, expected) > 0) return undefined;

  const draftDominant = dominantFirstPerson(draft);
  if (!draftDominant || draftDominant === expected) return undefined;

  return `直前本文の一人称は「${expected}」だが、続きでは一度も使われず「${draftDominant}」に変わっている(一人称の変化)`;
}

export interface DraftCheckFindings {
  /** 破棄して再執筆すべき違反(反復・前置き等) */
  hard: string[];
  /** 査読へ回して修正で対応させる軽微な違反 */
  soft: string[];
}

/**
 * ドラフト(サニタイズ済み想定)を機械的に検問する。
 * ここでの判定はすべて文字列処理のみで完結し、LLM は一切使わない。
 */
export function checkDraft(draft: string, context: string): DraftCheckFindings {
  const hard: string[] = [];
  const soft: string[] = [];

  const contextTail = context.slice(-CONTEXT_TAIL_SCAN_CHARS);
  const draftHead = draft.slice(0, DRAFT_HEAD_SCAN_CHARS);
  const overlap = longestCommonSubstring(contextTail, draftHead);
  if (overlap.length >= MIN_CONTEXT_OVERLAP_LENGTH) {
    hard.push(`直前本文の一文をほぼそのまま反復している(「${overlap.slice(0, 40)}」)`);
  }

  const sentenceCounts = new Map<string, number>();
  for (const sentence of splitJapaneseSentences(draft)) {
    if (sentence.length < MIN_REPEAT_SENTENCE_LENGTH) continue;
    sentenceCounts.set(sentence, (sentenceCounts.get(sentence) ?? 0) + 1);
  }
  for (const [sentence, count] of sentenceCounts) {
    if (count >= 2) {
      hard.push(`ドラフト内で同一の文が${count}回繰り返されている(「${sentence.slice(0, 40)}」)`);
    }
  }

  const pronounDrift = detectFirstPersonDrift(draft, context);
  if (pronounDrift) soft.push(pronounDrift);

  return { hard, soft };
}
