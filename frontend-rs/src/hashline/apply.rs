//! 解析済み [`Edit`] 列を本文に適用するアプライヤ。oh-my-pi `apply.ts` の移植。
//!
//! 純粋関数: ファイルI/Oなし、入力の破壊的変更なし。小説編集向けに、コード固有の
//! デリミタバランス修復（`computeDelimiterBalance` / 構造クロージャー判定 / JSX 判定 /
//! after-insert ランディング補正）を省略し、境界echo修復は純粋な文字列一致のみで発火する。
//!
//! 置換グループ（SWAP）はまず [`repair_replacement_boundaries`] で正規化される。これは
//! ペイロードが範囲外の変更なし行を繰り返してしまう、よくあるモデルの誤りを吸収する。

use std::collections::BTreeMap;

use crate::hashline::messages::{
    ambiguous_boundary_echo_message, boundary_echo_one_sided_warning, boundary_echo_two_sided_warning,
};
use crate::hashline::types::{ApplyResult, Cursor, Edit, InsertMode};

/// 末尾のファントム行（1-indexed 行番号）を返す。存在しなければ 0。
///
/// 改行で終わるファイルを `split('\n')` すると末尾に `""` センチネルが残る。これは挿入
/// （末尾追加）からはアドレス可能だが実内容ではない。ここへの削除はファイル末尾の改行を
/// 削るだけなので、そのような削除編集を無視する。これにより EOF で終わる包含範囲は意図どおり
/// 最終実行まで削除される。
fn trailing_phantom_line(file_lines: &[String]) -> u32 {
    if file_lines.len() > 1 && file_lines[file_lines.len() - 1].is_empty() {
        file_lines.len() as u32
    } else {
        0
    }
}

/// ファントム行に着地する削除編集を取り除く（TS: `dropTrailingPhantomDeletes`）。
fn drop_trailing_phantom_deletes(edits: &[Edit], file_lines: &[String]) -> Vec<Edit> {
    let phantom = trailing_phantom_line(file_lines);
    if phantom == 0 {
        return edits.to_vec();
    }
    edits
        .iter()
        .filter(|edit| !matches!(edit, Edit::Delete { anchor, .. } if anchor.line == phantom))
        .cloned()
        .collect()
}

/// 編集が持つアンカーの行番号（アンカーを持たない BOF/EOF 挿入は None）。
fn edit_anchor_line(edit: &Edit) -> Option<u32> {
    match edit {
        Edit::Delete { anchor, .. } => Some(anchor.line),
        Edit::Insert {
            cursor: Cursor::BeforeAnchor { anchor },
            ..
        } => Some(anchor.line),
        Edit::Insert {
            cursor: Cursor::AfterAnchor { anchor },
            ..
        } => Some(anchor.line),
        Edit::Insert { cursor: Cursor::Bof, .. } | Edit::Insert { cursor: Cursor::Eof, .. } => None,
    }
}

/// すべてのアンカー付き編集が実在する行を指しているか検証する（TS: `validateLineBounds`）。
fn validate_line_bounds(edits: &[Edit], file_lines: &[String]) -> Result<(), String> {
    let len = file_lines.len() as u32;
    for edit in edits {
        if let Some(line) = edit_anchor_line(edit) {
            if line < 1 || line > len {
                return Err(format!("Line {line} does not exist (file has {len} lines)"));
            }
        }
    }
    Ok(())
}

/// ファイル先頭への挿入（TS: `insertAtStart`）。
fn insert_at_start(file_lines: &mut Vec<String>, lines: &[String]) {
    if lines.is_empty() {
        return;
    }
    if file_lines.len() == 1 && file_lines[0].is_empty() {
        file_lines.splice(0..1, lines.iter().cloned());
        return;
    }
    file_lines.splice(0..0, lines.iter().cloned());
}

/// ファイル末尾への挿入（TS: `insertAtEnd`）。変更された行番号（1-indexed）を返す。
fn insert_at_end(file_lines: &mut Vec<String>, lines: &[String]) -> Option<u32> {
    if lines.is_empty() {
        return None;
    }
    if file_lines.len() == 1 && file_lines[0].is_empty() {
        file_lines.splice(0..1, lines.iter().cloned());
        return Some(1);
    }
    let has_trailing_newline = !file_lines.is_empty() && file_lines[file_lines.len() - 1].is_empty();
    let insert_index = if has_trailing_newline {
        file_lines.len() - 1
    } else {
        file_lines.len()
    };
    file_lines.splice(insert_index..insert_index, lines.iter().cloned());
    Some((insert_index + 1) as u32)
}

