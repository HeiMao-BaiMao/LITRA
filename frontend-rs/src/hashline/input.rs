//! パッチ入力の分割・同じパスのセクション統合。oh-my-pi `input.ts` の移植
//! （ストリーミング预览とブロックリゾルバ配線を省略）。

use std::cell::RefCell;
use std::collections::HashSet;

use crate::hashline::apply::apply_edits;
use crate::hashline::parser::{parse_patch, ParseOutput};
use crate::hashline::tokenizer;
use crate::hashline::types::{ApplyResult, Cursor, Edit};

/// 1つのファイルセクション（`[PATH#TAG]` ヘッダ + パッチ本文）。
pub struct PatchSection {
    pub path: String,
    pub file_hash: Option<String>,
    diff: String,
    cached: RefCell<Option<Result<ParseOutput, String>>>,
}

impl PatchSection {
    pub fn new(path: String, file_hash: Option<String>, diff: String) -> Self {
        Self {
            path,
            file_hash,
            diff,
            cached: RefCell::new(None),
        }
    }

    /// パッチ本文を解析する（結果をキャッシュ）。
    pub fn parse(&self) -> Result<ParseOutput, String> {
        let mut cached = self.cached.borrow_mut();
        if let Some(result) = cached.as_ref() {
            return result.clone();
        }
        let result = parse_patch(&self.diff);
        *cached = Some(result.clone());
        result
    }

    pub fn diff(&self) -> &str {
        &self.diff
    }

    pub fn edits(&self) -> Result<Vec<Edit>, String> {
        Ok(self.parse()?.edits)
    }

    pub fn warnings(&self) -> Result<Vec<String>, String> {
        Ok(self.parse()?.warnings)
    }

    /// アンカー指定の編集（Delete または Before/AfterAnchor 挿入）を含むか。
    /// 純粋な INS.HEAD/INS.TAIL は位置が内容非依存なのでカウントしない。
    pub fn has_anchor_scoped_edit(&self) -> Result<bool, String> {
        for edit in self.parse()?.edits {
            match edit {
                Edit::Delete { .. } => return Ok(true),
                Edit::Insert { cursor, .. } => {
                    if matches!(cursor, Cursor::BeforeAnchor { .. } | Cursor::AfterAnchor { .. }) {
                        return Ok(true);
                    }
                }
            }
        }
        Ok(false)
    }

    /// 全アンカー行を昇順・重複排除で収集する。
    pub fn collect_anchor_lines(&self) -> Result<Vec<u32>, String> {
        let mut lines: Vec<u32> = Vec::new();
        for edit in self.parse()?.edits {
            match edit {
                Edit::Delete { anchor, .. } => lines.push(anchor.line),
                Edit::Insert {
                    cursor: Cursor::BeforeAnchor { anchor },
                    ..
                } => lines.push(anchor.line),
                Edit::Insert {
                    cursor: Cursor::AfterAnchor { anchor },
                    ..
                } => lines.push(anchor.line),
                _ => {}
            }
        }
        lines.sort_unstable();
        lines.dedup();
        Ok(lines)
    }

    /// インメモリでテキストに適用する（タグ検証なし・リカバリなしの純粋適用）。
    pub fn apply_to(&self, text: &str) -> Result<ApplyResult, String> {
        let parsed = self.parse()?;
        let mut result = apply_edits(text, &parsed.edits)?;
        let mut warnings = parsed.warnings;
        warnings.append(&mut result.warnings);
        result.warnings = warnings;
        Ok(result)
    }

    /// パスを再バインドする（パス回復用）。hash/diff/キャッシュは維持。
    pub fn with_path(&self, new_path: &str) -> PatchSection {
        PatchSection {
            path: new_path.to_string(),
            file_hash: self.file_hash.clone(),
            diff: self.diff.clone(),
            cached: RefCell::new(self.cached.borrow().clone()),
        }
    }
}

/// 複数セクションのパッチ。
pub struct Patch {
    pub sections: Vec<PatchSection>,
}

/// ヘッダ行 `[PATH]` / `[PATH#TAG]` を解析する（input 分割用）。
/// 成功すれば `(path, file_hash)`、ヘッダでなければ None、不正なら Err。
fn parse_hashline_header_line(line: &str) -> Result<Option<(String, Option<String>)>, String> {
    let trimmed = line.trim_end();
    if !trimmed.starts_with('[') {
        return Ok(None);
    }
    // トークナイザのヘッダ解析を1行だけ走らせる
    let tokens = tokenizer::tokenize_all(trimmed);
    match tokens.first() {
        Some(tokenizer::Token::Header { path, file_hash, .. }) => {
            if path.is_empty() {
                Err("Input header \"[]\" is empty; provide a file path.".to_string())
            } else {
                Ok(Some((path.clone(), file_hash.clone())))
            }
        }
        _ => Err(format!(
            "Input header must be [PATH] or [PATH#TAG] with a 4-hex content-hash tag; got {}.",
            json_quote(trimmed)
        )),
    }
}

