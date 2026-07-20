//! 古くなったセクションタグの回復。oh-my-pi `recovery.ts` の移植。
//!
//! すべてのアンカー行が現在のファイル内の1つの「変更なし・連続」領域へまだマップ
//! できることを証明し、そのライブ内容に対して編集を再生することで回復する。
//! 対象が変更・曖昧化された場合は閉じて失敗し、パッチャは推測する代わりに新鮮な
//! 文脈付きの mismatch を返す。
//!
//! ラインマップ（変更なし行の previous→current 対応）の構築に `similar` クレートを
//! 使う（TS の `Diff.diffArrays` 相当）。

use std::collections::{HashMap, HashSet};

use similar::{ChangeTag, TextDiff};

use crate::hashline::apply::apply_edits;
use crate::hashline::messages::{
    RECOVERY_EXTERNAL_WARNING, RECOVERY_LINE_REMAP_WARNING, RECOVERY_SESSION_CHAIN_WARNING,
};
use crate::hashline::snapshots::InMemorySnapshotStore;
use crate::hashline::types::{Anchor, Cursor, Edit};

/// [`Recovery::try_recover`] の引数。
pub struct RecoveryArgs<'a> {
    pub path: String,
    pub current_text: String,
    pub file_hash: String,
    pub edits: &'a [Edit],
}

/// 回復の結果。
pub struct RecoveryResult {
    /// 回復後の本文。
    pub text: String,
    /// ライブな `current_text` に対する変更最初の行（1-indexed）。なければ `None`。
    pub first_changed_line: Option<u32>,
    /// ユーザ向け回復バナーを含む、回復中に収集した警告。
    pub warnings: Vec<String>,
}

/// [`InMemorySnapshotStore`] 上のステートレスな回復ドライバ。一度生成し、
/// 古タグ事象ごとに [`Recovery::try_recover`] を呼ぶ。
pub struct Recovery<'a> {
    store: &'a InMemorySnapshotStore,
}

impl<'a> Recovery<'a> {
    pub fn new(store: &'a InMemorySnapshotStore) -> Recovery<'a> {
        Recovery { store }
    }

    /// 回復を試みる。道が見つからなければ `None` — 呼び出し側は [`MismatchError`]
    /// を提示すべき。
    pub fn try_recover(&self, args: RecoveryArgs) -> Option<RecoveryResult> {
        let RecoveryArgs {
            path,
            current_text,
            file_hash,
            edits,
        } = args;
        // 保持テキストが16-bitタグで衝突した場合は最新のものを使う。回復には依然として
        // アンカーと文脈が曖昧なくマップできることが要る。
        let snapshot = self.store.by_hash(&path, &file_hash)?;
        let snapshot_text = snapshot.text.clone();
        // head と同じテキスト（= 外部変更でドリフト）か、セッションチェーンの旧版本か。
        let recovery_warning =
            if self.store.head(&path).map(|s| s.text.as_str()) == Some(snapshot_text.as_str()) {
                RECOVERY_EXTERNAL_WARNING
            } else {
                RECOVERY_SESSION_CHAIN_WARNING
            };
        replay_remapped_anchors_on_current(&snapshot_text, &current_text, edits, recovery_warning)
    }
}

/// 編集列からすべてのアンカー行番号を収集する（BOF/EOF 挿入は寄与しない）。
fn collect_anchor_lines(edits: &[Edit]) -> Vec<u32> {
    let mut lines = Vec::new();
    for edit in edits {
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
            Edit::Insert { cursor: Cursor::Bof, .. } | Edit::Insert { cursor: Cursor::Eof, .. } => {}
        }
    }
    lines
}

/// 変更なしの previous 行番号を、それぞれ現在の行番号へマップする。
/// `similar::TextDiff::from_lines` による LCS ライン差分を使う（TS: `buildLineMap`）。
fn build_line_map(previous_text: &str, current_text: &str) -> HashMap<u32, u32> {
    let diff = TextDiff::from_lines(previous_text, current_text);
    let mut map = HashMap::new();
    let mut previous_line: u32 = 1;
    let mut current_line: u32 = 1;
    for change in diff.iter_all_changes() {
        match change.tag() {
            ChangeTag::Insert => {
                current_line += 1;
            }
            ChangeTag::Delete => {
                previous_line += 1;
            }
            ChangeTag::Equal => {
                map.insert(previous_line, current_line);
                previous_line += 1;
                current_line += 1;
            }
        }
    }
    map
}

