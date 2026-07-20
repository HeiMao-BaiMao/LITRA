//! hashline 形式の基礎: 記号・区切り文字・ハッシュ・表示ヘルパ。
//! oh-my-pi `format.ts` の移植。パーサ・トークナイザ・プロンプト・文法の唯一の正典。

use crate::hashline::types::Cursor;
use xxhash_rust::xxh32::xxh32;

// ── 記号・キーワード ────────────────────────────────────────────────
/// ファイルセクションヘッダの区切り文字: `[path#hash]`。
pub const HL_FILE_PREFIX: &str = "[";
pub const HL_FILE_SUFFIX: &str = "]";
/// 本文行（リテラル）の記号。
pub const HL_PAYLOAD_REPLACE: &str = "+";
/// 具体的な行置換のハנקヘッダキーワード。
pub const HL_REPLACE_KEYWORD: &str = "SWAP";
/// 具体的な行削除のハנקヘッダキーワード。
pub const HL_DELETE_KEYWORD: &str = "DEL";
/// 挿入操作のハנקヘッダキーワード。
pub const HL_INSERT_KEYWORD: &str = "INS";
pub const HL_INSERT_BEFORE: &str = "PRE";
pub const HL_INSERT_AFTER: &str = "POST";
pub const HL_INSERT_HEAD: &str = "HEAD";
pub const HL_INSERT_TAIL: &str = "TAIL";
pub const HL_HEADER_COLON: &str = ":";
/// パスとスナップショットタグの区切り文字。
pub const HL_FILE_HASH_SEP: &str = "#";
/// 範囲の2つの行番号の区切り文字（例: `5.=10`）。
pub const HL_RANGE_SEP: &str = ".=";
/// 行番号と表示行内容の区切り文字。
pub const HL_LINE_BODY_SEP: &str = ":";
/// 内容ハッシュタグの16進文字数。
pub const HL_FILE_HASH_LENGTH: usize = 4;

// ── ハッシュ ────────────────────────────────────────────────────────
/// ハッシュ前に正規化: 各行末（および最終行末）の `[ \t\r]+` を除去する。
/// これにより CRLF/LF の違いや行末空白がタグを無効化しない。
/// TS: `text.replace(/[ \t\r]+(?=\n|$)/g, "")`（`$` は文字列終端のみ）。
fn normalize_file_hash_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let len = chars.len();
    let mut i = 0;
    while i < len {
        let ch = chars[i];
        if ch == ' ' || ch == '\t' || ch == '\r' {
            // `[ \t\r]+` の実行（ラン）の終わりを見つける
            let run_start = i;
            while i < len && (chars[i] == ' ' || chars[i] == '\t' || chars[i] == '\r') {
                i += 1;
            }
            // 直後が `\n` または文字列終端なら除去、そうでなければ保持
            let followed_by_lf_or_end = i >= len || chars[i] == '\n';
            if !followed_by_lf_or_end {
                for &c in &chars[run_start..i] {
                    out.push(c);
                }
            }
        } else {
            out.push(ch);
            i += 1;
        }
    }
    out
}

/// 内容由来のハッシュタグを計算する。
///
/// タグはファイル全体の正規化済みテキストの4桁16進フィンガープリント。
/// バイト同一の内容は何度読んでも同じタグになり、後続の編集はライブファイルが
/// まだそのハッシュを持つ限り任意の行で検証できる。
///
/// TS: `Bun.hash.xxHash32(normalized, 0) & 0xffff` → 4桁大文字16進。
pub fn compute_file_hash(text: &str) -> String {
    let normalized = normalize_file_hash_text(text);
    let low16 = xxh32(normalized.as_bytes(), 0) & 0xffff;
    format!("{:04X}", low16)
}

// ── フォーマッタ ────────────────────────────────────────────────────
/// 具体的な置換ハークヘッダ: `SWAP {start}.={end}:`。
pub fn format_replace_header(start: u32, end: u32) -> String {
    format!("{} {}{}{}{}", HL_REPLACE_KEYWORD, start, HL_RANGE_SEP, end, HL_HEADER_COLON)
}

