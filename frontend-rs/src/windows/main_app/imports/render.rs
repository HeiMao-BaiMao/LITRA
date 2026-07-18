use wasm_bindgen::JsValue;
use web_sys::Document;

use super::model::{Candidate, ImportResult, SourceFile};
use super::review::ReviewResult;

pub fn loading(document: &Document, message: &str) -> Result<(), JsValue> {
    show(document)?;
    set_title(document, "フォルダ取り込み");
    if let Some(list) = document.get_element_by_id("import-preview-list") {
        list.set_inner_html(&format!(
            r#"<div class="import-preview-loading">{}</div>"#,
            escape(message)
        ));
    }
    Ok(())
}

pub fn preview(
    document: &Document,
    files: &[SourceFile],
    candidates: &[Candidate],
    settings_only: bool,
) -> Result<(), JsValue> {
    show(document)?;
    set_title(document, "フォルダ取り込みプレビュー");
    let rows = files
        .iter()
        .zip(candidates)
        .enumerate()
        .map(|(index, (file, candidate))| {
            let options = types(settings_only)
                .iter()
                .map(|(value, label)| format!(r#"<option value="{}" {}>{}</option>"#, value, if *value == candidate.file_type { "selected" } else { "" }, label))
                .collect::<String>();
            format!(r#"<div class="import-preview-detail"><select data-import-type="{index}">{options}</select> <strong>{}</strong> → {}<div class="project-list-meta">{}</div></div>"#, escape(&file.path), escape(&candidate.title), escape(&candidate.reason))
        })
        .collect::<String>();
    let visible = candidates
        .iter()
        .filter(|candidate| candidate.file_type != "ignore")
        .count();
    if let Some(list) = document.get_element_by_id("import-preview-list") {
        list.set_inner_html(&format!(
            r#"<div class="import-preview-summary">取り込み対象: {visible} 件 / 検出: {} 件</div>{rows}"#,
            candidates.len()
        ));
    }
    Ok(())
}

pub fn result(document: &Document, result: &ImportResult) -> Result<(), JsValue> {
    set_title(document, "取り込み結果");
    let mut rows = vec![
        format!("キャラクター: {} 件", result.characters),
        format!("世界観: {} 件", result.world_entries),
        format!("エピソード: {} 件", result.episodes),
        format!("覚え書き: {} 件", result.memos),
        format!("作品メモ: {} 件", result.project_memos),
        format!("人間関係: {} 件", result.relationships),
    ];
    if result.skipped_memos > 0 {
        rows.push(format!("未接続の覚え書き: {} 件", result.skipped_memos));
    }
    if result.skipped_relationships > 0 {
        rows.push(format!(
            "未接続の人間関係: {} 件",
            result.skipped_relationships
        ));
    }
    if let Some(list) = document.get_element_by_id("import-preview-list") {
        list.set_inner_html(&format!(
            r#"<div class="import-preview-summary">取り込みが完了しました。</div>{}"#,
            rows.into_iter()
                .map(|row| format!(r#"<div class="import-preview-row">{}</div>"#, escape(&row)))
                .collect::<String>()
        ));
    }
    Ok(())
}

pub fn result_with_review(
    document: &Document,
    result_value: &ImportResult,
    review: &ReviewResult,
) -> Result<(), JsValue> {
    result(document, result_value)?;
    let rows = [
        ("更新されたキャラクター", review.updated_characters),
        ("更新された世界観", review.updated_world_entries),
        ("追加された人間関係", review.created_relationships),
        ("追加された作品メモ", review.created_project_memos),
        ("更新された覚え書き", review.updated_episode_memos),
    ];
    if let Some(list) = document.get_element_by_id("import-preview-list") {
        let details = rows
            .iter()
            .filter(|(_, count)| *count > 0)
            .map(|(label, count)| {
                format!(r#"<div class="import-preview-row">{label}: {count} 件</div>"#)
            })
            .collect::<String>();
        list.insert_adjacent_html(
            "beforeend",
            &format!(
                r#"<div class="import-preview-summary">整合性チェックによる修正:</div>{}"#,
                if details.is_empty() {
                    r#"<div class="import-preview-row">修正はありませんでした。</div>"#.into()
                } else {
                    details
                }
            ),
        )?;
    }
    Ok(())
}

pub fn show(document: &Document) -> Result<(), JsValue> {
    toggle(document, false)
}
pub fn hide(document: &Document) -> Result<(), JsValue> {
    toggle(document, true)
}
fn toggle(document: &Document, hidden: bool) -> Result<(), JsValue> {
    if let Some(modal) = document.get_element_by_id("import-preview-modal") {
        modal.class_list().toggle_with_force("hidden", hidden)?;
    }
    Ok(())
}
fn set_title(document: &Document, title: &str) {
    if let Some(element) = document.get_element_by_id("import-preview-title") {
        element.set_text_content(Some(title));
    }
}
fn types(settings_only: bool) -> &'static [(&'static str, &'static str)] {
    if settings_only {
        &[
            ("character", "キャラクター"),
            ("world", "世界観"),
            ("relationship", "人間関係"),
            ("ignore", "対象外"),
        ]
    } else {
        &[
            ("character", "キャラクター"),
            ("world", "世界観"),
            ("episode", "エピソード"),
            ("memo", "覚え書き"),
            ("projectMemo", "作品メモ"),
            ("relationship", "人間関係"),
            ("ignore", "対象外"),
        ]
    }
}
fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
