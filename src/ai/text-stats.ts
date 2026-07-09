// 日本語の文・段落を決定論的に計測するための小さな共有ユーティリティ。
// LLM を使わず、文体指紋(提案3)・ドラフト機械検査(提案4)の両方から利用する。

const OPEN_BRACKETS = new Set(["「", "『", "(", "（", "["]);
const CLOSE_BRACKETS = new Set(["」", "』", ")", "）", "]"]);
const SENTENCE_END_CHARS = new Set(["。", "！", "？", "!", "?"]);

/**
 * 「。」等で文を分割する。括弧(「」『』()（）[])内の句点では分割しない
 * (会話文の中の句点で文が途切れるのを防ぐ)。
 */
export function splitJapaneseSentences(text: string): string[] {
  const sentences: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (OPEN_BRACKETS.has(ch)) {
      depth++;
      continue;
    }
    if (CLOSE_BRACKETS.has(ch)) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (SENTENCE_END_CHARS.has(ch) && depth === 0) {
      let end = i + 1;
      // 終端記号の直後に閉じ括弧が続く場合はそこまでを1文に含める(例:「そうか。」)
      while (end < text.length && CLOSE_BRACKETS.has(text[end])) end++;
      sentences.push(text.slice(start, end));
      start = end;
      i = end - 1;
    }
  }
  if (start < text.length) {
    const rest = text.slice(start);
    if (rest.trim()) sentences.push(rest);
  }

  return sentences.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** 空行(2つ以上の改行)で段落に分割する。 */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}
