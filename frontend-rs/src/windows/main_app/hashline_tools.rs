//! hashline の LITRA 統合: エピソードの grounding（読み取り→タグ→スナップショット→
//! hashline 形式出力）と hashline パッチによる編集。
//!
//! oh-my-pi の coding-agent `edit` ツール（hashline モード）と `read` ツールの grounding
//! 契約を、小説編集（エピソード）向けに移植したもの。セクションの「パス」はエピソードID。

use std::cell::RefCell;

use serde_json::{json, Value};
use wasm_bindgen::JsValue;

use crate::data::projects::{self, Episode};
use crate::hashline::format::{compute_file_hash, format_hashline_header, format_numbered_line};
use crate::hashline::input::Patch;
use crate::hashline::normalize::{normalize_to_lf, strip_bom};
use crate::hashline::patcher::{Op, Patcher};
use crate::hashline::snapshots::InMemorySnapshotStore;
use crate::runtime::invoke;

// セッション全体のハッシュラインスナップショットストア。
// WASM はシングルスレッドのため thread_local で保持する（`RefCell<State>` の借用競合を避ける）。
thread_local! {
    static STORE: RefCell<InMemorySnapshotStore> = RefCell::new(InMemorySnapshotStore::new());
}

/// エピソードIDからファイル名を引く。
fn find_file_name<'a>(episodes: &'a [Episode], episode_id: &str) -> Result<&'a str, JsValue> {
    episodes
        .iter()
        .find(|ep| ep.id == episode_id)
        .map(|ep| ep.file_name.as_str())
        .ok_or_else(|| JsValue::from_str(&format!("エピソードが見つかりません: {episode_id}")))
}

/// 正規化済みテキストとタグを計算し、スナップショットを記録する。
/// 戻り値: (normalized_text, tag, total_lines)
fn normalize_and_record(
    episode_id: &str,
    raw: &str,
    seen_lines: Option<&[u32]>,
) -> (String, String, usize) {
    let bom = strip_bom(raw);
    let normalized = normalize_to_lf(&bom.text);
    let tag = compute_file_hash(&normalized);
    let total = normalized.split('\n').count();
    STORE.with(|cell| {
        cell.borrow_mut().record(episode_id, &normalized, seen_lines);
    });
    (normalized, tag, total)
}

/// 指定行範囲を hashline 形式（`[id#TAG]` + `LINE:TEXT`）に整形する。
fn format_range(normalized: &str, tag: &str, episode_id: &str, start: u32, end: u32) -> String {
    let lines: Vec<&str> = normalized.split('\n').collect();
    let total = lines.len() as u32;
    let start = start.max(1);
    let end = end.min(total);
    let mut out = format_hashline_header(episode_id, tag);
    for n in start..=end {
        if let Some(line) = lines.get(n as usize - 1) {
            out.push('\n');
            out.push_str(&format_numbered_line(n, line));
        }
    }
    out
}

/// getEpisodeLines 相当: エピソードを行番号付き hashline 形式で読み取り、スナップショットを記録する。
pub async fn ground_episode_lines(
    project_id: &str,
    episode_id: &str,
    episodes: &[Episode],
    start_line: Option<u32>,
    end_line: Option<u32>,
) -> Result<Value, JsValue> {
    let file_name = find_file_name(episodes, episode_id)?;
    let raw = projects::read_episode(project_id, file_name).await?;

    // 一旦全文でタグを計算（seen_lines は後で確定）
    let bom = strip_bom(&raw);
    let normalized = normalize_to_lf(&bom.text);
    let tag = compute_file_hash(&normalized);
    let total = normalized.split('\n').count() as u32;

    let start = start_line.unwrap_or(1).max(1);
    let end = end_line.unwrap_or(total).min(total);
    if start > end || start > total {
        return Err(JsValue::from_str(&format!(
            "Invalid line range: startLine={start}, endLine={end}, totalLines={total}"
        )));
    }
    let seen: Vec<u32> = (start..=end).collect();
    STORE.with(|cell| {
        cell.borrow_mut().record(episode_id, &normalized, Some(&seen));
    });

    let numbered = format_range(&normalized, &tag, episode_id, start, end);
    Ok(json!({
        "episodeId": episode_id,
        "tag": tag,
        "totalLines": total,
        "startLine": start,
        "endLine": end,
        "numberedText": numbered,
    }))
}