// ═══════════════════════════════════════════════════════════════════════════
// 置換境界修復（小説向けに簡略化：純粋な文字列一致のみで発火）

/// 編集列中の置換グループ（SWAP）の検出結果。
struct ReplacementGroup {
    /// ペイロード挿入の、編集列内位置（ペイロード順）。
    insert_indices: Vec<usize>,
    /// 範囲削除の、編集列内位置（行昇順）。
    delete_indices: Vec<usize>,
    payload: Vec<String>,
    /// 削除される先頭行（1-indexed）。
    start_line: u32,
    /// 削除される末尾行（1-indexed）。
    end_line: u32,
}

/// `start` から始まる置換グループを検出する（TS: `findReplacementGroup`）。
///
/// 同じ元パッチ行番号を共有する `before_anchor` 置換挿入の連続列の直後に、同じ操作の
/// 連続範囲削除が続く構造。パーサが `SWAP N.=M:` を低レベル化する形状を反映する。
fn find_replacement_group(edits: &[Edit], start: usize) -> Option<ReplacementGroup> {
    let first = edits.get(start)?;
    let (line_num, anchor_line) = match first {
        Edit::Insert {
            mode: Some(InsertMode::Replacement),
            cursor: Cursor::BeforeAnchor { anchor },
            line_num,
            ..
        } => (*line_num, anchor.line),
        _ => return None,
    };

    let mut insert_indices = Vec::new();
    let mut payload = Vec::new();
    let mut i = start;
    while i < edits.len() {
        match &edits[i] {
            Edit::Insert {
                mode: Some(InsertMode::Replacement),
                cursor: Cursor::BeforeAnchor { anchor },
                line_num: ln,
                text,
                ..
            } if *ln == line_num && anchor.line == anchor_line =>
            {
                insert_indices.push(i);
                payload.push(text.clone());
                i += 1;
            }
            _ => break,
        }
    }

    let mut delete_indices = Vec::new();
    let mut expected_line = anchor_line;
    while i < edits.len() {
        match &edits[i] {
            Edit::Delete {
                anchor,
                line_num: ln,
                ..
            } if *ln == line_num && anchor.line == expected_line =>
            {
                delete_indices.push(i);
                expected_line += 1;
                i += 1;
            }
            _ => break,
        }
    }

    if delete_indices.is_empty() {
        return None;
    }
    let end_line = anchor_line + delete_indices.len() as u32 - 1;
    Some(ReplacementGroup {
        insert_indices,
        delete_indices,
        payload,
        start_line: anchor_line,
        end_line,
    })
}

/// 空白以外の文字を1文字でも含むか（TS: `hasNonWhitespace`）。
fn has_non_whitespace(text: &str) -> bool {
    text.chars().any(|c| {
        let code = c as u32;
        !(code == 9 || code == 10 || code == 11 || code == 12 || code == 13 || code == 32)
    })
}

/// ペイロード先頭が範囲直上の残存行と一致する最大行数（TS: `countDuplicateLeadingBoundaryLines`）。
fn count_duplicate_leading_boundary_lines(group: &ReplacementGroup, file_lines: &[String]) -> usize {
    let payload = &group.payload;
    let start_line = group.start_line as usize;
    let max = payload.len().min(start_line - 1);
    for count in (1..=max).rev() {
        let mut matches = true;
        let mut has_content = false;
        for offset in 0..count {
            let line = &payload[offset];
            let file_idx = start_line - 1 - count + offset;
            if line != &file_lines[file_idx] {
                matches = false;
                break;
            }
            if has_non_whitespace(line) {
                has_content = true;
            }
        }
        if matches && has_content {
            return count;
        }
    }
    0
}

/// ペイロード末尾が範囲直下の残存行と一致する最大行数（TS: `countDuplicateTrailingBoundaryLines`）。
fn count_duplicate_trailing_boundary_lines(group: &ReplacementGroup, file_lines: &[String]) -> usize {
    let payload = &group.payload;
    let end_line = group.end_line as usize;
    let max = payload.len().min(file_lines.len() - end_line);
    for count in (1..=max).rev() {
        let mut matches = true;
        let mut has_content = false;
        for offset in 0..count {
            let line = &payload[payload.len() - count + offset];
            let file_idx = end_line + offset;
            if line != &file_lines[file_idx] {
                matches = false;
                break;
            }
            if has_non_whitespace(line) {
                has_content = true;
            }
        }
        if matches && has_content {
            return count;
        }
    }
    0
}

