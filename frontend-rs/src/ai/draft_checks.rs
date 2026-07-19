//! 続き生成ドラフトの決定論的検問+サニタイザ。
//! LLM を使わない機械検査のみ。判定はすべてこのモジュール側のコードで完結させ、
//! 弱いモデルに「良い/悪い」の判断そのものをさせない。
//!
//! TypeScript `draft-checks.ts` の Rust 移植。
#![allow(dead_code)]

use regex::Regex;
use std::{collections::HashMap, sync::LazyLock};

use super::text_stats::split_japanese_sentences;
use super::DraftCheckFindings;

/// 20文字未満の反復は相槌的短文で誤検知しやすいため対象外
const MIN_REPEAT_SENTENCE_LENGTH: usize = 10;
/// 直前本文とドラフト先頭の一致がこの文字数以上なら「ほぼそのまま反復」とみなす
const MIN_CONTEXT_OVERLAP_LENGTH: usize = 18;
const CONTEXT_TAIL_SCAN_CHARS: usize = 200;
const DRAFT_HEAD_SCAN_CHARS: usize = 200;
const FIRST_PERSON_CONTEXT_TAIL_CHARS: usize = 1500;

static PREAMBLE_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?m)^\s*(以下(が|は)?[^\n]{0,20}(続き|本文)[^\n]{0,10}[:：]?|承知(いたし)?しました[。!]?|かしこまりました[。!]?|それでは(続きを)?(書き|お書き)?します[。!]?)\s*\n+",
    )
    .unwrap()
});
static LEADING_CODE_FENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^\s*```[^\n]*\n").unwrap());
static TRAILING_CODE_FENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\n```\s*$").unwrap());
static LEADING_HEADING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^\s*#{1,6}\s+[^\n]*\n+").unwrap());

/// 前置き・コードフェンス・見出しの混入を除去する（検出ではなく無条件の除去）。
/// 弱いモデルが「承知しました」等の応答的な前置きを本文に混ぜてしまう事故を潰す。
pub fn sanitize_draft_text(draft: &str) -> String {
    let mut text = draft.to_string();
    text = LEADING_CODE_FENCE.replace_all(&text, "").to_string();
    text = TRAILING_CODE_FENCE.replace_all(&text, "").to_string();
    text = PREAMBLE_LINE.replace_all(&text, "").to_string();
    text = LEADING_HEADING.replace_all(&text, "").to_string();
    text
}

fn longest_common_substring(a: &str, b: &str) -> String {
    if a.is_empty() || b.is_empty() {
        return String::new();
    }
    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();
    let mut prev_row: Vec<usize> = vec![0; b_chars.len() + 1];
    let mut max_len = 0;
    let mut end_in_a = 0;

    for i in 1..=a_chars.len() {
        let mut curr_row: Vec<usize> = vec![0; b_chars.len() + 1];
        for j in 1..=b_chars.len() {
            if a_chars[i - 1] == b_chars[j - 1] {
                curr_row[j] = prev_row[j - 1] + 1;
                if curr_row[j] > max_len {
                    max_len = curr_row[j];
                    end_in_a = i;
                }
            }
        }
        prev_row = curr_row;
    }

    a_chars[end_in_a - max_len..end_in_a]
        .iter()
        .collect()
}

fn count_occurrences(text: &str, needle: &str) -> usize {
    text.match_indices(needle).count()
}

const FIRST_PERSON_PRONOUNS: &[&str] = &[
    "私", "僕", "俺", "わたし", "あたし", "わし", "拙者", "うち", "小生",
];

fn dominant_first_person(text: &str) -> Option<&'static str> {
    let mut best: Option<&'static str> = None;
    let mut best_count = 0;
    for &pronoun in FIRST_PERSON_PRONOUNS {
        let count = count_occurrences(text, pronoun);
        if count > best_count {
            best = Some(pronoun);
            best_count = count;
        }
    }
    best
}