/// findEpisodeLines 相当: エピソード内を行検索し、ヒット箇所を hashline 形式で返す。
pub async fn ground_find_episode_lines(
    project_id: &str,
    episode_id: &str,
    episodes: &[Episode],
    query: &str,
    context_lines: Option<u32>,
    max_matches: Option<usize>,
    case_sensitive: Option<bool>,
) -> Result<Value, JsValue> {
    let file_name = find_file_name(episodes, episode_id)?;
    let raw = projects::read_episode(project_id, file_name).await?;
    let (normalized, tag, total) = normalize_and_record(episode_id, &raw, None);

    let case_sensitive = case_sensitive.unwrap_or(false);
    let context = context_lines.unwrap_or(2) as usize;
    let max_matches = max_matches.unwrap_or(20);
    let lines: Vec<&str> = normalized.split('\n').collect();

    let needle = if case_sensitive {
        query.to_string()
    } else {
        query.to_lowercase()
    };

    // マッチ行を収集
    let mut match_lines: Vec<usize> = Vec::new();
    for (idx, line) in lines.iter().enumerate() {
        let hay = if case_sensitive {
            line.to_string()
        } else {
            line.to_lowercase()
        };
        if hay.contains(&needle) {
            match_lines.push(idx + 1); // 1-indexed
        }
    }

    if match_lines.is_empty() {
        return Ok(json!({
            "episodeId": episode_id,
            "tag": tag,
            "totalLines": total,
            "matches": [],
            "numberedText": format_hashline_header(episode_id, &tag),
        }));
    }

    // 上下文を含む表示範囲を計算（重複マージ）
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for &m in &match_lines {
        let lo = (m.saturating_sub(context)).max(1);
        let hi = (m + context).min(total);
        if let Some(last) = ranges.last_mut() {
            if lo <= last.1 + 1 {
                last.1 = last.1.max(hi);
                continue;
            }
        }
        ranges.push((lo, hi));
    }

    let mut seen: Vec<u32> = Vec::new();
    let mut numbered = format_hashline_header(episode_id, &tag);
    let mut matches_json: Vec<Value> = Vec::new();
    for (lo, hi) in &ranges {
        for n in *lo..=*hi {
            seen.push(n as u32);
            if let Some(line) = lines.get(n - 1) {
                numbered.push('\n');
                numbered.push_str(&format_numbered_line(n as u32, line));
            }
        }
        matches_json.push(json!({ "startLine": lo, "endLine": hi }));
        if matches_json.len() >= max_matches {
            break;
        }
    }

    STORE.with(|cell| {
        cell.borrow_mut().record(episode_id, &normalized, Some(&seen));
    });

    Ok(json!({
        "episodeId": episode_id,
        "tag": tag,
        "totalLines": total,
        "matches": matches_json,
        "numberedText": numbered,
    }))
}

/// editEpisode 相当: hashline パッチを適用し、書き込み、編集ログを追記する。
/// 成功したセクションごとに新しいタグと grounding を返す。
pub async fn apply_hashline_edit(
    project_id: &str,
    episodes: &[Episode],
    input: &str,
    reason: &str,
) -> Result<Value, JsValue> {
    let patch = Patch::parse(input).map_err(|e| JsValue::from_str(&e))?;
    if patch.sections.is_empty() {
        return Err(JsValue::from_str("Patch input did not produce any sections."));
    }

    let mut applied: Vec<Value> = Vec::new();
    let mut log_entries: Vec<Value> = Vec::new();

    for section in &patch.sections {
        let episode_id = section.path.clone();
        let file_name = find_file_name(episodes, &episode_id)?.to_string();
        let raw = projects::read_episode(project_id, &file_name).await?;

        // 同期的にパッチャを適用（ストア借用は await をまたがない）
        let outcome = STORE.with(|cell| {
            let mut store = cell.borrow_mut();
            let mut patcher = Patcher::new(&mut store, true);
            patcher.apply_section(section, &raw, true)
        });
        let outcome = match outcome {
            Ok(o) => o,
            Err(e) => return Err(JsValue::from_str(&e.to_string())),
        };

        if outcome.op == Op::Noop {
            return Err(JsValue::from_str(&format!(
                "Edits to {} resulted in no changes being made.",
                episode_id
            )));
        }

        // 書き込み
        projects::write_episode(project_id, &file_name, &outcome.persisted).await?;

        // 編集ログ（変更開始行と前後全文を記録）
        let changed_line = outcome.first_changed_line.unwrap_or(1) as usize;
        log_entries.push(json!({
            "id": crate::runtime::tauri::random_uuid(),
            "episodeId": episode_id,
            "timestamp": js_sys::Date::new_0().to_iso_string().as_string().unwrap_or_default(),
            "startLine": changed_line,
            "endLine": changed_line,
            "beforeText": outcome.before,
            "afterText": outcome.after,
            "reason": reason,
        }));

        // 変更箇所周辺を再 grounding（新しいタグでモデルが再アンカーできるように）
        let new_total = outcome.after.split('\n').count() as u32;
        let ctx_start = changed_line.saturating_sub(3).max(1) as u32;
        let ctx_end = (changed_line as u32 + 10).min(new_total);
        let seen: Vec<u32> = (ctx_start..=ctx_end).collect();
        STORE.with(|cell| {
            cell.borrow_mut().record(&episode_id, &outcome.after, Some(&seen));
        });
        let numbered = format_range(&outcome.after, &outcome.file_hash, &episode_id, ctx_start, ctx_end);

        applied.push(json!({
            "episodeId": episode_id,
            "tag": outcome.file_hash,
            "header": outcome.header,
            "firstChangedLine": outcome.first_changed_line,
            "numberedText": numbered,
            "warnings": outcome.warnings,
        }));
    }

    // 編集ログを一括追記
    if !log_entries.is_empty() {
        let _: Result<Value, _> = invoke::invoke(
            "append_edit_log",
            &json!({"req": {"projectId": project_id, "entries": log_entries}}),
        )
        .await;
    }

    let first = applied.first().cloned().unwrap_or(json!({}));
    let message = if applied.len() == 1 {
        "編集を適用しました。".to_string()
    } else {
        format!("{}件の編集を適用しました。", applied.len())
    };
    let mut result = first;
    if let Some(obj) = result.as_object_mut() {
        obj.insert("success".into(), json!(true));
        obj.insert("message".into(), json!(message));
        obj.insert("applied".into(), json!(applied));
    }
    Ok(result)
}