/// 具体的な削除ハークヘッダ。start==end なら `DEL {start}`、否则 `DEL {start}.={end}`。
pub fn format_delete_header(start: u32, end: u32) -> String {
    if start == end {
        format!("{} {}", HL_DELETE_KEYWORD, start)
    } else {
        format!("{} {}{}{}", HL_DELETE_KEYWORD, start, HL_RANGE_SEP, end)
    }
}

/// カーソル位置に対する挿入ハークヘッダ。
pub fn format_insert_header(cursor: &Cursor) -> String {
    match cursor {
        Cursor::BeforeAnchor { anchor } => {
            format!("{}.{} {}{}", HL_INSERT_KEYWORD, HL_INSERT_BEFORE, anchor.line, HL_HEADER_COLON)
        }
        Cursor::AfterAnchor { anchor } => {
            format!("{}.{} {}{}", HL_INSERT_KEYWORD, HL_INSERT_AFTER, anchor.line, HL_HEADER_COLON)
        }
        Cursor::Bof => format!("{}.{}{}", HL_INSERT_KEYWORD, HL_INSERT_HEAD, HL_HEADER_COLON),
        Cursor::Eof => format!("{}.{}{}", HL_INSERT_KEYWORD, HL_INSERT_TAIL, HL_HEADER_COLON),
    }
}

/// ファイルパスとスナップショットタグのセクションヘッダ: `[{path}#{hash}]`。
pub fn format_hashline_header(file_path: &str, file_hash: &str) -> String {
    format!("{}{}{}{}{}", HL_FILE_PREFIX, file_path, HL_FILE_HASH_SEP, file_hash, HL_FILE_SUFFIX)
}

/// 1行を `LINE:TEXT` 形式にする。
pub fn format_numbered_line(line_number: u32, line: &str) -> String {
    format!("{}{}{}", line_number, HL_LINE_BODY_SEP, line)
}

/// ファイルテキストを行番号付き（hashline モード）で表示する。
pub fn format_numbered_lines(text: &str, start_line: u32) -> String {
    text.split('\n')
        .enumerate()
        .map(|(i, line)| format_numbered_line(start_line + i as u32, line))
        .collect::<Vec<_>>()
        .join("\n")
}

/// エラーメッセージ用のアンカー例リストを整形する: `"160", "42", "7"`。
/// `line_prefix` がある場合、2番目の例は prefix の末尾を `2` に置換して作る。
pub fn describe_anchor_examples(line_prefix: &str) -> String {
    let examples: Vec<String> = if !line_prefix.is_empty() {
        let second = if line_prefix.len() >= 1 {
            format!("{}2", &line_prefix[..line_prefix.len() - 1])
        } else {
            "42".to_string()
        };
        vec![line_prefix.to_string(), second, "7".to_string()]
    } else {
        vec!["160".to_string(), "42".to_string(), "7".to_string()]
    };
    examples
        .iter()
        .map(|e| format!("\"{}\"", e))
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_string_hash_matches_known_vector() {
        // xxh32(b"", 0) = 0x02CC5D05, & 0xFFFF = 0x5D05
        assert_eq!(compute_file_hash(""), "5D05");
    }

    #[test]
    fn hash_is_stable_across_crlf_and_trailing_whitespace() {
        let a = "line1\nline2\n";
        let b = "line1 \r\nline2\t\r\n";
        assert_eq!(compute_file_hash(a), compute_file_hash(b));
    }

    #[test]
    fn numbered_line_format() {
        assert_eq!(format_numbered_line(3, "hello"), "3:hello");
    }

    #[test]
    fn replace_header_format() {
        assert_eq!(format_replace_header(2, 4), "SWAP 2.=4:");
    }

    #[test]
    fn delete_header_single_and_range() {
        assert_eq!(format_delete_header(3, 3), "DEL 3");
        assert_eq!(format_delete_header(3, 5), "DEL 3.=5");
    }
}