/// 直前本文で確立している一人称が、ドラフト中に一度も現れず、
/// 別の一人称に置き換わっている場合だけを違反とする（混在は視点交代等の可能性があるため許容）。
fn detect_first_person_drift(draft: &str, context: &str) -> Option<String> {
    let context_tail: String = context.chars().rev().take(FIRST_PERSON_CONTEXT_TAIL_CHARS).collect::<Vec<_>>().into_iter().rev().collect();
    let expected = dominant_first_person(&context_tail)?;
    if count_occurrences(draft, expected) > 0 {
        return None;
    }

    let draft_dominant = dominant_first_person(draft)?;
    if draft_dominant == expected {
        return None;
    }

    Some(format!(
        "直前本文の一人称は「{expected}」だが、続きでは一度も使われず「{draft_dominant}」に変わっている（一人称の変化）"
    ))
}

/// ドラフト（サニタイズ済み想定）を機械的に検問する。
/// ここでの判定はすべて文字列処理のみで完結し、LLM は一切使わない。
pub fn check_draft(draft: &str, context: &str) -> DraftCheckFindings {
    let mut hard: Vec<String> = Vec::new();
    let mut soft: Vec<String> = Vec::new();

    // コンテキスト末尾との重複チェック
    let context_tail: String = context.chars().rev().take(CONTEXT_TAIL_SCAN_CHARS).collect::<Vec<_>>().into_iter().rev().collect();
    let draft_head: String = draft.chars().take(DRAFT_HEAD_SCAN_CHARS).collect();
    let overlap = longest_common_substring(&context_tail, &draft_head);
    if overlap.chars().count() >= MIN_CONTEXT_OVERLAP_LENGTH {
        let preview: String = overlap.chars().take(40).collect();
        hard.push(format!(
            "直前本文の一文をほぼそのまま反復している（「{preview}」）"
        ));
    }

    // 文の重複チェック
    let mut sentence_counts: HashMap<String, usize> = HashMap::new();
    for sentence in split_japanese_sentences(draft) {
        if sentence.chars().count() < MIN_REPEAT_SENTENCE_LENGTH {
            continue;
        }
        *sentence_counts.entry(sentence).or_insert(0) += 1;
    }
    for (sentence, count) in sentence_counts {
        if count >= 2 {
            let preview: String = sentence.chars().take(40).collect();
            hard.push(format!(
                "ドラフト内で同一の文が{count}回繰り返されている（「{preview}」）"
            ));
        }
    }

    // 一人称変化チェック
    if let Some(drift) = detect_first_person_drift(draft, context) {
        soft.push(drift);
    }

    DraftCheckFindings { hard, soft }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_removes_preamble() {
        let draft = "承知しました。\n\n主人公は歩き出した。";
        let result = sanitize_draft_text(draft);
        assert_eq!(result.trim(), "主人公は歩き出した。");
    }

    #[test]
    fn sanitize_removes_code_fence() {
        let draft = "```\n主人公は歩き出した。\n```";
        let result = sanitize_draft_text(draft);
        assert_eq!(result.trim(), "主人公は歩き出した。");
    }

    #[test]
    fn sanitize_removes_heading() {
        let draft = "## 続き\n主人公は歩き出した。";
        let result = sanitize_draft_text(draft);
        assert_eq!(result.trim(), "主人公は歩き出した。");
    }

    #[test]
    fn detect_duplicate_sentences() {
        let draft =
            "主人公は歩き出した。主人公は歩き出した。彼は空を見上げた。";
        let findings = check_draft(draft, "");
        assert!(!findings.hard.is_empty());
        assert!(findings.hard[0].contains("繰り返"));
    }

    #[test]
    fn clean_draft_has_no_findings() {
        let draft =
            "主人公は静かに歩き出した。街はまだ眠っていた。彼は空を見上げ、深く息を吸った。";
        let findings = check_draft(draft, "前の本文です。");
        assert!(findings.hard.is_empty());
    }
}
