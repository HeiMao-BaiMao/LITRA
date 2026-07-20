//! Source-text segmentation — ported from `legacy-ts-archive/src/genres/segmentation.ts`.
//!
//! Splits a source text into segments by detecting headings (`# …`), chapter
//! markers (`第X話/章/節`), and scene breaks (`***`, `---`, etc.), then further
//! splits overly long segments by paragraphs and merges very small ones.

use regex::Regex;
use wasm_bindgen::JsValue;

use crate::runtime::tauri;

use super::hash::compute_text_hash;
use super::models::SourceSegment;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/// Tuning knobs for [`segment_source_text`].
pub struct SegmentationOptions {
    /// Maximum byte-length of a single segment before paragraph splitting kicks in.
    pub max_chars: usize,
    /// Segments shorter than this (in bytes) are merged with a neighbour.
    pub min_chars: usize,
}

impl Default for SegmentationOptions {
    fn default() -> Self {
        Self {
            max_chars: 8000,
            min_chars: 100,
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn normalize_line_endings(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// Collect byte-offsets where the text should be split.
///
/// Positions come from three regex families (headings, chapter markers, scene
/// breaks) plus paragraph boundaries (an empty line followed by a non-empty,
/// non-scene-break line).
fn find_split_positions(text: &str) -> Vec<usize> {
    let heading_re = Regex::new(r"(?m)^(#{1,6}\s+.+)$").unwrap();
    let chapter_re =
        Regex::new(r"(?m)^(第[一二三四五六七八九十百千万億0-9０-９]+[話章節].*)$").unwrap();
    let scene_break_re = Regex::new(
        r"(?m)^(={3,}|\*{3,}|-{3,}|・{3,}|…{3,}|\.{3,}|‥{3,}|\[\s*\]|◆|◇|■|□|※)\s*$",
    )
    .unwrap();

    let mut positions = std::collections::BTreeSet::new();
    positions.insert(0usize);

    for re in [&heading_re, &chapter_re, &scene_break_re] {
        for m in re.find_iter(text) {
            positions.insert(m.start());
        }
    }

    // Paragraph boundaries: empty line → non-empty, non-scene-break line.
    let mut offset: usize = 0;
    let lines: Vec<&str> = text.split('\n').collect();
    for i in 0..lines.len().saturating_sub(1) {
        let line = lines[i];
        let next_line = lines[i + 1];
        if line.trim().is_empty()
            && !next_line.trim().is_empty()
            && !scene_break_re.is_match(next_line)
        {
            let candidate = offset + line.len() + 1; // +1 for '\n'
            if candidate < text.len() {
                positions.insert(candidate);
            }
        }
        offset += line.len() + 1;
    }

    positions.insert(text.len());
    positions.into_iter().collect()
}

/// Split `text` into chunks of at most `max_chars` bytes, breaking at paragraph
/// boundaries (`\n\n` or more).
fn split_by_paragraphs(text: &str, max_chars: usize) -> Vec<String> {
    let para_re = Regex::new(r"\n{2,}").unwrap();
    let paragraphs: Vec<&str> = para_re
        .split(text)
        .filter(|p| !p.trim().is_empty())
        .collect();

    let mut chunks: Vec<String> = Vec::new();
    let mut current = String::new();

    for paragraph in &paragraphs {
        if paragraph.len() > max_chars {
            if !current.is_empty() {
                chunks.push(current.trim().to_owned());
                current.clear();
            }
            chunks.extend(split_long_paragraph(paragraph, max_chars));
            continue;
        }

        if current.len() + paragraph.len() + 2 > max_chars && !current.is_empty() {
            chunks.push(current.trim().to_owned());
            current = (*paragraph).to_owned();
        } else if current.is_empty() {
            current = (*paragraph).to_owned();
        } else {
            current.push_str("\n\n");
            current.push_str(paragraph);
        }
    }

    if !current.is_empty() {
        chunks.push(current.trim().to_owned());
    }

    if chunks.is_empty() {
        vec![text.to_owned()]
    } else {
        chunks
    }
}

/// Split a single long paragraph by sentence boundaries, falling back to
/// hard byte-boundary splits for sentences that still exceed `max_chars`.
fn split_long_paragraph(paragraph: &str, max_chars: usize) -> Vec<String> {
    let sentence_re = Regex::new(r"[^。！？.!?\n]+[。！？.!?]?").unwrap();
    let sentences: Vec<&str> = sentence_re
        .find_iter(paragraph)
        .map(|m| m.as_str())
        .collect();
    let sentences: Vec<&str> = if sentences.is_empty() {
        vec![paragraph]
    } else {
        sentences
    };

    let mut chunks: Vec<String> = Vec::new();
    let mut current = String::new();

    for sentence in &sentences {
        if sentence.len() > max_chars {
            if !current.is_empty() {
                chunks.push(current.trim().to_owned());
                current.clear();
            }
            // Hard-split at char boundaries.
            let mut start = 0;
            while start < sentence.len() {
                let mut end = (start + max_chars).min(sentence.len());
                while end > start && !sentence.is_char_boundary(end) {
                    end -= 1;
                }
                chunks.push(sentence[start..end].to_owned());
                start = end;
            }
            continue;
        }

        if current.len() + sentence.len() > max_chars && !current.is_empty() {
            chunks.push(current.trim().to_owned());
            current = (*sentence).to_owned();
        } else {
            current.push_str(sentence);
        }
    }

    if !current.is_empty() {
        chunks.push(current.trim().to_owned());
    }

    if chunks.is_empty() {
        vec![paragraph.to_owned()]
    } else {
        chunks
    }
}

/// Merge segments whose byte-length is below `min_chars` into adjacent segments.
fn merge_small_segments(segments: Vec<SourceSegment>, min_chars: usize) -> Vec<SourceSegment> {
    if segments.len() <= 1 {
        return segments;
    }

    let mut merged: Vec<SourceSegment> = Vec::new();
    let mut pending: Option<SourceSegment> = None;

    for segment in segments {
        let length = segment.end_offset.saturating_sub(segment.start_offset);

        if length < min_chars && pending.is_none() {
            pending = Some(segment);
            continue;
        }

        if let Some(mut p) = pending.take() {
            p.end_offset = segment.end_offset;
            if p.heading.is_empty() {
                p.heading = segment.heading.clone();
            }
            p.segmentation_method = "paragraph_group".into();
            if p.end_offset.saturating_sub(p.start_offset) >= min_chars {
                merged.push(p);
            } else {
                pending = Some(p);
            }
        } else {
            merged.push(segment);
        }
    }

    // Flush any remaining pending segment into the last merged one.
    if let Some(p) = pending {
        if let Some(last) = merged.last_mut() {
            last.end_offset = p.end_offset;
            if last.heading.is_empty() {
                last.heading = p.heading;
            }
        } else {
            merged.push(p);
        }
    }

    merged
}

/// Extract a heading string from the first line of a segment's content.
fn extract_heading(content: &str) -> String {
    let re =
        Regex::new(r"(?m)^(?:#{1,6}\s+|第[一二三四五六七八九十百千万億0-9０-９]+[話章節]\s*)?(.+)$")
            .unwrap();
    re.captures(content)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().chars().take(80).collect::<String>())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Segment `text` into structured [`SourceSegment`]s.
///
/// This is a faithful port of the legacy TypeScript `segmentSourceText`:
///
/// 1. Normalise line endings.
/// 2. Find structural split positions (headings, chapters, scene breaks,
///    paragraph boundaries).
/// 3. Build raw segments and compute SHA-256 content hashes.
/// 4. Split any segment exceeding `max_chars` by paragraphs / sentences.
/// 5. Merge segments smaller than `min_chars`.
/// 6. Re-number ordinals.
pub async fn segment_source_text(
    source_id: &str,
    text: &str,
    options: SegmentationOptions,
) -> Result<Vec<SourceSegment>, JsValue> {
    let normalized = normalize_line_endings(text);
    let max_chars = options.max_chars;
    let min_chars = options.min_chars;

    if normalized.is_empty() {
        return Ok(Vec::new());
    }

    // --- Step 1: raw segments from structural split positions ---------------
    let split_positions = find_split_positions(&normalized);
    let mut raw_segments: Vec<SourceSegment> = Vec::new();

    for pair in split_positions.windows(2) {
        let (start, end) = (pair[0], pair[1]);
        let content = normalized[start..end].trim();
        if content.is_empty() {
            continue;
        }

        let heading = extract_heading(content);
        let content_hash = compute_text_hash(content).await?;

        raw_segments.push(SourceSegment {
            id: tauri::random_uuid(),
            source_id: source_id.to_owned(),
            ordinal: raw_segments.len(),
            heading,
            start_offset: start,
            end_offset: start + content.len(),
            content_hash,
            segmentation_method: "heading".into(),
        });
    }

    // --- Step 2: split oversized segments by paragraphs ---------------------
    let mut split_segments: Vec<SourceSegment> = Vec::new();

    for segment in &raw_segments {
        let content = &normalized[segment.start_offset..segment.end_offset];
        if content.len() <= max_chars {
            split_segments.push(segment.clone());
            continue;
        }

        let chunks = split_by_paragraphs(content, max_chars);
        let mut offset = segment.start_offset;

        for chunk in &chunks {
            let content_hash = compute_text_hash(chunk).await?;
            split_segments.push(SourceSegment {
                id: tauri::random_uuid(),
                source_id: source_id.to_owned(),
                ordinal: split_segments.len(),
                heading: segment.heading.clone(),
                start_offset: offset,
                end_offset: offset + chunk.len(),
                content_hash,
                segmentation_method: "paragraph_group".into(),
            });
            offset += chunk.len();
            // Skip inter-chunk whitespace.
            while offset < normalized.len() {
                let c = normalized[offset..].chars().next().unwrap();
                if !c.is_whitespace() {
                    break;
                }
                offset += c.len_utf8();
            }
        }
    }

    // --- Step 3: merge small segments & re-number ---------------------------
    let merged = merge_small_segments(split_segments, min_chars);

    Ok(merged
        .into_iter()
        .enumerate()
        .map(|(index, mut seg)| {
            seg.ordinal = index;
            seg
        })
        .collect())
}

/// Extract a segment's content from the full source text.
#[allow(dead_code)]
pub fn extract_segment_content(source_text: &str, segment: &SourceSegment) -> String {
    let normalized = normalize_line_endings(source_text);
    normalized[segment.start_offset..segment.end_offset].to_owned()
}
