//! 行指向のハッシュライン・トークナイザ。oh-my-pi `tokenizer.ts` の移植。
//!
//! パッチテキストを行に分割し、各行を [`Token`] に分類する。ツリー座標の
//! ブロック操作（`SWAP.BLK` / `DEL.BLK` / `INS.BLK.POST`）とファイル級操作
//! （`REM` / `MV`）は小説編集では使わないため省略している。
//!
//! 形式の概形:
//! ```text
//! [path/to/file.ts#1A2B]
//! SWAP 5.=7:
//! +literal new line
//! ```

use crate::hashline::format::{
    HL_DELETE_KEYWORD, HL_FILE_HASH_LENGTH, HL_FILE_PREFIX, HL_FILE_SUFFIX, HL_INSERT_AFTER,
    HL_INSERT_BEFORE, HL_INSERT_HEAD, HL_INSERT_KEYWORD, HL_INSERT_TAIL, HL_PAYLOAD_REPLACE,
    HL_REPLACE_KEYWORD,
};
use crate::hashline::messages::{ABORT_MARKER, BEGIN_PATCH_MARKER, END_PATCH_MARKER};
use crate::hashline::types::{Anchor, ParsedRange};

const CHAR_HASH: char = '#';
const CHAR_DOT: char = '.';
const CHAR_COMMA: char = ',';
const CHAR_HYPHEN: char = '-';
const CHAR_ELLIPSIS: char = '…';
const CHAR_EQUALS: char = '=';
const CHAR_COLON: char = ':';

fn is_digit_code(c: char) -> bool {
    c.is_ascii_digit()
}

fn is_non_zero_digit_code(c: char) -> bool {
    matches!(c, '1'..='9')
}

fn is_hex_digit_code(c: char) -> bool {
    c.is_ascii_digit() || matches!(c, 'A'..='F') || matches!(c, 'a'..='f')
}

/// TS `isWhitespaceCode`: 空白 (32) または TAB(9)..=CR(13)。
fn is_whitespace_code(c: char) -> bool {
    c == ' ' || matches!(c as u32, 9..=13)
}

fn skip_whitespace(chars: &[char], mut index: usize, end: usize) -> usize {
    while index < end && is_whitespace_code(chars[index]) {
        index += 1;
    }
    index
}

fn trim_end_index(chars: &[char]) -> usize {
    let mut end = chars.len();
    while end > 0 && is_whitespace_code(chars[end - 1]) {
        end -= 1;
    }
    end
}

/// `line[index..]` が `needle` で始まるか。
fn starts_with_at(chars: &[char], index: usize, needle: &str) -> bool {
    let mut i = index;
    for nc in needle.chars() {
        if i >= chars.len() || chars[i] != nc {
            return false;
        }
        i += 1;
    }
    true
}

/// 行末の空白（CR を含む）を1つだけ剥がした行リストを返す。
///
/// - 空文字 → `[""]`
/// - `'\n'` で分割。各セグメント末尾の単一の `'\r'` を除去。
/// - 最後の `'\n'` の後の空セグメントは生成しない（`"a\n"` → `["a"]`）。
pub fn split_hashline_lines(text: &str) -> Vec<String> {
    if text.is_empty() {
        return vec![String::new()];
    }
    let bytes = text.as_bytes();
    let len = bytes.len();
    let mut lines: Vec<String> = Vec::new();
    let mut start = 0usize;
    let mut index = 0usize;
    while index < len {
        if bytes[index] != b'\n' {
            index += 1;
            continue;
        }
        let mut end = index;
        if end > start && bytes[end - 1] == b'\r' {
            end -= 1;
        }
        lines.push(text[start..end].to_string());
        start = index + 1;
        index += 1;
    }
    if start < len {
        let mut end = len;
        if end > start && bytes[end - 1] == b'\r' {
            end -= 1;
        }
        lines.push(text[start..end].to_string());
    }
    lines
}

/// 行番号スキャンの結果。
struct NumberScan {
    line: u32,
    next_index: usize,
}

/// 裸の行番号をスキャン。先頭は非ゼロ数字、後続は数字列。
fn scan_line_number(chars: &[char], index: usize, end: usize) -> Option<NumberScan> {
    if index >= end || !is_non_zero_digit_code(chars[index]) {
        return None;
    }
    let mut line_number: u32 = 0;
    let mut next_index = index;
    while next_index < end {
        let c = chars[next_index];
        if !is_digit_code(c) {
            break;
        }
        line_number = line_number * 10 + (c as u32 - '0' as u32);
        next_index += 1;
    }
    Some(NumberScan {
        line: line_number,
        next_index,
    })
}

