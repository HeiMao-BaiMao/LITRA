//! トークン駆動の状態機械。[`Token`] 列を平坦な [`Edit`] 列に変換する。
//! oh-my-pi `parser.ts` の移植（ブロック操作・ファイル級操作は省略）。
//!
//! ツリー座標ブロック（`SWAP.BLK` 等）とファイル級 `REM`/`MV` は小説編集では
//! 使わないため、この移植には存在しない。

use std::collections::BTreeMap;

use once_cell::sync::Lazy;
use regex::Regex;

use crate::hashline::format::HL_RANGE_SEP;
use crate::hashline::messages::{
    del_with_colon_message, BARE_BODY_AUTO_PIPED_WARNING, DELETE_TAKES_NO_BODY, EMPTY_INSERT,
    MINUS_ROW_REJECTED,
};
use crate::hashline::tokenizer::{tokenize_all, BlockTarget, Token};
use crate::hashline::types::{Anchor, Cursor, Edit, InsertMode, ParsedRange};

// ── 正規表現（`prefixes.ts` / `parser.ts` の汚染検出由来） ───────────
/// read/search 出力の行番号プレフィックス（`N:`、`>>>N:`、`+N:` 等）。単一パスで1つだけ剥がす。
static HL_PREFIX_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\s*(?:>>>|>>)?\s*(?:[+*-]\s*)?[0-9]+:").unwrap());

/// 裸の `N: <value>` 行の残りが孤立リテラル（引用文字列/数値、任意のカンマ終端）か。
/// 数値キーの dict/YAML 本体（`1: "one",`）の形状 — read 出力ペーストではない。
static BARE_LITERAL_VALUE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"^\s*(?:"[^"]*"|'[^']*'|[-+]?[0-9]+(?:\.[0-9]+)?)\s*,?\s*$"#).unwrap()
});

/// unified-diff ハンクヘッダ `@@ -N,M +N,M @@`。
static UNIFIED_DIFF_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^@@\s+[-+]?[0-9]+,[0-9]+\s+[-+]?[0-9]+,[0-9]+\s+@@").unwrap());

/// コロン付きの `DEL N.=M:`（DEL はコロンも本文も取らない）。
static DEL_WITH_COLON_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^DEL\s+[1-9][0-9]*(?:\s*(?:\.\.|\.=|-|…|\s)\s*[1-9][0-9]*)?\s*:").unwrap()
});

/// 動詞なしの裸行番号。
static BARE_NUMBER_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[1-9][0-9]*\s*$").unwrap());

/// 動詞なしの裸範囲。
static BARE_RANGE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^([1-9][0-9]*)\s*[-. …=]+\s*([1-9][0-9]*)\s*:?$").unwrap());

/// `parse_patch` の出力。`REM`/`MV` を省略したため file_op は無い。
#[derive(Clone, Debug)]
pub struct ParseOutput {
    pub edits: Vec<Edit>,
    pub warnings: Vec<String>,
}

/// パッチテキストを解析し、編集列と警告を返す。硬エラーは `Err(String)`。
pub fn parse_patch(diff: &str) -> Result<ParseOutput, String> {
    let tokens = tokenize_all(diff);
    let mut executor = Executor::new();
    for token in tokens {
        executor.feed(token)?;
    }
    executor.end()
}

/// 範囲の順序を検証（終端が起点より前ならエラー）。
fn validate_range_order(range: &ParsedRange, line_num: u32) -> Result<(), String> {
    if range.end.line < range.start.line {
        return Err(format!(
            "line {}: range {}{}{} ends before it starts.",
            line_num, range.start.line, HL_RANGE_SEP, range.end.line
        ));
    }
    Ok(())
}

/// 範囲を個々の行アンカーに展開する（両端含む）。
fn expand_range(range: &ParsedRange) -> Vec<Anchor> {
    let mut anchors = Vec::new();
    let mut line = range.start.line;
    while line <= range.end.line {
        anchors.push(Anchor::new(line));
        line += 1;
    }
    anchors
}

/// `#` で始まる（先頭空白を許容）コメント行か。
fn is_skippable_comment_line(line: &str) -> bool {
    line.trim_start().starts_with('#')
}

