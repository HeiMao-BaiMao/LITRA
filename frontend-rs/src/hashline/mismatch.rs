//! セクションのスナップショットタグがライブファイル内容と一致せず、recovery も
//! 利用不可/失敗したときに発生するエラー型。oh-my-pi `mismatch.ts` の移植。
//!
//! 有用な診断を描画するのに十分な文脈（アンカー行 + その前後数行）を保持する。
//! [`MismatchError::display_message`] がこれをメッセージへ整形する。

use std::collections::HashSet;
use std::fmt;

use crate::hashline::format::{format_numbered_line, HL_FILE_HASH_SEP, HL_FILE_PREFIX, HL_FILE_SUFFIX};
use crate::hashline::messages::MISMATCH_CONTEXT;

/// hashline セクションのスナップショットタグがライブファイル内容と一致しない
/// （かつ recovery が拒否した）ときに発生するエラー。ファイル行とアンカー行を保持し、
/// レンダラが [`MismatchError::display_message`] でより豊かな診断を生成できるようにする。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MismatchError {
    pub path: Option<String>,
    pub expected_file_hash: String,
    pub actual_file_hash: String,
    pub file_lines: Vec<String>,
    pub anchor_lines: Vec<u32>,
    /// 期待ハッシュが記録済みスナップショットに解決したとき `true`（そのスナップショット
    /// 以降にファイルがドリフトした）、そのハッシュのスナップショットが一度も記録され
    /// なかったとき `false`（捏造または前セッションからの持ち越しの可能性）。既定は `true`。
    pub hash_recognized: bool,
}

impl MismatchError {
    pub fn new(
        path: Option<String>,
        expected_file_hash: String,
        actual_file_hash: String,
        file_lines: Vec<String>,
        anchor_lines: Vec<u32>,
        hash_recognized: bool,
    ) -> Self {
        Self {
            path,
            expected_file_hash,
            actual_file_hash,
            file_lines,
            anchor_lines,
            hash_recognized,
        }
    }

    /// 拒否ヘッダ行（2行）。TS: `MismatchError.rejectionHeader`。
    fn rejection_header(&self) -> Vec<String> {
        let path_text = match &self.path {
            Some(path) => format!(" for {path}"),
            None => String::new(),
        };
        if !self.hash_recognized {
            vec![
                format!(
                    "Edit rejected{path_text}: hash {HL_FILE_HASH_SEP}{expected} is not from this session.",
                    expected = self.expected_file_hash
                ),
                format!(
                    "The current file hashes to {HL_FILE_HASH_SEP}{actual}. Re-read the file with `read` to copy a current {HL_FILE_PREFIX}path{HL_FILE_HASH_SEP}tag{HL_FILE_SUFFIX} header — never invent the tag and never reuse one from a prior session.",
                    actual = self.actual_file_hash
                ),
            ]
        } else {
            vec![
                format!("Edit rejected{path_text}: file changed between read and edit."),
                format!(
                    "Section is bound to {HL_FILE_HASH_SEP}{expected}, but the current file hashes to {HL_FILE_HASH_SEP}{actual}. If a prior edit in this session modified this file, copy the {HL_FILE_PREFIX}path{HL_FILE_HASH_SEP}newhash{HL_FILE_SUFFIX} header from that edit's response; otherwise re-read the file with `read` to refresh the tag before retrying.",
                    expected = self.expected_file_hash,
                    actual = self.actual_file_hash
                ),
            ]
        }
    }

    /// `anchor_lines` の前後 ±[`MISMATCH_CONTEXT`] の番号付き `LINE:TEXT` 行。
    /// アンカーを `*` で印付け、非隣接ランの間は `...`。範囲外アンカーは行を寄与しない。
    /// TS: `formatAnchoredContext`。
    fn format_anchored_context(&self) -> Vec<String> {
        let file_len = self.file_lines.len() as u32;
        let mut display_set: HashSet<u32> = HashSet::new();
        let mut display_lines: Vec<u32> = Vec::new();
        for &line in &self.anchor_lines {
            if line < 1 || line > file_len {
                continue;
            }
            let lo = 1u32.max(line.saturating_sub(MISMATCH_CONTEXT));
            let hi = file_len.min(line + MISMATCH_CONTEXT);
            for line_num in lo..=hi {
                if display_set.insert(line_num) {
                    display_lines.push(line_num);
                }
            }
        }
        display_lines.sort_unstable();
        let anchor_set: HashSet<u32> = self.anchor_lines.iter().copied().collect();
        let mut rows: Vec<String> = Vec::new();
        let mut previous: i64 = -1;
        for &line_num in &display_lines {
            if previous != -1 && i64::from(line_num) > previous + 1 {
                rows.push("...".to_string());
            }
            previous = i64::from(line_num);
            let marker = if anchor_set.contains(&line_num) { "*" } else { " " };
            let text = self
                .file_lines
                .get((line_num - 1) as usize)
                .map(String::as_str)
                .unwrap_or("");
            rows.push(format!("{marker}{}", format_numbered_line(line_num, text)));
        }
        rows
    }

