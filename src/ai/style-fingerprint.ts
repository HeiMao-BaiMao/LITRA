// 文体指紋(提案3)の決定論的な計測。LLM を使わず、統計値だけをコード側で算出する。

import { splitJapaneseSentences, splitParagraphs } from "./text-stats.ts";
import type { StyleFingerprint } from "./prompts.ts";

const KANJI_PATTERN = /[一-鿿々]/g;

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * 文の末尾表現を分類する。感嘆・疑問文(！？)は対象外。
 * です/ます/だ/た/る以外の「。」文は体言止め・その他としてまとめる(近似)。
 */
function classifySentenceEnding(sentence: string): string | undefined {
  let core = sentence.replace(/[」』)）\]]+$/u, "");
  if (!core.endsWith("。")) return undefined;
  core = core.slice(0, -1);

  if (core.endsWith("です")) return "です。";
  if (core.endsWith("ます")) return "ます。";
  if (core.endsWith("だ")) return "だ。";
  if (core.endsWith("た")) return "た。";
  if (core.endsWith("る")) return "る。";
  return "体言止め・その他";
}

/** 現エピソード全文などの生テキストから文体指紋を計測する。 */
export function measureStyleFingerprint(text: string): StyleFingerprint {
  const sentences = splitJapaneseSentences(text);
  const paragraphs = splitParagraphs(text);

  const kanjiCount = (text.match(KANJI_PATTERN) ?? []).length;
  const kanjiRatio = text.length > 0 ? kanjiCount / text.length : 0;

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const dialogueLineCount = lines.filter((line) => line.startsWith("「")).length;
  const dialogueRatio = lines.length > 0 ? dialogueLineCount / lines.length : 0;

  const averageSentenceLength = average(sentences.map((s) => s.length));
  const averageSentencesPerParagraph = average(paragraphs.map((p) => splitJapaneseSentences(p).length));

  const endingCounts = new Map<string, number>();
  let classifiedTotal = 0;
  for (const sentence of sentences) {
    const form = classifySentenceEnding(sentence);
    if (!form) continue;
    endingCounts.set(form, (endingCounts.get(form) ?? 0) + 1);
    classifiedTotal++;
  }
  const sentenceEndings = [...endingCounts.entries()]
    .map(([form, count]) => ({ form, ratio: classifiedTotal > 0 ? count / classifiedTotal : 0 }))
    .sort((a, b) => b.ratio - a.ratio);

  return {
    averageSentenceLength,
    kanjiRatio,
    dialogueRatio,
    averageSentencesPerParagraph,
    sentenceEndings,
  };
}

// これ未満の文字数では統計が安定しないため、直前エピソードの本文で補う
const MIN_SAMPLE_CHARS = 2000;

/** 現エピソードの本文が短い場合、直前エピソードの本文を先頭に補って計測材料を確保する。 */
export function composeStyleSampleText(currentEpisodeText: string, previousEpisodeText?: string): string {
  if (currentEpisodeText.length >= MIN_SAMPLE_CHARS || !previousEpisodeText) return currentEpisodeText;
  return `${previousEpisodeText}\n\n${currentEpisodeText}`;
}