/// read 出力の行番号プレフィックスを1つだけ剥がす（ループしない）。
fn strip_one_leading_hashline_prefix(line: &str) -> String {
    HL_PREFIX_RE.replace(line, "").into_owned()
}

/// 孤立リテラル値（`"..."` / `'...'` / 数値、任意のカンマ終端）か。
fn is_bare_literal_value(s: &str) -> bool {
    BARE_LITERAL_VALUE_RE.is_match(s)
}

/// 最小限の JSON 文字列クオート（診断メッセージの `JSON.stringify` 相当）。
fn json_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// apply_patch/unified-diff/裸ヘッダなどの汚染を検出し、診断メッセージを返す。
fn detect_apply_patch_contamination(text: &str) -> Option<String> {
    let trimmed = text.trim_start();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with("*** Update File:")
        || trimmed.starts_with("*** Add File:")
        || trimmed.starts_with("*** Delete File:")
        || trimmed.starts_with("*** Move to:")
    {
        let preview = if trimmed.chars().count() > 48 {
            let head: String = trimmed.chars().take(48).collect();
            format!("{}…", head)
        } else {
            trimmed.to_string()
        };
        return Some(format!(
            "apply_patch sentinel {} is not valid in hashline. \
File sections start with `[path#HASH]` (no `Update File:` / `Add File:` keyword). \
Use `SWAP N{}M:`, `DEL N{}M`, or `INS.PRE|POST|HEAD|TAIL:` ops.",
            json_quote(&preview),
            HL_RANGE_SEP,
            HL_RANGE_SEP
        ));
    }
    if UNIFIED_DIFF_RE.is_match(trimmed) {
        return Some(format!(
            "unified-diff hunk header (`@@ -N,M +N,M @@`) is not valid in hashline. \
Use `SWAP N{}M:`, `DEL N{}M`, or `INS.PRE|POST|HEAD|TAIL:` ops.",
            HL_RANGE_SEP, HL_RANGE_SEP
        ));
    }
    if trimmed.starts_with("@@") {
        let preview = if trimmed.chars().count() > 48 {
            let head: String = trimmed.chars().take(48).collect();
            format!("{}…", head)
        } else {
            trimmed.to_string()
        };
        return Some(format!(
            "`@@`-bracketed hunk header {} is not valid in hashline. \
Drop the `@@ ... @@` brackets and write a verb header such as `SWAP N{}M:`.",
            json_quote(&preview),
            HL_RANGE_SEP
        ));
    }
    if DEL_WITH_COLON_RE.is_match(trimmed) {
        return Some(del_with_colon_message().to_string());
    }
    if BARE_NUMBER_RE.is_match(trimmed) {
        return Some(format!(
            "hunk headers need a verb. Use `SWAP {n}{sep}{n}:` to replace, or `DEL {n}` to delete.",
            n = trimmed,
            sep = HL_RANGE_SEP
        ));
    }
    if let Some(caps) = BARE_RANGE_RE.captures(trimmed) {
        let a = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let b = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        return Some(format!(
            "bare range hunk header {} is not valid. \
Hunk headers need a verb: write `SWAP {}{}{}:` or `DEL {}{}{}`.",
            json_quote(trimmed),
            a,
            HL_RANGE_SEP,
            b,
            a,
            HL_RANGE_SEP,
            b
        ));
    }
    None
}

/// 本文行。`bare` は `+` なしで自動パイプされた行（read 出力プレフィックス剥がしの対象）。
#[derive(Clone, Debug)]
struct PayloadRow {
    text: String,
    #[allow(dead_code)]
    line_num: u32,
    bare: bool,
}

/// 保留中のハング（ヘッダと、これまでに集めた本文行）。
struct Pending {
    target: BlockTarget,
    line_num: u32,
    payloads: Vec<PayloadRow>,
    /// 本文開始後に見た空行。内部空行は次の非空行で本文に確定される。
    /// 次のヘッダ/操作までの末尾空行はレイアウト区切りとしてフラッシュ時に捨てられる。
    deferred_blanks: Vec<PayloadRow>,
}

/// 保留中のコメント行（バッファされた Markdown 見出し等）。
struct PendingComment {
    line_num: u32,
    text: String,
}

