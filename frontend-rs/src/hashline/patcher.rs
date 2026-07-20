//! hashline パッチのオーケストレーション。oh-my-pi `patcher.ts` の移植
//! （ブロック解決と REM/MV ファイル操作、パス回復を省略）。
//!
//! LITRA のエピソード I/O は非同期（Tauri invoke）のため、TS 版のように Filesystem を
//! 介して読み書きせず、呼び出し側が読み込んだ raw テキストを受け取り、適用結果
//! （永続化済みテキスト + 新タグ）を返す形にする。タグ検証・seen-line ガード・
//! ドリフト回復・all-or-nothing の核心ロジックは TS と同一。

use crate::hashline::apply::apply_edits;
use crate::hashline::format::{compute_file_hash, format_hashline_header, format_numbered_line};
use crate::hashline::input::PatchSection;
use crate::hashline::messages::{
    self, HEADTAIL_DRIFT_WARNING, SEEN_LINE_REVEAL_CAP, SEEN_LINE_REVEAL_MAX_COLUMNS,
};
use crate::hashline::mismatch::{compress_ranges, MismatchError};
use crate::hashline::normalize::{detect_line_ending, normalize_to_lf, restore_line_endings, strip_bom};
use crate::hashline::recovery::{Recovery, RecoveryArgs};
use crate::hashline::snapshots::{InMemorySnapshotStore, Snapshot};
use crate::hashline::types::ApplyResult;

/// 適用操作の種類。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    Create,
    Update,
    Noop,
}

/// 1セクションの適用結果。
#[derive(Clone, Debug)]
pub struct SectionResult {
    pub path: String,
    /// 正規化済み（LF, BOM なし）の元テキスト。
    pub before: String,
    /// 正規化済みの新テキスト。
    pub after: String,
    /// BOM + 改行コード復元済みの永続化テキスト。
    pub persisted: String,
    /// 新しいスナップショットタグ。
    pub file_hash: String,
    /// 新しいセクションヘッダ `[path#newhash]`。
    pub header: String,
    pub first_changed_line: Option<u32>,
    pub warnings: Vec<String>,
    pub op: Op,
}

/// パッチャのエラー。タグ不一致は構造化された [`MismatchError`]、それ以外は文字列。
#[derive(Debug)]
pub enum PatcherError {
    Mismatch(MismatchError),
    Other(String),
}

impl std::fmt::Display for PatcherError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PatcherError::Mismatch(e) => write!(f, "{}", e.display_message()),
            PatcherError::Other(s) => write!(f, "{}", s),
        }
    }
}

/// hashline パッチャ。スナップショットストアを借りてタグ検証・回復・記録を行う。
pub struct Patcher<'a> {
    store: &'a mut InMemorySnapshotStore,
    enforce_seen_lines: bool,
}

impl<'a> Patcher<'a> {
    pub fn new(store: &'a mut InMemorySnapshotStore, enforce_seen_lines: bool) -> Self {
        Self {
            store,
            enforce_seen_lines,
        }
    }

    /// 1セクションを適用する。`raw_content` は読み込んだままのテキスト
    /// （BOM/CRLF を含んでよい）、`exists` はファイルが存在するか。
    pub fn apply_section(
        &mut self,
        section: &PatchSection,
        raw_content: &str,
        exists: bool,
    ) -> Result<SectionResult, PatcherError> {
        let parsed = section.parse().map_err(PatcherError::Other)?;
        let parse_warnings = parsed.warnings.clone();
        let edits = parsed.edits;

        // タグ必須
        if section.file_hash.is_none() {
            return Err(PatcherError::Other(messages::missing_snapshot_tag_message(
                &section.path,
            )));
        }

        if !exists {
            return Err(PatcherError::Other(format!(
                "File not found: {}. Use the write tool to create new files.",
                section.path
            )));
        }

        let bom = strip_bom(raw_content);
        let line_ending = detect_line_ending(&bom.text);
        let normalized = normalize_to_lf(&bom.text);

        let apply_result =
            self.apply_with_recovery(section, &normalized, exists, &edits)?;

        let mut warnings = parse_warnings;
        warnings.extend(apply_result.warnings.iter().cloned());

        let after = apply_result.text;
        let op = if after == normalized {
            Op::Noop
        } else {
            Op::Update
        };

        // 新しいタグを記録（正規化済みテキストでキー化する）
        let file_hash = self.store.record(&section.path, &after, None);
        let header = format_hashline_header(&section.path, &file_hash);
        let persisted = format!("{}{}", bom.bom, restore_line_endings(&after, line_ending));

        Ok(SectionResult {
            path: section.path.clone(),
            before: normalized,
            after,
            persisted,
            file_hash,
            header,
            first_changed_line: apply_result.first_changed_line,
            warnings,
            op,
        })
    }

