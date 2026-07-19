//! 日本語文・段落の決定論的計測ユーティリティ。
//! LLM 非依存。文体指紋・ドラフト機械検査の両方から利用される。
//!
//! TypeScript `text-stats.ts` の Rust 移植。
#![allow(dead_code)]

use std::collections::HashSet;

const OPEN_BRACKETS: &[char] = &['「', '『', '(', '（', '['];
const CLOSE_BRACKETS: &[char] = &['」', '』', ')', '）', ']'];

fn is_sentence_end(ch: char) -> bool {
    matches!(ch, '。' | '！' | '？' | '!' | '?')
}

/// 「。」等で文を分割する。括弧（「」『』()（）[]）内の句点では分割しない
/// （会話文の中の句点で文が途切れるのを防ぐ）。
pub fn split_japanese_sentences(text: &str) -> Vec<String> {
    let open: HashSet<char> = OPEN_BRACKETS.iter().copied().collect();
    let close: HashSet<char> = CLOSE_BRACKETS.iter().copied().collect();

    let mut sentences: Vec<String> = Vec::new();
    let mut depth: usize = 0;
    let mut start: usize = 0;
    let chars: Vec<char> = text.chars().collect();
    let len = chars.len();

    let mut i = 0;
    while i < len {
        let ch = chars[i];
        if open.contains(&ch) {
            depth += 1;
            i += 1;
            continue;
        }
        if close.contains(&ch) {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                // 括弧内の終端記号は、その括弧が閉じた時点で文境界になる。
                // 入れ子の閉じ括弧が続く場合は、その直前まで遡って確認する。
                let mut previous = i;
                while previous > 0 && close.contains(&chars[previous - 1]) {
                    previous -= 1;
                }
                if previous > 0 && is_sentence_end(chars[previous - 1]) {
                    let end = i + 1;
                    let sentence: String = chars[start..end].iter().collect();
                    sentences.push(sentence);
                    start = end;
                    i = end;
                    continue;
                }
            }
            i += 1;
            continue;
        }
        if is_sentence_end(ch) && depth == 0 {
            let mut end = i + 1;
            // 終端記号の直後に閉じ括弧が続く場合はそこまでを1文に含める（例:「そうか。」）
            while end < len && close.contains(&chars[end]) {
                end += 1;
            }
            let sentence: String = chars[start..end].iter().collect();
            sentences.push(sentence);
            start = end;
            i = end;
            continue;
        }
        i += 1;
    }
    if start < len {
        let rest: String = chars[start..].iter().collect();
        if !rest.trim().is_empty() {
            sentences.push(rest);
        }
    }

    sentences
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// 空行（2つ以上の改行）で段落に分割する。
pub fn split_paragraphs(text: &str) -> Vec<String> {
    text.split("\n\n")
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_on_japanese_period() {
        let text = "こんにちは。さようなら。";
        let sentences = split_japanese_sentences(text);
        assert_eq!(sentences, vec!["こんにちは。", "さようなら。"]);
    }

    #[test]
    fn preserves_bracketed_speech() {
        let text = "「そうか。」彼は言った。";
        let sentences = split_japanese_sentences(text);
        assert_eq!(sentences, vec!["「そうか。」", "彼は言った。"]);
    }

    #[test]
    fn does_not_split_inside_brackets() {
        let text = "「まさか。そんなはずは。」彼女は驚いた。";
        let sentences = split_japanese_sentences(text);
        assert_eq!(
            sentences,
            vec!["「まさか。そんなはずは。」", "彼女は驚いた。"]
        );
    }

    #[test]
    fn splits_after_nested_bracketed_speech() {
        let text = "「彼は『行く。』と言った。」私は頷いた。";
        let sentences = split_japanese_sentences(text);
        assert_eq!(
            sentences,
            vec!["「彼は『行く。』と言った。」", "私は頷いた。"]
        );
    }

    #[test]
    fn splits_paragraphs_on_double_newline() {
        let text = "第一段落。\n\n第二段落。\n\n第三段落。";
        let paragraphs = split_paragraphs(text);
        assert_eq!(paragraphs, vec!["第一段落。", "第二段落。", "第三段落。"]);
    }

    #[test]
    fn empty_input_returns_empty() {
        assert!(split_japanese_sentences("").is_empty());
        assert!(split_paragraphs("").is_empty());
    }
}
