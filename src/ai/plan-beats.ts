// 構想メモ(buildContinuationPlanPrompt の出力)からビート分割生成(提案8)用の
// 「主要ビート」箇条書きを抽出する。自由文からの抽出のため頑健性を優先し、
// 抽出に失敗した場合は空配列を返して呼び出し側で一括生成にフォールバックさせる。

const BEAT_SECTION_HEADER_PATTERN = /主要ビート/;
const NEXT_LABEL_PATTERNS = [/^\s*(使う感覚描写|避けるべき|場面の目的)/, /^\s*【/];
const LIST_MARKER_PATTERN = /^\s*(?:[-・*]|\d+[.、)]|[①②③④⑤⑥⑦⑧⑨])\s*/;

/** ビート分割生成に使うには最低これだけの独立したビートが要る(1つなら分割の意味が無い) */
const MIN_BEATS_FOR_SPLIT = 2;

/**
 * 構想メモの「主要ビート」箇条書きを抽出する。
 * 見出しが見つからない、または箇条書きが1つ以下しか取れない場合は空配列を返す
 * (呼び出し側はこれを「ビート分割不可」の合図として扱い、一括生成へフォールバックする)。
 */
export function parsePlanBeats(plan: string): string[] {
  const lines = plan.split("\n");
  const headerIndex = lines.findIndex((line) => BEAT_SECTION_HEADER_PATTERN.test(line));
  if (headerIndex === -1) return [];

  const beats: string[] = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (NEXT_LABEL_PATTERNS.some((pattern) => pattern.test(line))) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const withoutMarker = trimmed.replace(LIST_MARKER_PATTERN, "").trim();
    if (!withoutMarker) continue;
    beats.push(withoutMarker);
  }

  return beats.length >= MIN_BEATS_FOR_SPLIT ? beats : [];
}