    /// タグ検証の判定ツリー（核心）。TS `#applyWithRecovery`。
    fn apply_with_recovery(
        &mut self,
        section: &PatchSection,
        normalized: &str,
        exists: bool,
        edits: &[crate::hashline::types::Edit],
    ) -> Result<ApplyResult, PatcherError> {
        let expected: Option<String> = if exists {
            section.file_hash.clone()
        } else {
            None
        };
        let live_matches = expected
            .as_ref()
            .map_or(false, |h| compute_file_hash(normalized) == *h);

        // ライブ内容に一致するスナップショット（seen-line 来歴の取得元）
        let matched_snapshot: Option<Snapshot> = if live_matches {
            self.store
                .by_content(&section.path, normalized)
                .cloned()
        } else {
            None
        };

        // 1. タグなし、またはタグがライブ内容と一致
        if expected.is_none() || live_matches {
            if let Some(tag) = expected.as_ref() {
                if self.enforce_seen_lines {
                    self.assert_seen_lines(section, tag, matched_snapshot.as_ref())?;
                }
            }
            return apply_edits(normalized, edits).map_err(PatcherError::Other);
        }

        let expected_tag = expected.clone().unwrap_or_default();

        // 2. HEAD/TAIL のみ（アンカー指定なし）→ 位置は内容非依存なのでそのまま適用
        let has_anchor = section
            .has_anchor_scoped_edit()
            .map_err(PatcherError::Other)?;
        if !has_anchor {
            let mut result = apply_edits(normalized, edits).map_err(PatcherError::Other)?;
            let mut warnings = vec![HEADTAIL_DRIFT_WARNING.to_string()];
            warnings.append(&mut result.warnings);
            result.warnings = warnings;
            return Ok(result);
        }

        // 3. ドリフト + アンカー指定あり → リカバリを試みる
        let recovery = Recovery::new(self.store);
        let recovered = recovery.try_recover(RecoveryArgs {
            path: section.path.clone(),
            current_text: normalized.to_string(),
            file_hash: expected_tag.clone(),
            edits,
        });
        if let Some(result) = recovered {
            return Ok(ApplyResult {
                text: result.text,
                first_changed_line: result.first_changed_line,
                warnings: result.warnings,
            });
        }

        // リカバリ失敗 → mismatch エラー
        let hash_recognized = self.store.by_hash(&section.path, &expected_tag).is_some();
        let file_lines: Vec<String> = normalized.split('\n').map(String::from).collect();
        let anchor_lines = section
            .collect_anchor_lines()
            .map_err(PatcherError::Other)?;
        Err(PatcherError::Mismatch(MismatchError::new(
            Some(section.path.clone()),
            expected_tag,
            compute_file_hash(normalized),
            file_lines,
            anchor_lines,
            hash_recognized,
        )))
    }

    /// seen-line 来歴ガード。read で表示していない行への編集を拒否する。TS `#assertSeenLines`。
    fn assert_seen_lines(
        &mut self,
        section: &PatchSection,
        tag: &str,
        matched_snapshot: Option<&Snapshot>,
    ) -> Result<(), PatcherError> {
        let seen = match matched_snapshot.and_then(|s| s.seen_lines.as_ref()) {
            Some(seen) if !seen.is_empty() => seen.clone(),
            _ => return Ok(()), // 来歴未記録 → 検査スキップ
        };

        let anchor_lines = section
            .collect_anchor_lines()
            .map_err(PatcherError::Other)?;
        let unseen: Vec<u32> = anchor_lines
            .into_iter()
            .filter(|l| !seen.contains(l))
            .collect();
        if unseen.is_empty() {
            return Ok(());
        }

        // 実際のファイル内容を unseen 行について表示する
        let source_lines: Vec<String> = matched_snapshot
            .map(|s| s.text.split('\n').map(String::from).collect())
            .unwrap_or_default();
        let mut revealed: Vec<(u32, String)> = Vec::new();
        let mut column_truncated = false;
        for &line in unseen.iter().take(SEEN_LINE_REVEAL_CAP) {
            if line < 1 || line as usize > source_lines.len() {
                continue;
            }
            let text = &source_lines[line as usize - 1];
            if text.chars().count() > SEEN_LINE_REVEAL_MAX_COLUMNS {
                let truncated: String = text.chars().take(SEEN_LINE_REVEAL_MAX_COLUMNS).collect();
                revealed.push((line, format!("{}…", truncated)));
                column_truncated = true;
            } else {
                revealed.push((line, text.clone()));
            }
        }
        let truncated = unseen.len() > revealed.len() || column_truncated;

        // 截断されていない（全 unseen 行が全幅で表示された）場合のみ seen に統合
        // （再試行が再読み取りなしで成功する）。截断ありは部分公開バイパスを防ぐため統合しない。
        if !truncated {
            let lines: Vec<u32> = revealed.iter().map(|(n, _)| *n).collect();
            self.store.record_seen_lines(&section.path, tag, &lines);
        }

        Err(PatcherError::Other(unseen_lines_message(
            &section.path,
            &unseen,
            tag,
            &revealed,
            truncated,
        )))
    }
}

/// seen-line ガードの拒否メッセージを構築する。
fn unseen_lines_message(
    path: &str,
    unseen: &[u32],
    tag: &str,
    revealed: &[(u32, String)],
    truncated: bool,
) -> String {
    let ranges = compress_ranges(unseen);
    let selector = ranges.replace(", ", ",");
    let mut msg = format!(
        "This edit anchors to lines {} of {} that [{}#{}] never displayed (it showed a partial range, a search hit, or a folded summary).",
        ranges, path, path, tag
    );
    if revealed.is_empty() {
        msg.push_str(&format!(
            " Re-read them in full first with a ranged read like `{}:{}` — it skips summarization and mints a fresh tag (a plain re-read just re-folds them) — then re-issue the edit.",
            path, selector
        ));
    } else {
        let body: String = revealed
            .iter()
            .map(|(n, text)| format_numbered_line(*n, text))
            .collect::<Vec<_>>()
            .join("\n");
        if truncated {
            msg.push_str(&format!(
                " Preview of the actual file content at the first {} unseen line(s):\n{}\nThe range exceeds the inline preview cap — re-read the remainder with `{}:{}` before re-issuing the edit.",
                revealed.len(),
                body,
                path,
                selector
            ));
        } else {
            msg.push_str(&format!(
                " Actual file content at those lines:\n{}\nVerify the content matches what you intend to touch, then re-issue the edit with the same [{}#{}] header — a straight retry now succeeds without a re-read. If the content does NOT match, fix your line numbers.",
                body, path, tag
            ));
        }
    }
    msg
}