/// 範囲の区切り（`..` `.=` `-` `…` `,` 空白）を1つ以上消費し、直後が非ゼロ数字なら
/// その位置を返す。
fn scan_range_separator(chars: &[char], index: usize, end: usize) -> Option<usize> {
    let mut cursor = index;
    let mut consumed_separator = false;
    while cursor < end {
        let c = chars[cursor];
        if is_whitespace_code(c) {
            cursor += 1;
            consumed_separator = true;
            continue;
        }
        if c == CHAR_COMMA || c == CHAR_HYPHEN || c == CHAR_ELLIPSIS {
            cursor += 1;
            consumed_separator = true;
            continue;
        }
        if c == CHAR_DOT
            && cursor + 1 < end
            && (chars[cursor + 1] == CHAR_DOT || chars[cursor + 1] == CHAR_EQUALS)
        {
            cursor += 2;
            consumed_separator = true;
            continue;
        }
        break;
    }
    if !consumed_separator {
        return None;
    }
    if cursor >= end || !is_non_zero_digit_code(chars[cursor]) {
        return None;
    }
    Some(cursor)
}

struct RangeScan {
    range: ParsedRange,
    next_index: usize,
}

/// ヘッダ内の行範囲をスキャン。`allow_single` なら単独行番号も許可する。
fn scan_header_range(
    chars: &[char],
    index: usize,
    end: usize,
    allow_single: bool,
) -> Option<RangeScan> {
    let number_start = skip_whitespace(chars, index, end);
    let start = scan_line_number(chars, number_start, end)?;
    match scan_range_separator(chars, start.next_index, end) {
        None => {
            if !allow_single {
                return None;
            }
            Some(RangeScan {
                range: ParsedRange {
                    start: Anchor::new(start.line),
                    end: Anchor::new(start.line),
                },
                next_index: skip_whitespace(chars, start.next_index, end),
            })
        }
        Some(after_first) => {
            let end_number = scan_line_number(chars, after_first, end)?;
            Some(RangeScan {
                range: ParsedRange {
                    start: Anchor::new(start.line),
                    end: Anchor::new(end_number.line),
                },
                next_index: skip_whitespace(chars, end_number.next_index, end),
            })
        }
    }
}

/// キーワードをスキャン。キーワード直後の文字は空白/`:`/`.`/終端のいずれかである必要が
/// ある（`SWAP` が `SWAP.BLK` の前置として誤マッチしないためのガード）。
fn scan_keyword(chars: &[char], index: usize, end: usize, keyword: &str) -> Option<usize> {
    if !starts_with_at(chars, index, keyword) {
        return None;
    }
    let next = index + keyword.chars().count();
    if next < end {
        let c = chars[next];
        if !is_whitespace_code(c) && c != CHAR_COLON && c != CHAR_DOT {
            return None;
        }
    }
    Some(next)
}

/// 行番号/範囲と末尾 `:` の間に紛れ込んだ孤立 `.` を読み飛ばす
/// （例: `SWAP 2.=3.:`、`INS.POST 2.:`）。`.` の後に空白を挟んで `:` または終端が
/// 来る場合のみ消費する。
fn skip_stray_dot(chars: &[char], index: usize, end: usize) -> usize {
    if index < end && chars[index] == CHAR_DOT {
        let after = skip_whitespace(chars, index + 1, end);
        if after == end || chars[after] == CHAR_COLON {
            return after;
        }
    }
    index
}

/// 任意の末尾 `:` を消費（直前の孤立 `.` も許容）。
fn consume_optional_colon(chars: &[char], index: usize, end: usize) -> usize {
    let mut cursor = skip_whitespace(chars, index, end);
    cursor = skip_stray_dot(chars, cursor, end);
    if cursor < end && chars[cursor] == CHAR_COLON {
        skip_whitespace(chars, cursor + 1, end)
    } else {
        cursor
    }
}

/// SWAP 用の末尾 `:` 消費。`consume_optional_colon` に加え、`=:` の後置
/// （`SWAP 2.=3=:` のようなローカルモデルの誤順列）も許容する。
fn consume_replace_colon(chars: &[char], index: usize, end: usize) -> usize {
    let canonical = consume_optional_colon(chars, index, end);
    if canonical >= end || chars[canonical] != CHAR_EQUALS {
        return canonical;
    }
    let after_equals = skip_whitespace(chars, canonical + 1, end);
    if after_equals >= end || chars[after_equals] != CHAR_COLON {
        return canonical;
    }
    skip_whitespace(chars, after_equals + 1, end)
}