/// トークン列を [`Edit`] 列に変換する状態機械。
struct Executor {
    edits: Vec<Edit>,
    warnings: Vec<String>,
    edit_index: u32,
    pending: Option<Pending>,
    terminated: bool,
    skippable_comments: Vec<PendingComment>,
}

impl Executor {
    fn new() -> Self {
        Self {
            edits: Vec::new(),
            warnings: Vec::new(),
            edit_index: 0,
            pending: None,
            terminated: false,
            skippable_comments: Vec::new(),
        }
    }

    fn discard_pending_skippable_comments(&mut self) {
        self.skippable_comments.clear();
    }

    fn consume_pending_skippable_comments(&mut self) -> Result<(), String> {
        if self.skippable_comments.is_empty() {
            return Ok(());
        }
        let comments = std::mem::take(&mut self.skippable_comments);
        for comment in comments {
            self.handle_raw(&comment.text, comment.line_num)?;
        }
        Ok(())
    }

    fn feed(&mut self, token: Token) -> Result<(), String> {
        if self.terminated {
            return Ok(());
        }
        match token {
            Token::EnvelopeBegin { .. } => {
                self.consume_pending_skippable_comments()?;
            }
            Token::EnvelopeEnd { .. } => {
                self.consume_pending_skippable_comments()?;
                self.terminated = true;
            }
            Token::Abort { .. } => {
                self.terminated = true;
            }
            Token::Header { .. } => {
                self.consume_pending_skippable_comments()?;
                self.flush_pending()?;
            }
            Token::Blank { line_num } => {
                self.consume_pending_skippable_comments()?;
                self.handle_blank("", line_num);
            }
            Token::PayloadLiteral { line_num, text } => {
                self.consume_pending_skippable_comments()?;
                self.handle_literal_payload(&text, line_num)?;
            }
            Token::Raw { line_num, text } => {
                if self.pending.is_none() && is_skippable_comment_line(&text) {
                    self.skippable_comments.push(PendingComment { line_num, text });
                    return Ok(());
                }
                self.consume_pending_skippable_comments()?;
                self.handle_raw(&text, line_num)?;
            }
            Token::OpBlock { line_num, target } => {
                self.discard_pending_skippable_comments();
                match &target {
                    BlockTarget::Replace { range } | BlockTarget::Delete { range } => {
                        validate_range_order(range, line_num)?;
                    }
                    _ => {}
                }
                self.flush_pending()?;
                self.pending = Some(Pending {
                    target,
                    line_num,
                    payloads: Vec::new(),
                    deferred_blanks: Vec::new(),
                });
            }
        }
        Ok(())
    }

    fn end(&mut self) -> Result<ParseOutput, String> {
        self.consume_pending_skippable_comments()?;
        self.flush_pending()?;
        self.validate_no_overlapping_deletes()?;
        Ok(ParseOutput {
            edits: std::mem::take(&mut self.edits),
            warnings: std::mem::take(&mut self.warnings),
        })
    }

    fn push_warning_once(&mut self, warning: &str) {
        if !self.warnings.iter().any(|w| w == warning) {
            self.warnings.push(warning.to_string());
        }
    }

    fn handle_literal_payload(&mut self, text: &str, line_num: u32) -> Result<(), String> {
        if self.pending.is_none() {
            return Err(format!(
                "line {}: payload line has no preceding hunk header. Got {}.",
                line_num,
                json_quote(&format!("+{}", text))
            ));
        }
        if matches!(
            self.pending.as_ref().unwrap().target,
            BlockTarget::Delete { .. }
        ) {
            return Err(format!("line {}: {}", line_num, DELETE_TAKES_NO_BODY));
        }
        self.commit_deferred_blanks();
        let pending = self.pending.as_mut().unwrap();
        pending.payloads.push(PayloadRow {
            text: text.to_string(),
            line_num,
            bare: false,
        });
        Ok(())
    }