    /// ユーザ向け診断メッセージ全体: 拒否ヘッダ + 空行 + アンカー上下文（あれば）。
    pub fn display_message(&self) -> String {
        let mut lines = self.rejection_header();
        let context = self.format_anchored_context();
        if context.is_empty() {
            return lines.join("\n");
        }
        lines.push(String::new());
        lines.extend(context);
        lines.join("\n")
    }
}

impl fmt::Display for MismatchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.display_message())
    }
}

/// 行リストをソート済みの `1-4, 7, 10-12` 形式範囲文字列へ圧縮する。
/// seen-line ガードの共有ユーティリティ。TS: `formatLineRanges`。
pub fn compress_ranges(lines: &[u32]) -> String {
    let mut sorted: Vec<u32> = lines.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    if sorted.is_empty() {
        return String::new();
    }
    let mut parts: Vec<String> = Vec::new();
    let mut start = sorted[0];
    let mut prev = sorted[0];
    for i in 1..=sorted.len() {
        if i < sorted.len() && sorted[i] == prev + 1 {
            prev = sorted[i];
            continue;
        }
        parts.push(if start == prev {
            format!("{start}")
        } else {
            format!("{start}-{prev}")
        });
        if i < sorted.len() {
            start = sorted[i];
            prev = sorted[i];
        }
    }
    parts.join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_message_recognized_with_context() {
        let err = MismatchError::new(
            Some("src/foo.ts".to_string()),
            "ABCD".to_string(),
            "1234".to_string(),
            vec!["l1".into(), "l2".into(), "l3".into(), "l4".into(), "l5".into()],
            vec![3],
            true,
        );
        let msg = err.display_message();
        assert!(msg.contains("Edit rejected for src/foo.ts: file changed between read and edit."));
        assert!(msg.contains("Section is bound to #ABCD, but the current file hashes to #1234."));
        // アンカー3の前後 ±2 → 行1..5、アンカー行3は `*` 印。
        assert!(msg.contains("*3:l3"));
        assert!(msg.contains(" 1:l1"));
        assert!(msg.contains(" 5:l5"));
    }

    #[test]
    fn display_message_unrecognized_no_path() {
        let err = MismatchError::new(
            None,
            "DEAD".to_string(),
            "BEEF".to_string(),
            vec!["only".into()],
            vec![],
            false,
        );
        let msg = err.display_message();
        assert!(msg.contains("Edit rejected: hash #DEAD is not from this session."));
        assert!(msg.contains("The current file hashes to #BEEF."));
        // アンカーも上下文もないのでヘッダのみ（空行なし）。
        assert!(!msg.contains("\n\n"));
    }

    #[test]
    fn display_message_non_adjacent_runs_insert_ellipsis() {
        let err = MismatchError::new(
            None,
            "AAAA".to_string(),
            "BBBB".to_string(),
            (1..=10).map(|i| format!("line{i}")).collect(),
            vec![2, 9],
            true,
        );
        let msg = err.display_message();
        // 行2の文脈(1-4)と行9の文脈(7-10)は非隣接 → 間に `...`。
        assert!(msg.contains("..."));
        assert!(msg.contains("*2:line2"));
        assert!(msg.contains("*9:line9"));
    }

    #[test]
    fn display_impl_matches_display_message() {
        let err = MismatchError::new(
            Some("p".to_string()),
            "X".to_string(),
            "Y".to_string(),
            vec!["a".into()],
            vec![1],
            true,
        );
        assert_eq!(format!("{err}"), err.display_message());
    }

    #[test]
    fn compress_ranges_format() {
        assert_eq!(compress_ranges(&[1, 2, 3, 4, 7, 10, 11, 12]), "1-4, 7, 10-12");
        assert_eq!(compress_ranges(&[]), "");
        assert_eq!(compress_ranges(&[5]), "5");
        assert_eq!(compress_ranges(&[3, 1, 2]), "1-3");
    }
}
