//! 構想メモから「主要ビート」の箇条書きを抽出する。
//! 自由文からの抽出のため頑健性を優先し、抽出に失敗した場合は空配列を返す
//! （呼び出し側は一括生成へフォールバックする）。
//!
//! TypeScript `plan-beats.ts` の Rust 移植。
#![allow(dead_code)]

use regex::Regex;
use std::sync::LazyLock;

static BEAT_HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"主要ビート").unwrap());

static NEXT_LABEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*(使う感覚描写|避けるべき|場面の目的|【)").unwrap()
});

static LIST_MARKER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*(?:[-・*]|\d+[.、)]|[①②③④⑤⑥⑦⑧⑨])\s*").unwrap()
});

/// ビート分割生成に使うには最低これだけの独立したビートが要る（1つなら分割の意味が無い）
const MIN_BEATS_FOR_SPLIT: usize = 2;

/// 構想メモの「主要ビート」箇条書きを抽出する。
/// 見出しが見つからない、または箇条書きが MIN_BEATS_FOR_SPLIT 未満の場合は空配列を返す
/// （呼び出し側はこれを「ビート分割不可」の合図として扱い、一括生成へフォールバックする）。
pub fn parse_plan_beats(plan: &str) -> Vec<String> {
    let lines: Vec<&str> = plan.lines().collect();

    let header_index = lines
        .iter()
        .position(|line| BEAT_HEADER.is_match(line));

    let Some(header_index) = header_index else {
        return vec![];
    };

    let mut beats: Vec<String> = Vec::new();
    for i in (header_index + 1)..lines.len() {
        let line = lines[i];
        if NEXT_LABEL.is_match(line) {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let without_marker = LIST_MARKER.replace(trimmed, "").trim().to_string();
        if without_marker.is_empty() {
            continue;
        }
        beats.push(without_marker);
    }

    if beats.len() >= MIN_BEATS_FOR_SPLIT {
        beats
    } else {
        vec![]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_numbered_beats() {
        let plan = "執筆計画\n\n主要ビート\n1. 主人公が目覚める\n2. 朝食をとる\n3. 学校へ向かう\n\n使う感覚描写: 視覚、聴覚";
        let beats = parse_plan_beats(plan);
        assert_eq!(
            beats,
            vec!["主人公が目覚める", "朝食をとる", "学校へ向かう"]
        );
    }

    #[test]
    fn parses_dash_beats() {
        let plan = "主要ビート\n- 戦いの開始\n- 仲間の到着\n- 決着";
        let beats = parse_plan_beats(plan);
        assert_eq!(beats, vec!["戦いの開始", "仲間の到着", "決着"]);
    }

    #[test]
    fn single_beat_returns_empty() {
        let plan = "主要ビート\n1. 主人公が目覚める";
        let beats = parse_plan_beats(plan);
        assert!(beats.is_empty());
    }

    #[test]
    fn no_header_returns_empty() {
        let plan = "これはただの計画です。特にビートはありません。";
        let beats = parse_plan_beats(plan);
        assert!(beats.is_empty());
    }

    #[test]
    fn stops_at_next_section() {
        let plan = "主要ビート\n1. A\n2. B\n避けるべきこと: 冗長な描写";
        let beats = parse_plan_beats(plan);
        assert_eq!(beats, vec!["A", "B"]);
    }
}