/// 両側境界echoの検出（TS: `findBoundaryEcho`、デリミタバランスの門を省略）。
///
/// ペイロードの先頭と末尾の両方が範囲外残存行の完全な複製であるときのみ発火する。
/// 返り値は `(leading, trailing)`。
fn find_boundary_echo(group: &ReplacementGroup, file_lines: &[String]) -> Option<(usize, usize)> {
    let leading = count_duplicate_leading_boundary_lines(group, file_lines);
    if leading == 0 {
        return None;
    }
    let trailing = count_duplicate_trailing_boundary_lines(group, file_lines);
    if trailing == 0 {
        return None;
    }
    // ペイロード全行が境界echoで説明できてしまう場合は修復しない（意図的な複製の可能性）。
    if leading + trailing >= group.payload.len() {
        return None;
    }
    Some((leading, trailing))
}

/// 片側境界echoの検出（TS: `findOneSidedBoundaryEcho`、デリミタバランス/構造クロージャーの門を省略）。
///
/// 先頭 XOR 末尾のどちらか一方だけが範囲外残存行を復唱している場合のみ発火する。
/// 返り値は `(side, count)`（`side` は `"leading"` または `"trailing"`）。
fn find_one_sided_boundary_echo(group: &ReplacementGroup, file_lines: &[String]) -> Option<(&'static str, usize)> {
    let leading = count_duplicate_leading_boundary_lines(group, file_lines);
    let trailing = count_duplicate_trailing_boundary_lines(group, file_lines);
    if (leading > 0) == (trailing > 0) {
        return None;
    }
    let (side, count) = if leading > 0 {
        ("leading", leading)
    } else {
        ("trailing", trailing)
    };
    if count >= group.payload.len() {
        return None;
    }
    Some((side, count))
}

/// 置換グループを正規化する（TS: `repairReplacementBoundaries` の小説向け簡略版）。
///
/// 各置換グループについて、両側echo（A）→片側echo（B、曖昧さエラーを維持）→そのまま通過、
/// の順で試す。修復されたグループごとに1つの警告を集める。グループでない編集はそのまま通過する。
fn repair_replacement_boundaries(
    edits: &[Edit],
    file_lines: &[String],
) -> Result<(Vec<Edit>, Vec<String>), String> {
    let mut out: Vec<Edit> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut i = 0;
    while i < edits.len() {
        let Some(group) = find_replacement_group(edits, i) else {
            out.push(edits[i].clone());
            i += 1;
            continue;
        };
        let inserts: Vec<Edit> = group.insert_indices.iter().map(|&idx| edits[idx].clone()).collect();
        let deletes: Vec<Edit> = group.delete_indices.iter().map(|&idx| edits[idx].clone()).collect();
        i = group.delete_indices[group.delete_indices.len() - 1] + 1;

        // (A) 両側境界echo: 先頭から `leading` 行、末尾から `trailing` 行を落とす。削除はすべて維持。
        if let Some((leading, trailing)) = find_boundary_echo(&group, file_lines) {
            let kept_end = inserts.len() - trailing;
            out.extend(inserts[leading..kept_end].iter().cloned());
            out.extend(deletes);
            warnings.push(boundary_echo_two_sided_warning(group.start_line, leading, trailing));
            continue;
        }

        // (B) 片側境界echo: echo側から `count` 行を落とす。削除はすべて維持。
        if let Some((side, count)) = find_one_sided_boundary_echo(&group, file_lines) {
            // ペイロードが「広がった範囲」の全内容になりえない（短すぎる）場合は曖昧 → 拒否。
            if group.payload.len() < group.delete_indices.len() + count {
                return Err(ambiguous_boundary_echo_message(
                    group.start_line,
                    group.end_line,
                    side,
                    count,
                ));
            }
            let trimmed: &[Edit] = if side == "leading" {
                &inserts[count..]
            } else {
                &inserts[..inserts.len() - count]
            };
            out.extend(trimmed.iter().cloned());
            out.extend(deletes);
            warnings.push(boundary_echo_one_sided_warning(group.start_line, count, side));
            continue;
        }

        // 修復なし: そのまま通過。
        out.extend(inserts);
        out.extend(deletes);
    }
    Ok((out, warnings))
}