/// `lines` の中で2回以上現れる値の集合（O(1) 重複チェック用）。TS: `collectDuplicatedValues`。
fn collect_duplicated_values(lines: &[String]) -> HashSet<String> {
    let mut seen = HashSet::new();
    let mut duplicated = HashSet::new();
    for value in lines {
        if !seen.insert(value.clone()) {
            duplicated.insert(value.clone());
        }
    }
    duplicated
}

/// あるアンカーの、アンカーでない最近傍の文脈行（ファイル端では `None`）。
#[derive(Clone, Copy)]
struct AnchorNeighbors {
    /// アンカーランの直下（小さい行番号側）の非アンカー行。
    before: Option<u32>,
    /// アンカーランの直上（大きい行番号側）の非アンカー行。
    after: Option<u32>,
}

/// すべてのアンカーについて、両側の最近傍非アンカー文脈行を1走査で計算する。
/// 1つの連続ラン内のアンカーは両近傍を共有する（ランのすぐ外側の行）。TS: `computeAnchorNeighbors`。
fn compute_anchor_neighbors(
    anchor_lines: &HashSet<u32>,
    line_count: u32,
) -> HashMap<u32, AnchorNeighbors> {
    let mut sorted: Vec<u32> = anchor_lines.iter().copied().collect();
    sorted.sort_unstable();
    let mut neighbors = HashMap::new();
    let mut i = 0usize;
    while i < sorted.len() {
        let mut j = i;
        while j + 1 < sorted.len() && sorted[j + 1] == sorted[j] + 1 {
            j += 1;
        }
        let start = sorted[i];
        let end = sorted[j];
        let before = if start >= 2 && start - 1 <= line_count {
            Some(start - 1)
        } else {
            None
        };
        let after = if end + 1 <= line_count { Some(end + 1) } else { None };
        for k in i..=j {
            neighbors.insert(sorted[k], AnchorNeighbors { before, after });
        }
        i = j + 1;
    }
    neighbors
}

/// 重複文脈（アンカー行テキストがファイル内で重複）の検証。各近傍について、
/// ラインマップが一定オフセットで整合することを要し、少なくとも1つの近傍を検査する。
/// TS: `validateDuplicateAnchorContext`。
fn validate_duplicate_anchor_context(
    line: u32,
    mapped: u32,
    neighbors: AnchorNeighbors,
    line_map: &HashMap<u32, u32>,
) -> bool {
    let mut checked = false;
    if let Some(before) = neighbors.before {
        checked = true;
        let expected = i64::from(mapped) - (i64::from(line) - i64::from(before));
        if line_map.get(&before).map(|&v| i64::from(v)) != Some(expected) {
            return false;
        }
    }
    if let Some(after) = neighbors.after {
        checked = true;
        let expected = i64::from(mapped) + (i64::from(after) - i64::from(line));
        if line_map.get(&after).map(|&v| i64::from(v)) != Some(expected) {
            return false;
        }
    }
    checked
}

/// 一意文脈（アンカー行テキストが両ファイルで一意）の検証。一定オフセットで
/// 直後(after) または直前(before) の近傍が整合すれば合格。TS: `validateUniqueAnchorContext`。
fn validate_unique_anchor_context(
    line: u32,
    mapped: u32,
    neighbors: AnchorNeighbors,
    line_map: &HashMap<u32, u32>,
) -> bool {
    let offset = i64::from(mapped) - i64::from(line);
    if let Some(after) = neighbors.after {
        if line_map.get(&after).map(|&v| i64::from(v)) == Some(i64::from(after) + offset) {
            return true;
        }
    }
    if let Some(before) = neighbors.before {
        if line_map.get(&before).map(|&v| i64::from(v)) == Some(i64::from(before) + offset) {
            return true;
        }
    }
    false
}