    fn handle_raw(&mut self, text: &str, line_num: u32) -> Result<(), String> {
        if let Some(contamination) = detect_apply_patch_contamination(text) {
            return Err(format!("line {}: {}", line_num, contamination));
        }
        if self.pending.is_some() {
            if text.trim().is_empty() {
                self.handle_blank(text, line_num);
                return Ok(());
            }
            if matches!(
                self.pending.as_ref().unwrap().target,
                BlockTarget::Delete { .. }
            ) {
                return Err(format!("line {}: {}", line_num, DELETE_TAKES_NO_BODY));
            }
            if text.trim_start().starts_with('-') {
                return Err(format!("line {}: {}", line_num, MINUS_ROW_REJECTED));
            }
            self.push_warning_once(BARE_BODY_AUTO_PIPED_WARNING);
            self.commit_deferred_blanks();
            let pending = self.pending.as_mut().unwrap();
            pending.payloads.push(PayloadRow {
                text: text.to_string(),
                line_num,
                bare: true,
            });
            return Ok(());
        }
        if text.trim().is_empty() {
            return Ok(());
        }
        Err(format!(
            "line {}: payload line has no preceding hunk header. \
Use `SWAP N{}M:`, `DEL N{}M`, or `INS.PRE|POST|HEAD|TAIL:` above the body. Got {}.",
            line_num,
            HL_RANGE_SEP,
            HL_RANGE_SEP,
            json_quote(text)
        ))
    }

    /// ハング本文内の空行は曖昧: 内部空行は本文内容、本文開始前/次の操作へ続く空行は
    /// レイアウト。後で非空行が内部空行だと確定するまで保留する。
    fn handle_blank(&mut self, text: &str, line_num: u32) {
        let pending = match self.pending.as_mut() {
            Some(p) => p,
            None => return,
        };
        if matches!(pending.target, BlockTarget::Delete { .. }) {
            return;
        }
        if pending.payloads.is_empty() {
            return;
        }
        pending.deferred_blanks.push(PayloadRow {
            text: text.to_string(),
            line_num,
            bare: true,
        });
    }

    fn commit_deferred_blanks(&mut self) {
        let has_deferred = self
            .pending
            .as_ref()
            .map_or(false, |p| !p.deferred_blanks.is_empty());
        if !has_deferred {
            return;
        }
        self.push_warning_once(BARE_BODY_AUTO_PIPED_WARNING);
        let pending = self.pending.as_mut().unwrap();
        let blanks = std::mem::take(&mut pending.deferred_blanks);
        pending.payloads.extend(blanks);
    }

    /// すべての bare 行が read 出力の行番号プレフィックスを持つとき、それを1つだけ剥がす。
    /// 一律なプレフィックスは read/search 出力からのペーストの特徴。混在している場合は
    /// `N:` は本当の本文内容なので剥がさない。`+` 付きの行は bare でなく対象外。
    fn strip_bare_prefixes_if_uniform(payloads: &mut [PayloadRow]) {
        let mut saw_bare = false;
        let mut all_literal_values = true;
        for row in payloads.iter() {
            if !row.bare || row.text.trim().is_empty() {
                continue;
            }
            saw_bare = true;
            let stripped = strip_one_leading_hashline_prefix(&row.text);
            if stripped == row.text {
                return;
            }
            all_literal_values = all_literal_values && is_bare_literal_value(&stripped);
        }
        if !saw_bare {
            return;
        }
        // 剥がした残りがすべて孤立リテラル（数値キー dict/YAML の形状）なら、
        // `N:` キーを剥がすと各行を壊すため、そのままにする。
        if all_literal_values {
            return;
        }
        for row in payloads.iter_mut() {
            if row.bare && !row.text.trim().is_empty() {
                row.text = strip_one_leading_hashline_prefix(&row.text);
            }
        }
    }

    fn push_insert(&mut self, cursor: Cursor, text: &str, line_num: u32, mode: Option<InsertMode>) {
        self.edits.push(Edit::Insert {
            cursor,
            text: text.to_string(),
            line_num,
            index: self.edit_index,
            mode,
        });
        self.edit_index += 1;
    }

    fn push_delete(&mut self, anchor: Anchor, line_num: u32) {
        self.edits.push(Edit::Delete {
            anchor,
            line_num,
            index: self.edit_index,
        });
        self.edit_index += 1;
    }

    fn emit_payload_rows(
        &mut self,
        cursor: Cursor,
        payloads: &[PayloadRow],
        line_num: u32,
        mode: Option<InsertMode>,
    ) {
        for payload in payloads {
            self.push_insert(cursor, &payload.text, line_num, mode);
        }
    }