/// 解析済み編集列を本文に適用する。純粋関数 — I/O なし（TS: `applyEdits`）。
///
/// 編集後の本文と、変更された最初の行番号（1-indexed）を返す。アンカーが範囲外なら `Err`。
pub fn apply_edits(text: &str, edits: &[Edit]) -> Result<ApplyResult, String> {
    if edits.is_empty() {
        return Ok(ApplyResult::unchanged(text.to_string()));
    }

    let mut file_lines: Vec<String> = text.split('\n').map(String::from).collect();
    let mut first_changed_line: Option<u32> = None;
    let track_first_changed = |line: u32, acc: &mut Option<u32>| {
        *acc = Some(acc.map_or(line, |cur| cur.min(line)));
    };

    let target_edits = drop_trailing_phantom_deletes(edits, &file_lines);
    validate_line_bounds(&target_edits, &file_lines)?;
    let (repaired, warnings) = repair_replacement_boundaries(&target_edits, &file_lines)?;

    // 編集を BOF / EOF / アンカー付きのバケットに分割する。
    let mut bof_lines: Vec<String> = Vec::new();
    let mut eof_lines: Vec<String> = Vec::new();
    let mut anchor_edits: Vec<(usize, Edit)> = Vec::new();
    for (idx, edit) in repaired.into_iter().enumerate() {
        match edit {
            Edit::Insert { cursor: Cursor::Bof, text, .. } => bof_lines.push(text),
            Edit::Insert { cursor: Cursor::Eof, text, .. } => eof_lines.push(text),
            other => anchor_edits.push((idx, other)),
        }
    }

    // アンカー付き編集を行キーでバケット化する。
    let mut by_line: BTreeMap<u32, Vec<(usize, Edit)>> = BTreeMap::new();
    for (idx, edit) in anchor_edits {
        let line = match &edit {
            Edit::Delete { anchor, .. } => anchor.line,
            Edit::Insert {
                cursor: Cursor::BeforeAnchor { anchor },
                ..
            } => anchor.line,
            Edit::Insert {
                cursor: Cursor::AfterAnchor { anchor },
                ..
            } => anchor.line,
            _ => 0,
        };
        by_line.entry(line).or_default().push((idx, edit));
    }

    // 行バケットをボトムアップ（行キー降順）で処理し、先のインデックスを有効に保つ。
    for (line, mut bucket) in by_line.into_iter().rev() {
        bucket.sort_by_key(|(idx, _)| *idx);

        let idx0 = (line - 1) as usize;
        let current_line = file_lines.get(idx0).cloned().unwrap_or_default();
        let mut before_insert_lines: Vec<String> = Vec::new();
        let mut after_insert_lines: Vec<String> = Vec::new();
        let mut replacement_lines: Vec<String> = Vec::new();
        let mut delete_line = false;

        for (_, edit) in bucket {
            match edit {
                Edit::Insert {
                    mode: Some(InsertMode::Replacement),
                    text,
                    ..
                } => replacement_lines.push(text),
                Edit::Insert {
                    cursor: Cursor::AfterAnchor { .. },
                    text,
                    ..
                } => after_insert_lines.push(text),
                Edit::Insert { text, .. } => before_insert_lines.push(text),
                Edit::Delete { .. } => delete_line = true,
            }
        }

        if before_insert_lines.is_empty()
            && replacement_lines.is_empty()
            && after_insert_lines.is_empty()
            && !delete_line
        {
            continue;
        }

        let mut replacement: Vec<String> = Vec::new();
        replacement.extend(before_insert_lines);
        replacement.extend(replacement_lines);
        if !delete_line {
            replacement.push(current_line);
        }
        replacement.extend(after_insert_lines);

        file_lines.splice(idx0..idx0 + 1, replacement);
        track_first_changed(line, &mut first_changed_line);
    }

    if !bof_lines.is_empty() {
        insert_at_start(&mut file_lines, &bof_lines);
        track_first_changed(1, &mut first_changed_line);
    }
    if let Some(changed) = insert_at_end(&mut file_lines, &eof_lines) {
        track_first_changed(changed, &mut first_changed_line);
    }

    Ok(ApplyResult {
        text: file_lines.join("\n"),
        first_changed_line,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::apply_edits;
    use crate::hashline::types::{Anchor, Cursor, Edit, InsertMode};

    fn ins_before(line: u32, text: &str, line_num: u32, index: u32, mode: Option<InsertMode>) -> Edit {
        Edit::Insert {
            cursor: Cursor::BeforeAnchor {
                anchor: Anchor::new(line),
            },
            text: text.to_string(),
            line_num,
            index,
            mode,
        }
    }

    fn ins_after(line: u32, text: &str, line_num: u32, index: u32) -> Edit {
        Edit::Insert {
            cursor: Cursor::AfterAnchor {
                anchor: Anchor::new(line),
            },
            text: text.to_string(),
            line_num,
            index,
            mode: None,
        }
    }

    fn ins_bof(text: &str, line_num: u32, index: u32) -> Edit {
        Edit::Insert {
            cursor: Cursor::Bof,
            text: text.to_string(),
            line_num,
            index,
            mode: None,
        }
    }

    fn ins_eof(text: &str, line_num: u32, index: u32) -> Edit {
        Edit::Insert {
            cursor: Cursor::Eof,
            text: text.to_string(),
            line_num,
            index,
            mode: None,
        }
    }

    fn del(line: u32, line_num: u32, index: u32) -> Edit {
        Edit::Delete {
            anchor: Anchor::new(line),
            line_num,
            index,
        }
    }

    #[test]
    fn empty_edits_is_unchanged() {
        let result = apply_edits("a\nb", &[]).unwrap();
        assert_eq!(result.text, "a\nb");
        assert_eq!(result.first_changed_line, None);
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn swap_single_line() {
        let edits = vec![
            ins_before(2, "X", 1, 0, Some(InsertMode::Replacement)),
            del(2, 1, 1),
        ];
        let result = apply_edits("a\nb\nc", &edits).unwrap();
        assert_eq!(result.text, "a\nX\nc");
        assert_eq!(result.first_changed_line, Some(2));
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn delete_line() {
        let edits = vec![del(2, 1, 0)];
        let result = apply_edits("a\nb\nc", &edits).unwrap();
        assert_eq!(result.text, "a\nc");
        assert_eq!(result.first_changed_line, Some(2));
    }

    #[test]
    fn insert_after_anchor() {
        let edits = vec![ins_after(2, "X", 1, 0)];
        let result = apply_edits("a\nb\nc", &edits).unwrap();
        assert_eq!(result.text, "a\nb\nX\nc");
        assert_eq!(result.first_changed_line, Some(2));
    }

    #[test]
    fn insert_head_and_tail() {
        let edits = vec![ins_bof("H", 1, 0), ins_eof("T", 2, 1)];
        let result = apply_edits("a\nb", &edits).unwrap();
        assert_eq!(result.text, "H\na\nb\nT");
        assert_eq!(result.first_changed_line, Some(1));
    }

    #[test]
    fn trailing_phantom_delete_is_dropped() {
        // "a\nb\n" → ["a","b",""]; 行3はファントム。そこへの削除は無視され no-op。
        let edits = vec![del(3, 1, 0)];
        let result = apply_edits("a\nb\n", &edits).unwrap();
        assert_eq!(result.text, "a\nb\n");
        assert_eq!(result.first_changed_line, None);
    }

    #[test]
    fn out_of_bounds_anchor_errors() {
        let edits = vec![del(5, 1, 0)];
        let result = apply_edits("a\nb\nc", &edits);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("does not exist"));
    }

    #[test]
    fn boundary_echo_two_sided_repair() {
        // ペイロードが範囲直上(keep_top)と直下(keep_bottom)の両方を復唱 → 両側echo修復。
        let edits = vec![
            ins_before(2, "keep_top", 1, 0, Some(InsertMode::Replacement)),
            ins_before(2, "NEW", 1, 1, Some(InsertMode::Replacement)),
            ins_before(2, "keep_bottom", 1, 2, Some(InsertMode::Replacement)),
            del(2, 1, 3),
            del(3, 1, 4),
        ];
        let result = apply_edits("keep_top\nold1\nold2\nkeep_bottom", &edits).unwrap();
        assert_eq!(result.text, "keep_top\nNEW\nkeep_bottom");
        assert_eq!(result.first_changed_line, Some(2));
        assert_eq!(result.warnings.len(), 1);
    }

    #[test]
    fn boundary_echo_one_sided_repair() {
        // ペイロード先頭だけが範囲直上(keep_top)を復唱 → 片側echo修復。
        let edits = vec![
            ins_before(2, "keep_top", 1, 0, Some(InsertMode::Replacement)),
            ins_before(2, "NEW1", 1, 1, Some(InsertMode::Replacement)),
            ins_before(2, "NEW2", 1, 2, Some(InsertMode::Replacement)),
            del(2, 1, 3),
            del(3, 1, 4),
        ];
        let result = apply_edits("keep_top\nold1\nold2\nbelow", &edits).unwrap();
        assert_eq!(result.text, "keep_top\nNEW1\nNEW2\nbelow");
        assert_eq!(result.warnings.len(), 1);
    }

    #[test]
    fn boundary_echo_ambiguous_errors() {
        // 片側echoだがペイロードが短すぎて広がった範囲の全内容になりえない → 拒否。
        let edits = vec![
            ins_before(2, "keep_top", 1, 0, Some(InsertMode::Replacement)),
            ins_before(2, "X", 1, 1, Some(InsertMode::Replacement)),
            del(2, 1, 2),
            del(3, 1, 3),
        ];
        let result = apply_edits("keep_top\nold1\nold2\nbelow", &edits);
        assert!(result.is_err());
    }
}