struct TargetScan {
    target: BlockTarget,
    next_index: usize,
}

/// `INS.` の後ろの挿入対象（PRE/POST/HEAD/TAIL）をスキャン。
fn scan_insert_target(chars: &[char], index: usize, end: usize) -> Option<TargetScan> {
    if index >= end || chars[index] != CHAR_DOT {
        return None;
    }
    let cursor = skip_whitespace(chars, index + 1, end);

    if let Some(before_end) = scan_keyword(chars, cursor, end, HL_INSERT_BEFORE) {
        let anchor = scan_line_number(chars, skip_whitespace(chars, before_end, end), end)?;
        let next_index = consume_optional_colon(chars, anchor.next_index, end);
        return Some(TargetScan {
            target: BlockTarget::InsertBefore {
                anchor: Anchor::new(anchor.line),
            },
            next_index,
        });
    }
    if let Some(after_end) = scan_keyword(chars, cursor, end, HL_INSERT_AFTER) {
        let anchor = scan_line_number(chars, skip_whitespace(chars, after_end, end), end)?;
        let next_index = consume_optional_colon(chars, anchor.next_index, end);
        return Some(TargetScan {
            target: BlockTarget::InsertAfter {
                anchor: Anchor::new(anchor.line),
            },
            next_index,
        });
    }
    if let Some(head_end) = scan_keyword(chars, cursor, end, HL_INSERT_HEAD) {
        return Some(TargetScan {
            target: BlockTarget::Bof,
            next_index: consume_optional_colon(chars, head_end, end),
        });
    }
    if let Some(tail_end) = scan_keyword(chars, cursor, end, HL_INSERT_TAIL) {
        return Some(TargetScan {
            target: BlockTarget::Eof,
            next_index: consume_optional_colon(chars, tail_end, end),
        });
    }
    None
}

/// ハンクヘッダの動詞と対象をスキャン（ブロック操作・ファイル操作は省略）。
fn scan_hunk_anchor(chars: &[char], start: usize, end: usize) -> Option<TargetScan> {
    let cursor = skip_whitespace(chars, start, end);

    // `SWAP N.=M:` — 具体行の置換。
    if let Some(replace_end) = scan_keyword(chars, cursor, end, HL_REPLACE_KEYWORD) {
        let range = scan_header_range(chars, replace_end, end, true)?;
        return Some(TargetScan {
            target: BlockTarget::Replace { range: range.range },
            next_index: consume_replace_colon(chars, range.next_index, end),
        });
    }
    // `DEL N.=M` — 本文も末尾コロンも取らない。コロンは汚染検出に落とす。
    if let Some(delete_end) = scan_keyword(chars, cursor, end, HL_DELETE_KEYWORD) {
        let range = scan_header_range(chars, delete_end, end, true)?;
        let next = skip_stray_dot(chars, range.next_index, end);
        if next < end && chars[next] == CHAR_COLON {
            return None;
        }
        return Some(TargetScan {
            target: BlockTarget::Delete { range: range.range },
            next_index: next,
        });
    }
    // `INS.PRE|POST|HEAD|TAIL`。
    if let Some(insert_end) = scan_keyword(chars, cursor, end, HL_INSERT_KEYWORD) {
        return scan_insert_target(chars, insert_end, end);
    }
    None
}

/// 行が有効なハンクヘッダならその [`BlockTarget`] を返す。
fn try_parse_hunk_header(line: &str) -> Option<BlockTarget> {
    let chars: Vec<char> = line.chars().collect();
    let end = trim_end_index(&chars);
    let start = skip_whitespace(&chars, 0, end);
    if start >= end {
        return None;
    }
    let scan = scan_hunk_anchor(&chars, start, end)?;
    if scan.next_index != end {
        return None;
    }
    Some(scan.target)
}

/// 解析済みのファイルヘッダ。
struct ParsedHeader {
    path: String,
    file_hash: Option<String>,
}