    fn flush_pending(&mut self) -> Result<(), String> {
        let pending = match self.pending.take() {
            Some(p) => p,
            None => return Ok(()),
        };
        let Pending {
            target,
            line_num,
            mut payloads,
            deferred_blanks: _,
        } = pending;
        Self::strip_bare_prefixes_if_uniform(&mut payloads);

        if let BlockTarget::Delete { range } = &target {
            for anchor in expand_range(range) {
                self.push_delete(anchor, line_num);
            }
            return Ok(());
        }

        if payloads.is_empty() {
            if let BlockTarget::Replace { range } = &target {
                // 本文なしの SWAP は範囲削除に解決される。
                for anchor in expand_range(range) {
                    self.push_delete(anchor, line_num);
                }
                return Ok(());
            }
            return Err(format!("line {}: {}", line_num, EMPTY_INSERT));
        }

        match &target {
            BlockTarget::Replace { range } => {
                let cursor = Cursor::BeforeAnchor {
                    anchor: range.start,
                };
                self.emit_payload_rows(cursor, &payloads, line_num, Some(InsertMode::Replacement));
                for anchor in expand_range(range) {
                    self.push_delete(anchor, line_num);
                }
            }
            BlockTarget::InsertBefore { anchor } => {
                self.emit_payload_rows(
                    Cursor::BeforeAnchor { anchor: *anchor },
                    &payloads,
                    line_num,
                    None,
                );
            }
            BlockTarget::InsertAfter { anchor } => {
                self.emit_payload_rows(
                    Cursor::AfterAnchor { anchor: *anchor },
                    &payloads,
                    line_num,
                    None,
                );
            }
            BlockTarget::Bof => {
                self.emit_payload_rows(Cursor::Bof, &payloads, line_num, None);
            }
            BlockTarget::Eof => {
                self.emit_payload_rows(Cursor::Eof, &payloads, line_num, None);
            }
            BlockTarget::Delete { .. } => unreachable!("delete handled above"),
        }
        Ok(())
    }

