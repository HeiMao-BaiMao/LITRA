//! 文体指紋の決定論的計測。LLM を使わず、統計値だけをコード側で算出する。
//!
//! TypeScript `style-fingerprint.ts` の Rust 移植。

#![allow(dead_code)]
use std::collections::HashMap;

use super::text_stats::{split_japanese_sentences, split_paragraphs};
use super::StyleFingerprint;

static KANJI: once_cell::sync::Lazy<regex::Regex> =
    once_cell::sync::Lazy::new(|| regex::Regex::new(r"[一-鿿々]").unwrap());

fn average(values: &[usize]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.iter().sum::<usize>() as f64 / values.len() as f64
}

/// 文の末尾表現を分類する。感嘆・疑問文（！？）は対象外。
/// です/ます/だ/た/る以外の「。」文は体言止め・その他としてまとめる（近似）。
fn classify_sentence_ending(sentence: &str) -> Option<String> {
    let core = sentence
        .trim_end_matches(['」', '』', ')', '）', ']']);
    if !core.ends_with('。') {
        return None;
    }
    let core = &core[..core.len() - '。'.len_utf8()];

    if core.ends_with("です") {
        Some("です。".to_string())
    } else if core.ends_with("ます") {
        Some("ます。".to_string())
    } else if core.ends_with('だ') {
        Some("だ。".to_string())
    } else if core.ends_with('た') {
        Some("た。".to_string())
    } else if core.ends_with('る') {
        Some("る。".to_string())
    } else {
        Some("体言止め・その他".to_string())
    }
}

/// 現エピソード全文などの生テキストから文体指紋を計測する。
pub fn measure_style_fingerprint(text: &str) -> StyleFingerprint {
    let sentences = split_japanese_sentences(text);
    let paragraphs = split_paragraphs(text);

    let kanji_count = KANJI.find_iter(text).count();
    let total_chars = text.chars().count();
    let kanji_ratio = if total_chars > 0 {
        kanji_count as f64 / total_chars as f64
    } else {
        0.0
    };

    let lines: Vec<&str> = text
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect();
    let dialogue_line_count = lines.iter().filter(|line| line.starts_with('「')).count();
    let dialogue_ratio = if !lines.is_empty() {
        dialogue_line_count as f64 / lines.len() as f64
    } else {
        0.0
    };

    let sentence_lengths: Vec<usize> = sentences.iter().map(|s| s.chars().count()).collect();
    let average_sentence_length = average(&sentence_lengths);

    let sentences_per_paragraph: Vec<usize> = paragraphs
        .iter()
        .map(|p| split_japanese_sentences(p).len())
        .collect();
    let average_sentences_per_paragraph = average(&sentences_per_paragraph);

    let mut ending_counts: HashMap<String, usize> = HashMap::new();
    let mut classified_total = 0usize;
    for sentence in &sentences {
        if let Some(form) = classify_sentence_ending(sentence) {
            *ending_counts.entry(form).or_insert(0) += 1;
            classified_total += 1;
        }
    }
    let mut sentence_endings: Vec<super::SentenceEndingEntry> = ending_counts
        .into_iter()
        .map(|(form, count)| super::SentenceEndingEntry {
            ratio: if classified_total > 0 {
                count as f64 / classified_total as f64
            } else {
                0.0
            },
            form,
        })
        .collect();
    sentence_endings.sort_by(|a, b| b.ratio.partial_cmp(&a.ratio).unwrap_or(std::cmp::Ordering::Equal));

    StyleFingerprint {
        average_sentence_length,
        kanji_ratio,
        dialogue_ratio,
        average_sentences_per_paragraph,
        sentence_endings,
    }
}

/// これ未満の文字数では統計が安定しないため、直前エピソードの本文で補う
const MIN_SAMPLE_CHARS: usize = 2000;

/// 現エピソードの本文が短い場合、直前エピソードの本文を先頭に補って計測材料を確保する。
pub fn compose_style_sample_text(
    current_episode_text: &str,
    previous_episode_text: Option<&str>,
) -> String {
    if current_episode_text.chars().count() >= MIN_SAMPLE_CHARS || previous_episode_text.is_none() {
        return current_episode_text.to_string();
    }
    format!(
        "{}\n\n{}",
        previous_episode_text.unwrap(),
        current_episode_text
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measures_basic_fingerprint() {
        let text = "私は歩いた。彼は走った。彼女は跳んだ。\n\n「待って。」私は言った。「どこへ行くの。」\n\n夕暮れが迫っていた。";
        let fp = measure_style_fingerprint(text);
        assert!(fp.average_sentence_length > 0.0);
        assert!(fp.kanji_ratio > 0.0);
        assert!(fp.dialogue_ratio > 0.0);
        assert!(!fp.sentence_endings.is_empty());
    }

    #[test]
    fn short_text_gets_padded() {
        let short = "短い。";
        let prev = "aaaa".repeat(500); // 2000 chars
        let result = compose_style_sample_text(short, Some(&prev));
        assert!(result.contains(&prev));
        assert!(result.contains(short));
    }

    #[test]
    fn long_text_not_padded() {
        let long = "長い。".repeat(700); // > 2000 chars
        let result = compose_style_sample_text(&long, Some("前のエピソード"));
        assert_eq!(result, long);
    }
}