/// リマップされたアンカーの周囲文脈が、現在のファイルで一意かつ連続に整合するか検証する。
/// TS: `validateRemappedAnchorContext`。
fn validate_remapped_anchor_context(
    previous_lines: &[String],
    current_lines: &[String],
    line_map: &HashMap<u32, u32>,
    edits: &[Edit],
) -> bool {
    let anchor_lines: HashSet<u32> = collect_anchor_lines(edits).into_iter().collect();
    let duplicated_previous = collect_duplicated_values(previous_lines);
    let duplicated_current = collect_duplicated_values(current_lines);
    let anchor_neighbors = compute_anchor_neighbors(&anchor_lines, previous_lines.len() as u32);

    for (&line, &neighbors) in &anchor_neighbors {
        let Some(&mapped) = line_map.get(&line) else {
            return false;
        };
        let prev_duplicated = previous_lines
            .get((line - 1) as usize)
            .map(|value| duplicated_previous.contains(value))
            .unwrap_or(false);
        let cur_duplicated = current_lines
            .get((mapped - 1) as usize)
            .map(|value| duplicated_current.contains(value))
            .unwrap_or(false);
        if !prev_duplicated && !cur_duplicated {
            if !validate_unique_anchor_context(line, mapped, neighbors, line_map) {
                return false;
            }
        } else if !validate_duplicate_anchor_context(line, mapped, neighbors, line_map) {
            return false;
        }
    }
    true
}

/// リマップ結果: 再生可能な編集列と、全アンカーに共通の移動オフセット。
struct RemappedEdits {
    edits: Vec<Edit>,
    offset: i64,
}

/// 編集のアンカーを previous から current へリマップする。すべてのアンカーが1つの
/// 一定オフセットで移動でき、文脈検証を通過する場合のみ `Some`。TS: `remapEditsToCurrent`。
fn remap_edits_to_current(
    previous_text: &str,
    current_text: &str,
    edits: &[Edit],
) -> Option<RemappedEdits> {
    let previous_lines: Vec<String> = previous_text.split('\n').map(String::from).collect();
    let current_lines: Vec<String> = current_text.split('\n').map(String::from).collect();
    let line_map = build_line_map(previous_text, current_text);
    if !validate_remapped_anchor_context(&previous_lines, &current_lines, &line_map, edits) {
        return None;
    }

    let mut offsets: Vec<i64> = Vec::new();
    let mut remapped: Vec<Edit> = Vec::new();

    /// 1行をラインマップで変換し、オフセットを記録する。未マップなら `None`。
    fn map_line(line_map: &HashMap<u32, u32>, offsets: &mut Vec<i64>, line: u32) -> Option<u32> {
        let mapped = *line_map.get(&line)?;
        offsets.push(i64::from(mapped) - i64::from(line));
        Some(mapped)
    }

    for edit in edits {
        match edit {
            Edit::Delete {
                anchor,
                line_num,
                index,
            } => {
                let mapped = map_line(&line_map, &mut offsets, anchor.line)?;
                remapped.push(Edit::Delete {
                    anchor: Anchor::new(mapped),
                    line_num: *line_num,
                    index: *index,
                });
            }
            Edit::Insert {
                cursor,
                text,
                line_num,
                index,
                mode,
            } => {
                let new_cursor = match cursor {
                    Cursor::BeforeAnchor { anchor } => {
                        let mapped = map_line(&line_map, &mut offsets, anchor.line)?;
                        Cursor::BeforeAnchor {
                            anchor: Anchor::new(mapped),
                        }
                    }
                    Cursor::AfterAnchor { anchor } => {
                        let mapped = map_line(&line_map, &mut offsets, anchor.line)?;
                        Cursor::AfterAnchor {
                            anchor: Anchor::new(mapped),
                        }
                    }
                    Cursor::Bof => Cursor::Bof,
                    Cursor::Eof => Cursor::Eof,
                };
                remapped.push(Edit::Insert {
                    cursor: new_cursor,
                    text: text.clone(),
                    line_num: *line_num,
                    index: *index,
                    mode: *mode,
                });
            }
        }
    }

    if offsets.is_empty() {
        return None;
    }
    let first_offset = offsets[0];
    if !offsets.iter().all(|&offset| offset == first_offset) {
        return None;
    }
    Some(RemappedEdits {
        edits: remapped,
        offset: first_offset,
    })
}