    /// 同じアンカー行が複数の異なるソース行（ハング）から削除対象にされているならエラー。
    fn validate_no_overlapping_deletes(&self) -> Result<(), String> {
        let mut source_lines_by_anchor: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
        for edit in &self.edits {
            if let Edit::Delete {
                anchor, line_num, ..
            } = edit
            {
                let entry = source_lines_by_anchor.entry(anchor.line).or_default();
                if !entry.contains(line_num) {
                    entry.push(*line_num);
                }
            }
        }
        for (anchor_line, mut source_lines) in source_lines_by_anchor {
            if source_lines.len() < 2 {
                continue;
            }
            source_lines.sort_unstable();
            let first = source_lines[0];
            let second = source_lines[1];
            return Err(format!(
                "line {}: anchor line {} is already targeted by another hunk on line {}. \
Issue ONE hunk per range; payload is only the final desired content, never a before/after pair.",
                second, anchor_line, first
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn insert_texts(output: &ParseOutput) -> Vec<(Cursor, String, Option<InsertMode>)> {
        output
            .edits
            .iter()
            .filter_map(|e| match e {
                Edit::Insert {
                    cursor, text, mode, ..
                } => Some((*cursor, text.clone(), *mode)),
                _ => None,
            })
            .collect()
    }

    fn delete_lines(output: &ParseOutput) -> Vec<u32> {
        output
            .edits
            .iter()
            .filter_map(|e| match e {
                Edit::Delete { anchor, .. } => Some(anchor.line),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn parse_swap_emits_inserts_then_deletes() {
        let diff = "[chapter.md#ABCD]\nSWAP 2.=3:\n+new one\n+new two";
        let out = parse_patch(diff).unwrap();
        let inserts = insert_texts(&out);
        assert_eq!(inserts.len(), 2);
        assert_eq!(inserts[0].0, Cursor::BeforeAnchor { anchor: Anchor::new(2) });
        assert_eq!(inserts[0].1, "new one");
        assert_eq!(inserts[0].2, Some(InsertMode::Replacement));
        assert_eq!(inserts[1].1, "new two");
        assert_eq!(delete_lines(&out), vec![2, 3]);
    }

    #[test]
    fn parse_bodyless_swap_is_delete() {
        let diff = "SWAP 4.=5:";
        let out = parse_patch(diff).unwrap();
        assert!(insert_texts(&out).is_empty());
        assert_eq!(delete_lines(&out), vec![4, 5]);
    }

    #[test]
    fn parse_del_range() {
        let diff = "[chapter.md#ABCD]\nDEL 5.=7";
        let out = parse_patch(diff).unwrap();
        assert!(insert_texts(&out).is_empty());
        assert_eq!(delete_lines(&out), vec![5, 6, 7]);
    }

    #[test]
    fn parse_ins_post() {
        let diff = "INS.POST 4:\n+inserted";
        let out = parse_patch(diff).unwrap();
        let inserts = insert_texts(&out);
        assert_eq!(inserts.len(), 1);
        assert_eq!(inserts[0].0, Cursor::AfterAnchor { anchor: Anchor::new(4) });
        assert_eq!(inserts[0].1, "inserted");
        assert_eq!(inserts[0].2, None);
        assert!(delete_lines(&out).is_empty());
    }

    #[test]
    fn parse_ins_head_and_tail() {
        let head = parse_patch("INS.HEAD:\n+top").unwrap();
        assert_eq!(
            insert_texts(&head)[0].0,
            Cursor::Bof
        );
        let tail = parse_patch("INS.TAIL:\n+bottom").unwrap();
        assert_eq!(
            insert_texts(&tail)[0].0,
            Cursor::Eof
        );
    }

    #[test]
    fn empty_insert_errors() {
        assert!(parse_patch("INS.TAIL:").is_err());
    }

    #[test]
    fn del_with_body_errors() {
        assert!(parse_patch("DEL 2\n+X").is_err());
    }

    #[test]
    fn bare_body_row_warns_and_pipes() {
        let out = parse_patch("SWAP 2.=2:\n  hello").unwrap();
        assert!(out
            .warnings
            .iter()
            .any(|w| w.contains("Auto-prefixed bare body row")));
        assert_eq!(insert_texts(&out)[0].1, "  hello");
    }

    #[test]
    fn strips_uniform_read_output_prefix() {
        let out = parse_patch("SWAP 2.=3:\n2:foo\n3:bar").unwrap();
        let texts: Vec<String> = insert_texts(&out).into_iter().map(|(_, t, _)| t).collect();
        assert_eq!(texts, vec!["foo".to_string(), "bar".to_string()]);
    }

    #[test]
    fn keeps_mixed_prefix_body_untouched() {
        let out = parse_patch("SWAP 2.=3:\n3:keep\nplain").unwrap();
        let texts: Vec<String> = insert_texts(&out).into_iter().map(|(_, t, _)| t).collect();
        assert_eq!(texts, vec!["3:keep".to_string(), "plain".to_string()]);
    }

    #[test]
    fn contamination_apply_patch_sentinel() {
        assert!(parse_patch("*** Update File: a.ts\nSWAP 2.=2:\n+X").is_err());
    }

    #[test]
    fn contamination_unified_diff() {
        assert!(parse_patch("@@ -1,3 +1,3 @@\nSWAP 2.=2:\n+X").is_err());
    }

    #[test]
    fn contamination_bare_number_and_range() {
        assert!(parse_patch("2\n+B").is_err());
        assert!(parse_patch("2 3\n+X").is_err());
    }

    #[test]
    fn payload_without_header_errors() {
        assert!(parse_patch("+const X = 1;\nSWAP 2.=2:").is_err());
    }

    #[test]
    fn overlapping_deletes_error() {
        // 2つのハングが同じ3行目を削除対象にしている。
        assert!(parse_patch("DEL 3\nDEL 3").is_err());
    }

    #[test]
    fn range_order_error() {
        assert!(parse_patch("SWAP 5.=2:\n+x").is_err());
    }

    #[test]
    fn envelope_terminates_processing() {
        let diff = "*** Begin Patch\nSWAP 1.=1:\n+x\n*** End Patch\nDEL 9";
        let out = parse_patch(diff).unwrap();
        // End Patch 以降の DEL 9 は無視される。
        assert_eq!(delete_lines(&out), vec![1]);
    }
}