/// `[path#HASH]` ヘッダを解析する。`#HASH` は4桁16進の任意タグ。
/// パス部分に `#` が残る（短すぎる/非16進/長すぎるタグ等）場合は None。
fn try_parse_header(line: &str) -> Option<ParsedHeader> {
    if !line.starts_with(HL_FILE_PREFIX) {
        return None;
    }
    let chars: Vec<char> = line.chars().collect();
    let end = trim_end_index(&chars);
    let prefix_len = HL_FILE_PREFIX.chars().count();
    let suffix_chars: Vec<char> = HL_FILE_SUFFIX.chars().collect();
    let suffix_len = suffix_chars.len();
    if prefix_len + suffix_len >= end {
        return None;
    }
    if end < suffix_len || chars[end - suffix_len..end] != suffix_chars[..] {
        return None;
    }
    let body_end = end - suffix_len;
    if prefix_len >= body_end {
        return None;
    }

    // スナップショットタグは括弧ヘッダ末尾の `#XXXX` ブロック。パスに空白が
    // 含まれ得るため、末尾（サフィックス側）から検出する。
    let mut path_end = body_end;
    let mut file_hash: Option<String> = None;
    let trailing_hash_start = body_end as isize - HL_FILE_HASH_LENGTH as isize - 1;
    if trailing_hash_start >= prefix_len as isize && chars[trailing_hash_start as usize] == CHAR_HASH {
        let ths = trailing_hash_start as usize;
        let mut all_hex = true;
        for probe in (ths + 1)..body_end {
            if !is_hex_digit_code(chars[probe]) {
                all_hex = false;
                break;
            }
        }
        if all_hex {
            path_end = ths;
            let hash_str: String = chars[ths + 1..body_end].iter().collect();
            file_hash = Some(hash_str.to_uppercase());
        }
    }

    // パス本体に `#` が残っていればヘッダは不正。
    for i in prefix_len..path_end {
        if chars[i] == CHAR_HASH {
            return None;
        }
    }

    if path_end == prefix_len {
        return None;
    }
    let path: String = chars[prefix_len..path_end].iter().collect();
    Some(ParsedHeader { path, file_hash })
}

/// ハンク操作の対象。ブロック操作・ファイル級操作は省略済み。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BlockTarget {
    Replace { range: ParsedRange },
    Delete { range: ParsedRange },
    InsertBefore { anchor: Anchor },
    InsertAfter { anchor: Anchor },
    Bof,
    Eof,
}

/// 行トークン。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Token {
    Blank {
        line_num: u32,
    },
    EnvelopeBegin {
        line_num: u32,
    },
    EnvelopeEnd {
        line_num: u32,
    },
    Abort {
        line_num: u32,
    },
    Header {
        line_num: u32,
        path: String,
        file_hash: Option<String>,
    },
    OpBlock {
        line_num: u32,
        target: BlockTarget,
    },
    PayloadLiteral {
        line_num: u32,
        text: String,
    },
    Raw {
        line_num: u32,
        text: String,
    },
}

/// 行末空白を剥がした上でマーカーと完全一致するか。
fn marker_line_equals(line: &str, marker: &str) -> bool {
    let chars: Vec<char> = line.chars().collect();
    let end = trim_end_index(&chars);
    end == marker.chars().count() && starts_with_at(&chars, 0, marker)
}

/// 1行を [`Token`] に分類する。`line_num` は1-indexed。
fn classify_line(line: &str, line_num: u32) -> Token {
    if line.is_empty() {
        return Token::Blank { line_num };
    }
    if marker_line_equals(line, BEGIN_PATCH_MARKER) {
        return Token::EnvelopeBegin { line_num };
    }
    if marker_line_equals(line, END_PATCH_MARKER) {
        return Token::EnvelopeEnd { line_num };
    }
    if marker_line_equals(line, ABORT_MARKER) {
        return Token::Abort { line_num };
    }
    if line.starts_with(HL_FILE_PREFIX) {
        if let Some(header) = try_parse_header(line) {
            return Token::Header {
                line_num,
                path: header.path,
                file_hash: header.file_hash,
            };
        }
    }
    let chars: Vec<char> = line.chars().collect();
    let lead = skip_whitespace(&chars, 0, chars.len());
    let is_hunk_lead = starts_with_at(&chars, lead, HL_REPLACE_KEYWORD)
        || starts_with_at(&chars, lead, HL_DELETE_KEYWORD)
        || starts_with_at(&chars, lead, HL_INSERT_KEYWORD);
    if is_hunk_lead {
        if let Some(target) = try_parse_hunk_header(line) {
            return Token::OpBlock { line_num, target };
        }
    }
    if starts_with_at(&chars, 0, HL_PAYLOAD_REPLACE) {
        let text: String = chars[1..].iter().collect();
        return Token::PayloadLiteral { line_num, text };
    }
    Token::Raw {
        line_num,
        text: line.to_string(),
    }
}

