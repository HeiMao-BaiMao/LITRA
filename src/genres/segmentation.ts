import { computeTextHash } from "./hash.ts";
import type { GenreSourceSegment } from "./schema.ts";

export interface SegmentationOptions {
  /** 1セグメントの最大文字数。デフォルト 8000。 */
  maxChars?: number;
  /** セグメントの目安最小文字数。それ以下の場合は隣とマージを試みる。デフォルト 100。 */
  minChars?: number;
}

const DEFAULT_MAX_CHARS = 8000;
const DEFAULT_MIN_CHARS = 100;

const HEADING_PATTERN = /^(#{1,6}\s+.+)$/m;
const CHAPTER_PATTERN = /^(第[一二三四五六七八九十百千万億0-9０-９]+[話章節].*)$/m;
const SCENE_BREAK_PATTERN = /^(={3,}|\*{3,}|-{3,}|・{3,}|…{3,}|\.{3,}|‥{3,}|\[\s*\]|◆|◇|■|□|※)\s*$/m;

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function findSplitPositions(text: string): number[] {
  const positions = new Set<number>();
  positions.add(0);

  const patterns = [HEADING_PATTERN, CHAPTER_PATTERN, SCENE_BREAK_PATTERN];
  for (const pattern of patterns) {
    const regex = new RegExp(pattern.source, pattern.flags.includes("m") ? "gm" : "g");
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      positions.add(match.index);
    }
  }

  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    const nextLine = lines[i + 1];
    if (
      line.trim().length === 0 &&
      nextLine.trim().length > 0 &&
      !SCENE_BREAK_PATTERN.test(nextLine)
    ) {
      const candidate = offset + line.length + 1;
      if (candidate < text.length) {
        positions.add(candidate);
      }
    }
    offset += line.length + 1;
  }

  positions.add(text.length);
  return [...positions].sort((a, b) => a - b);
}

function splitByParagraphs(text: string, maxChars: number): string[] {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      if (current.length > 0) {
        chunks.push(current.trim());
        current = "";
      }
      chunks.push(...splitLongParagraph(paragraph, maxChars));
      continue;
    }

    if (current.length + paragraph.length + 2 > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = paragraph;
    } else {
      current = current.length > 0 ? `${current}\n\n${paragraph}` : paragraph;
    }
  }

  if (current.length > 0) {
    chunks.push(current.trim());
  }

  return chunks.length > 0 ? chunks : [text];
}

function splitLongParagraph(paragraph: string, maxChars: number): string[] {
  const sentences = paragraph.match(/[^。！？\.\?!]+[。！？\.\?!]?/g) ?? [paragraph];
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (current.length > 0) {
        chunks.push(current.trim());
        current = "";
      }
      for (let i = 0; i < sentence.length; i += maxChars) {
        chunks.push(sentence.slice(i, i + maxChars));
      }
      continue;
    }

    if (current.length + sentence.length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }

  if (current.length > 0) {
    chunks.push(current.trim());
  }

  return chunks.length > 0 ? chunks : [paragraph];
}

function mergeSmallSegments(segments: GenreSourceSegment[], minChars: number): GenreSourceSegment[] {
  if (segments.length <= 1) return segments;

  const merged: GenreSourceSegment[] = [];
  let pending: GenreSourceSegment | null = null;

  for (const segment of segments) {
    const length = segment.endOffset - segment.startOffset;
    if (length < minChars && pending === null) {
      pending = segment;
      continue;
    }

    if (pending !== null) {
      pending = {
        ...pending,
        endOffset: segment.endOffset,
        heading: pending.heading || segment.heading,
        segmentationMethod: "paragraph_group",
      };
      if (pending.endOffset - pending.startOffset >= minChars) {
        merged.push(pending);
        pending = null;
      }
    } else {
      merged.push(segment);
    }
  }

  if (pending !== null) {
    const last = merged[merged.length - 1];
    if (last) {
      merged[merged.length - 1] = {
        ...last,
        endOffset: pending.endOffset,
        heading: last.heading || pending.heading,
      };
    } else {
      merged.push(pending);
    }
  }

  return merged;
}

/**
 * 資料テキストをセグメントに分割する。
 */
export async function segmentSourceText(
  sourceId: string,
  text: string,
  options: SegmentationOptions = {},
): Promise<GenreSourceSegment[]> {
  const normalized = normalizeLineEndings(text);
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const minChars = options.minChars ?? DEFAULT_MIN_CHARS;

  if (normalized.length === 0) {
    return [];
  }

  const splitPositions = findSplitPositions(normalized);
  const rawSegments: GenreSourceSegment[] = [];

  for (let i = 0; i < splitPositions.length - 1; i++) {
    const start = splitPositions[i];
    const end = splitPositions[i + 1];
    const content = normalized.slice(start, end).trim();
    if (content.length === 0) continue;

    const headingMatch = content.match(/^(#{1,6}\s+|第[一二三四五六七八九十百千万億0-9０-９]+[話章節]\s*)?(.+)$/m);
    const heading = headingMatch?.[2]?.slice(0, 80) ?? "";

    rawSegments.push({
      id: crypto.randomUUID(),
      sourceId,
      ordinal: rawSegments.length,
      heading,
      startOffset: start,
      endOffset: start + content.length,
      contentHash: await computeTextHash(content),
      segmentationMethod: "heading",
    });
  }

  const splitSegments: GenreSourceSegment[] = [];
  for (const segment of rawSegments) {
    const content = normalized.slice(segment.startOffset, segment.endOffset);
    if (content.length <= maxChars) {
      splitSegments.push(segment);
      continue;
    }

    const chunks = splitByParagraphs(content, maxChars);
    let offset = segment.startOffset;
    for (const chunk of chunks) {
      splitSegments.push({
        id: crypto.randomUUID(),
        sourceId,
        ordinal: splitSegments.length,
        heading: segment.heading,
        startOffset: offset,
        endOffset: offset + chunk.length,
        contentHash: await computeTextHash(chunk),
        segmentationMethod: "paragraph_group",
      });
      offset += chunk.length;
      while (offset < normalized.length && /\s/.test(normalized[offset])) {
        offset++;
      }
    }
  }

  const merged = mergeSmallSegments(splitSegments, minChars);

  return merged.map((segment, index) => ({
    ...segment,
    ordinal: index,
  }));
}

/**
 * セグメントの本文を原文から切り出す。
 */
export function extractSegmentContent(
  sourceText: string,
  segment: GenreSourceSegment,
): string {
  const normalized = normalizeLineEndings(sourceText);
  return normalized.slice(segment.startOffset, segment.endOffset);
}