/// リマップ済みアンカーを現在のテキスト上で再生する。適用が失敗・no-op なら `None`
/// （閉じて失敗）。TS: `replayRemappedAnchorsOnCurrent`。
fn replay_remapped_anchors_on_current(
    previous_text: &str,
    current_text: &str,
    edits: &[Edit],
    recovery_warning: &str,
) -> Option<RecoveryResult> {
    let remapped = remap_edits_to_current(previous_text, current_text, edits)?;
    let applied = apply_edits(current_text, &remapped.edits).ok()?;
    if applied.text == current_text {
        return None;
    }
    let banner = if remapped.offset == 0 {
        recovery_warning.to_string()
    } else {
        RECOVERY_LINE_REMAP_WARNING.to_string()
    };
    let mut warnings = vec![banner];
    warnings.extend(applied.warnings);
    Some(RecoveryResult {
        text: applied.text,
        first_changed_line: applied.first_changed_line,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hashline::messages::RECOVERY_LINE_REMAP_WARNING;

    #[test]
    fn build_line_map_maps_unchanged_lines() {
        // previous: a b c ; current: a X b c （a の後に X 挿入）
        let map = build_line_map("a\nb\nc", "a\nX\nb\nc");
        assert_eq!(map.get(&1), Some(&1)); // a → 1
        assert_eq!(map.get(&2), Some(&3)); // b → 3
        assert_eq!(map.get(&3), Some(&4)); // c → 4
    }

    #[test]
    fn build_line_map_handles_deletion() {
        // previous: a b c ; current: a c （b 削除）
        let map = build_line_map("a\nb\nc", "a\nc");
        assert_eq!(map.get(&1), Some(&1)); // a → 1
        assert_eq!(map.get(&2), None); // b は削除済み → 未マップ
        assert_eq!(map.get(&3), Some(&2)); // c → 2
    }

    #[test]
    fn recovery_remaps_anchored_edit_after_external_insert() {
        // スナップショット(previous)に対し、current は line1 の後に1行挿入済み。
        // line2 锚の削除編集が line3 へリマップされて成功する。
        let mut store = InMemorySnapshotStore::new();
        let previous = "line1\nline2\nline3";
        let tag = store.record("f.txt", previous, None);
        let current = "line1\nINSERTED\nline2\nline3";
        let edits = vec![Edit::Delete {
            anchor: Anchor::new(2),
            line_num: 1,
            index: 0,
        }];

        let recovery = Recovery::new(&store);
        let result = recovery
            .try_recover(RecoveryArgs {
                path: "f.txt".to_string(),
                current_text: current.to_string(),
                file_hash: tag,
                edits: &edits,
            })
            .expect("recovery should succeed");

        // current の line3 ("line2") が削除される。
        assert_eq!(result.text, "line1\nINSERTED\nline3");
        assert_eq!(result.first_changed_line, Some(3));
        // オフセット +1（≠0）なのでリマップ警告。
        assert_eq!(result.warnings.first().map(String::as_str), Some(RECOVERY_LINE_REMAP_WARNING));
    }

    #[test]
    fn recovery_fails_closed_when_anchor_changed() {
        // 锚の行テキストそのものが変わっていると文脈検証が失敗し None。
        let mut store = InMemorySnapshotStore::new();
        let previous = "alpha\nbeta\ngamma";
        let tag = store.record("f.txt", previous, None);
        // beta が BETA に置換された current（行2の内容変化）。
        let current = "alpha\nBETA\ngamma";
        let edits = vec![Edit::Delete {
            anchor: Anchor::new(2),
            line_num: 1,
            index: 0,
        }];

        let recovery = Recovery::new(&store);
        let result = recovery.try_recover(RecoveryArgs {
            path: "f.txt".to_string(),
            current_text: current.to_string(),
            file_hash: tag,
            edits: &edits,
        });
        assert!(result.is_none());
    }

    #[test]
    fn recovery_returns_none_for_unknown_hash() {
        let store = InMemorySnapshotStore::new();
        let edits = vec![Edit::Delete {
            anchor: Anchor::new(1),
            line_num: 1,
            index: 0,
        }];
        let recovery = Recovery::new(&store);
        let result = recovery.try_recover(RecoveryArgs {
            path: "missing.txt".to_string(),
            current_text: "x".to_string(),
            file_hash: "0000".to_string(),
            edits: &edits,
        });
        assert!(result.is_none());
    }
}