/// テキスト全体をトークン列に分解する（行番号は1から）。
pub fn tokenize_all(text: &str) -> Vec<Token> {
    let lines = split_hashline_lines(text);
    let mut tokens = Vec::with_capacity(lines.len());
    for (i, line) in lines.iter().enumerate() {
        tokens.push(classify_line(line, (i + 1) as u32));
    }
    tokens
}

/// 行が有効なハンクヘッダ（操作行）かどうか。
#[allow(dead_code)]
pub fn is_op(line: &str) -> bool {
    try_parse_hunk_header(line).is_some()
}

/// 行が有効なファイルヘッダかどうか。
#[allow(dead_code)]
pub fn is_header(line: &str) -> bool {
    try_parse_header(line).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_lines_handles_crlf_and_trailing_newline() {
        assert_eq!(split_hashline_lines(""), vec!["".to_string()]);
        assert_eq!(
            split_hashline_lines("a\nb"),
            vec!["a".to_string(), "b".to_string()]
        );
        assert_eq!(split_hashline_lines("a\n"), vec!["a".to_string()]);
        assert_eq!(
            split_hashline_lines("a\r\nb\r\n"),
            vec!["a".to_string(), "b".to_string()]
        );
    }

    #[test]
    fn classify_header_with_hash() {
        let token = classify_line("[foo/bar.ts#1a2b]", 1);
        assert_eq!(
            token,
            Token::Header {
                line_num: 1,
                path: "foo/bar.ts".to_string(),
                file_hash: Some("1A2B".to_string()),
            }
        );
    }

    #[test]
    fn classify_header_without_hash() {
        let token = classify_line("[foo/bar.ts]", 1);
        assert_eq!(
            token,
            Token::Header {
                line_num: 1,
                path: "foo/bar.ts".to_string(),
                file_hash: None,
            }
        );
    }

    #[test]
    fn classify_rejects_malformed_tag() {
        // 3桁タグは不正 → ヘッダにならず Raw へ。
        assert!(matches!(
            classify_line("[foo#1A2]", 1),
            Token::Raw { .. }
        ));
    }

    #[test]
    fn classify_swap_header() {
        let token = classify_line("SWAP 2.=4:", 3);
        assert_eq!(
            token,
            Token::OpBlock {
                line_num: 3,
                target: BlockTarget::Replace {
                    range: ParsedRange {
                        start: Anchor::new(2),
                        end: Anchor::new(4),
                    },
                },
            }
        );
    }

    #[test]
    fn classify_del_single_and_range() {
        assert_eq!(
            classify_line("DEL 5", 1),
            Token::OpBlock {
                line_num: 1,
                target: BlockTarget::Delete {
                    range: ParsedRange {
                        start: Anchor::new(5),
                        end: Anchor::new(5),
                    },
                },
            }
        );
        // DEL はコロンを取らない → コロン付きは Raw へ落ちる。
        assert!(matches!(classify_line("DEL 5:", 1), Token::Raw { .. }));
    }

    #[test]
    fn classify_insert_targets() {
        assert_eq!(
            classify_line("INS.POST 4:", 1),
            Token::OpBlock {
                line_num: 1,
                target: BlockTarget::InsertAfter {
                    anchor: Anchor::new(4),
                },
            }
        );
        assert_eq!(
            classify_line("INS.HEAD:", 1),
            Token::OpBlock {
                line_num: 1,
                target: BlockTarget::Bof,
            }
        );
    }

    #[test]
    fn classify_payload_and_blank() {
        assert_eq!(
            classify_line("+hello", 2),
            Token::PayloadLiteral {
                line_num: 2,
                text: "hello".to_string(),
            }
        );
        assert_eq!(classify_line("", 2), Token::Blank { line_num: 2 });
    }

    #[test]
    fn dropped_block_ops_become_raw() {
        // SWAP.BLK / DEL.BLK は移植範囲外 → 操作行として認識されない。
        assert!(matches!(classify_line("SWAP.BLK 3:", 1), Token::Raw { .. }));
        assert!(matches!(classify_line("DEL.BLK 3", 1), Token::Raw { .. }));
    }
}
