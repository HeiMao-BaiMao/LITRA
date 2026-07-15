use wasm_bindgen::JsValue;
use web_sys::Document;

use super::{State, Tab};

pub fn all(document: &Document, state: &State) -> Result<(), JsValue> {
    render_list(document, state)?;
    render_chrome(document, state)?;
    render_content(document, state)
}

fn render_list(document: &Document, state: &State) -> Result<(), JsValue> {
    let Some(container) = document.get_element_by_id("genre-list") else {
        return Ok(());
    };
    let html = state.genres.iter().map(|genre| {
        let active = if state.current_genre_id.as_deref() == Some(&genre.id) { " active selected" } else { "" };
        format!(r#"<div class="nav-episode-item genre-list-item{active}" data-genre-id="{id}">
          <div class="nav-episode-title-container genre-list-title-container">
            <button type="button" class="nav-episode-title genre-list-item-name" data-action="select" data-id="{id}" title="{description}">{name}</button>
            <div class="genre-list-item-meta">資料 {sources}・知識 {knowledge}・候補 {candidates}</div>
          </div>
          <button type="button" class="nav-episode-edit genre-list-item-rename" data-action="rename" data-id="{id}" title="ジャンル名を変更">✎</button>
          <button type="button" class="nav-episode-delete genre-list-item-delete" data-action="delete" data-id="{id}" title="ジャンルを削除">×</button>
        </div>"#, id=escape(&genre.id), name=escape(if genre.name.is_empty() { "（無題）" } else { &genre.name }), description=escape(&genre.description), sources=genre.source_count, knowledge=genre.accepted_knowledge_count, candidates=genre.candidate_knowledge_count)
    }).collect::<String>();
    container.set_inner_html(&html);
    if let Some(count) = document.get_element_by_id("genre-count") {
        count.set_text_content(Some(&state.genres.len().to_string()));
    }
    Ok(())
}

fn render_chrome(document: &Document, state: &State) -> Result<(), JsValue> {
    let has_genre = state.current_genre_id.is_some();
    if let Some(title) = document.get_element_by_id("toolbar-genre-name") {
        title.set_text_content(Some(
            &state
                .genre
                .as_ref()
                .map(|genre| format!("ジャンルライブラリ / {}", genre.name))
                .unwrap_or_else(|| "ジャンルライブラリ".into()),
        ));
    }
    for (id, tab) in [
        ("tab-overview", Tab::Overview),
        ("tab-sources", Tab::Sources),
        ("tab-analysis", Tab::Analysis),
        ("tab-knowledge", Tab::Knowledge),
    ] {
        if let Some(button) = document.get_element_by_id(id) {
            button
                .class_list()
                .toggle_with_force("active", state.current_tab == tab)?;
            button.set_attribute("aria-disabled", if has_genre { "false" } else { "true" })?;
        }
    }
    for id in ["btn-import-source", "btn-open-genre-chat"] {
        if let Some(button) = document.get_element_by_id(id) {
            button.set_attribute("aria-disabled", if has_genre { "false" } else { "true" })?;
        }
    }
    if let Some(button) = document.get_element_by_id("btn-analyze-source") {
        button.set_attribute(
            "aria-disabled",
            if state.current_source_id.is_some() || !state.sources.is_empty() {
                "false"
            } else {
                "true"
            },
        )?;
    }
    Ok(())
}

fn render_content(document: &Document, state: &State) -> Result<(), JsValue> {
    let Some(container) = document.get_element_by_id("main-content") else {
        return Ok(());
    };
    let Some(genre) = state.genre.as_ref() else {
        container.set_inner_html(
            r#"<p class="empty-state">ジャンルを選択するか、新規作成してください。</p>"#,
        );
        return Ok(());
    };
    match state.current_tab {
        Tab::Overview => container.set_inner_html(&format!(r#"<form class="genre-overview-form">
          {fields}
          <div class="genre-overview-meta"><p>改訂番号: {revision}</p><p>作成日時: {created}</p><p>更新日時: {updated}</p></div>
        </form>"#, fields=[
            field("ジャンル名", "name", &genre.name, false), field("別名（カンマ区切り）", "aliases", &genre.aliases.join(", "), false),
            field("説明", "description", &genre.description, true), field("ユーザー定義", "userDefinition", &genre.user_definition, true),
            field("補足メモ", "notes", &genre.notes, true), field("タグ（カンマ区切り）", "tags", &genre.tags.join(", "), false),
        ].join(""), revision=genre.revision, created=escape(&genre.created_at), updated=escape(&genre.updated_at))),
        Tab::Sources => {
            let rows = state.sources.iter().map(|source| format!(r#"<div class="source-list-item" data-action="choose-source" data-id="{id}">
              <div class="source-list-item-title">{title}</div><div class="source-list-item-meta">{role} · {kind} · {chars}文字 · {segments}セグメント · {status}</div>
              <div class="source-list-item-actions"><button data-action="view-source" data-id="{id}">表示</button><button data-action="delete-source" data-id="{id}">削除</button></div></div>"#,
              id=escape(&source.id), title=escape(&source.title), role=escape(&source.source_role), kind=escape(&source.source_type), chars=source.character_count, segments=source.segment_count, status=escape(&source.analysis_status))).collect::<String>();
            container.set_inner_html(&format!(r#"<div class="source-list-header"><button data-action="import-source">＋ 資料を追加</button></div>{rows}"#));
        }
        Tab::Analysis => {
            let source = state.current_source_id.as_ref().and_then(|id| state.sources.iter().find(|source| &source.id == id)).or_else(|| state.sources.first());
            container.set_inner_html(&source.map(|source| format!(r#"<section class="analysis-review"><h3>{}</h3><p>状態: {}</p><button data-action="analyze-source" data-id="{}">この資料を分析</button><div id="rust-analysis-result"></div></section>"#, escape(&source.title), escape(&source.analysis_status), escape(&source.id))).unwrap_or_else(|| r#"<p class="empty-state">資料をインポートしてください。</p>"#.into()));
        }
        Tab::Knowledge => {
            let Some(knowledge) = state.knowledge.as_ref() else { container.set_inner_html(""); return Ok(()); };
            let candidates = knowledge.candidates.iter().filter(|item| item.status == "pending").map(|item| format!(r#"<div class="knowledge-candidate"><div class="knowledge-candidate-header"><span class="knowledge-category">{category}</span><span class="knowledge-title">{title}</span><span class="knowledge-importance">{importance}</span></div><p class="knowledge-statement">{statement}</p><p class="knowledge-explanation">{explanation}</p><div class="knowledge-actions"><button data-action="accept-candidate" data-id="{id}">採用</button><button data-action="hold-candidate" data-id="{id}">保留</button><button data-action="reject-candidate" data-id="{id}">却下</button></div></div>"#, category=escape(&item.category), title=escape(&item.title), importance=escape(&item.proposed_importance), statement=escape(&item.statement), explanation=escape(&item.explanation), id=escape(&item.id))).collect::<String>();
            let items = knowledge.items.iter().map(|item| format!(r#"<div class="knowledge-item {disabled}"><div class="knowledge-item-header"><span class="knowledge-category">{category}</span><span class="knowledge-title">{title}</span><span class="knowledge-importance">{importance}</span><span class="knowledge-status">{status}</span></div><p class="knowledge-statement">{statement}</p><p class="knowledge-explanation">{explanation}</p><div class="knowledge-actions"><button data-action="edit-knowledge" data-id="{id}">編集</button><button data-action="toggle-knowledge" data-id="{id}" data-status="{next}">{toggle}</button><button data-action="delete-knowledge" data-id="{id}">削除</button></div></div>"#, disabled=if item.status == "disabled" { "disabled" } else { "" }, category=escape(&item.category), title=escape(&item.title), importance=escape(&item.importance), status=escape(&item.status), statement=escape(&item.statement), explanation=escape(&item.explanation), id=escape(&item.id), next=if item.status == "active" { "disabled" } else { "active" }, toggle=if item.status == "active" { "無効化" } else { "再有効化" })).collect::<String>();
            container.set_inner_html(&format!(r#"<div class="knowledge-header"><button data-action="create-knowledge">＋ 手動で知識を追加</button></div><div class="knowledge-section"><h4>未確認候補</h4>{candidates}</div><div class="knowledge-section"><h4>採用済み知識</h4>{items}</div>"#));
        }
    }
    Ok(())
}

fn field(label: &str, name: &str, value: &str, multiline: bool) -> String {
    let control = if multiline {
        format!(
            r#"<textarea class="genre-form-input" data-genre-field="{name}">{}</textarea>"#,
            escape(value)
        )
    } else {
        format!(
            r#"<input class="genre-form-input" data-genre-field="{name}" value="{}">"#,
            escape(value)
        )
    };
    format!(r#"<label class="genre-form-label"><span>{label}</span>{control}</label>"#)
}

pub fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