/// 入力をセクションに分割する。
fn split_raw_sections(input: &str) -> Result<Vec<PatchSection>, String> {
    // 先頭の空行と "*** Begin Patch" を除去
    let lines: Vec<&str> = input.split('\n').collect();
    let mut start = 0;
    for line in &lines {
        let trimmed = line.trim_end().trim_start_matches('\u{FEFF}');
        if trimmed.trim().is_empty() || trimmed.trim() == crate::hashline::messages::BEGIN_PATCH_MARKER {
            start += 1;
        } else {
            break;
        }
    }
    let body_lines = &lines[start..];
    if body_lines.is_empty() {
        return Err("Patch input did not produce any sections.".to_string());
    }

    // 最初の非空行はヘッダでなければならない
    let first = body_lines[0].trim_end();
    if parse_hashline_header_line(first)?.is_none() {
        let preview: String = first.chars().take(120).collect();
        return Err(format!(
            "input must begin with \"[PATH#HASH]\" on the first non-blank line for anchored edits; got: {}. Example: \"[src/foo.ts#1A2B]\" then edit ops.",
            json_quote(&preview)
        ));
    }

    let mut sections: Vec<PatchSection> = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_hash: Option<String> = None;
    let mut current_body: Vec<String> = Vec::new();

    let flush = |sections: &mut Vec<PatchSection>,
                 path: &mut Option<String>,
                 hash: &mut Option<String>,
                 body: &mut Vec<String>| {
        if let Some(p) = path.take() {
            let has_content = body.iter().any(|l| !l.trim().is_empty());
            if has_content {
                sections.push(PatchSection::new(p, hash.take(), body.join("\n")));
            }
        }
        body.clear();
        *hash = None;
    };

    for line in body_lines {
        let trimmed = line.trim_end();
        // エンベロープ終了・中断で停止
        if trimmed.trim() == crate::hashline::messages::END_PATCH_MARKER
            || trimmed.trim() == crate::hashline::messages::ABORT_MARKER
        {
            break;
        }
        if trimmed.trim() == crate::hashline::messages::BEGIN_PATCH_MARKER {
            continue;
        }
        if trimmed.starts_with('[') {
            if let Some((path, hash)) = parse_hashline_header_line(trimmed)? {
                flush(&mut sections, &mut current_path, &mut current_hash, &mut current_body);
                current_path = Some(path);
                current_hash = hash;
                continue;
            }
        }
        current_body.push(line.to_string());
    }
    flush(&mut sections, &mut current_path, &mut current_hash, &mut current_body);

    Ok(sections)
}

/// 同じパスのセクションを1つにまとめる（アンカーは同一スナップショットに対して
/// 一括適用する必要があるため）。タグが衝突すればエラー。
fn merge_same_path_sections(sections: Vec<PatchSection>) -> Result<Vec<PatchSection>, String> {
    let mut order: Vec<String> = Vec::new();
    let mut by_path: std::collections::HashMap<String, (Option<String>, Vec<String>)> =
        std::collections::HashMap::new();

    for section in sections {
        let entry = by_path.entry(section.path.clone()).or_insert_with(|| {
            order.push(section.path.clone());
            (section.file_hash.clone(), Vec::new())
        });
        // タグの統合: 両方あって異なれば衝突
        match (&entry.0, &section.file_hash) {
            (Some(a), Some(b)) if a != b => {
                return Err(format!(
                    "Conflicting hashline snapshot tags for {}: #{} and #{}. Re-read the file and retry with one current header.",
                    section.path, a, b
                ));
            }
            (None, Some(b)) => entry.0 = Some(b.clone()),
            _ => {}
        }
        entry.1.push(section.diff);
    }

    Ok(order
        .into_iter()
        .map(|path| {
            let (hash, diffs) = by_path.remove(&path).unwrap();
            PatchSection::new(path, hash, diffs.join("\n"))
        })
        .collect())
}

impl Patch {
    /// 入力を解析してパッチを構築する（分割 → 同じパス統合）。
    pub fn parse(input: &str) -> Result<Patch, String> {
        let sections = split_raw_sections(input)?;
        let sections = merge_same_path_sections(sections)?;
        Ok(Patch { sections })
    }

    /// 単一セクションのパッチを解析する。空ならエラー。
    pub fn parse_single(input: &str) -> Result<PatchSection, String> {
        let patch = Patch::parse(input)?;
        if patch.sections.is_empty() {
            return Err("Patch input did not produce any sections.".to_string());
        }
        // 全セクションを1つにまとめる（複数パスはここではエラーにせず先頭を返す用途）
        Ok(patch.sections.into_iter().next().unwrap())
    }
}

/// 使用アンカー行の集合を作る（seen-line ガード用）。
pub fn anchor_line_set(section: &PatchSection) -> Result<HashSet<u32>, String> {
    Ok(section.collect_anchor_lines()?.into_iter().collect())
}

fn json_quote(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}
