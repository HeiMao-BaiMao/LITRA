use wasm_bindgen::{JsCast, JsValue};
use web_sys::{Document, HtmlTextAreaElement};

use super::{memo, summary, State};

pub fn all(document: &Document, state: &State) -> Result<(), JsValue> {
    projects(document, state)?;
    episodes(document, state)?;
    if let Some(title) = document.get_element_by_id("toolbar-project-name") {
        title.set_text_content(Some(
            state
                .current_project
                .as_ref()
                .map(|project| project.title.as_str())
                .unwrap_or("プロジェクト未選択"),
        ));
        if let Some(project) = &state.current_project {
            title.set_attribute(
                "title",
                &format!(
                    "作成: {} / 更新: {}",
                    project.created_at, project.updated_at
                ),
            )?;
        }
    }
    set_textarea(
        document,
        "editor",
        &state.editor_text,
        state.current_project.is_none(),
    )?;
    set_textarea(
        document,
        "episode-summary",
        &summary(state),
        state.current_episode_id.is_none(),
    )?;
    set_textarea(
        document,
        "episode-memo",
        &memo(state),
        state.current_episode_id.is_none(),
    )?;
    render_chat(document, state)?;
    render_view(document, state)?;
    render_collapsible(document, state)?;
    render_detached(document, state)?;
    if let Some(button) = document.get_element_by_id("btn-generate-summary") {
        if state.current_episode_id.is_some() && !state.is_generating {
            button.remove_attribute("disabled")?;
        } else {
            button.set_attribute("disabled", "")?;
        }
    }
    Ok(())
}

fn render_view(document: &Document, state: &State) -> Result<(), JsValue> {
    let view = if state.current_view.is_empty() {
        "episode"
    } else {
        state.current_view.as_str()
    };
    let settings_view = matches!(view, "characters" | "world" | "relationships");
    let settings_detached = state.detached.contains("settings");
    for (id, visible) in [
        (
            "editor-section",
            view == "episode" || (settings_view && settings_detached),
        ),
        ("settings-panel", settings_view && !settings_detached),
        ("memos-panel", view == "memos"),
    ] {
        if let Some(element) = document.get_element_by_id(id) {
            element.class_list().toggle_with_force("hidden", !visible)?;
        }
    }
    for (id, target) in [
        ("nav-characters", "characters"),
        ("nav-world", "world"),
        ("nav-relationships", "relationships"),
        ("nav-memos", "memos"),
    ] {
        if let Some(element) = document.get_element_by_id(id) {
            element
                .class_list()
                .toggle_with_force("active", view == target)?;
        }
    }
    Ok(())
}

fn render_detached(document: &Document, state: &State) -> Result<(), JsValue> {
    for (label, section_id) in [
        ("summary", "summary-section"),
        ("memo", "memo-section"),
        ("settings", "settings-section"),
        ("project-memos", "memos-section"),
        ("chat", "chat-panel"),
    ] {
        if let Some(element) = document.get_element_by_id(section_id) {
            element
                .class_list()
                .toggle_with_force("detached", state.detached.contains(label))?;
        }
    }
    // メモが独立している間は、メイン側のメモパネルに通知を表示する
    let memos_detached = state.detached.contains("project-memos");
    if let Some(container) = document.get_element_by_id("memos-container") {
        container
            .class_list()
            .toggle_with_force("hidden", memos_detached)?;
    }
    if let Some(notice) = document.get_element_by_id("memos-detached-notice") {
        notice
            .class_list()
            .toggle_with_force("hidden", !memos_detached)?;
    }
    Ok(())
}

fn render_collapsible(document: &Document, state: &State) -> Result<(), JsValue> {
    for (section_id, button_id, collapsed) in [
        ("memo-section", "btn-toggle-memo", state.memo_collapsed),
        ("chat-panel", "btn-toggle-chat", state.chat_collapsed),
    ] {
        if let Some(section) = document.get_element_by_id(section_id) {
            section
                .class_list()
                .toggle_with_force("collapsed", collapsed)?;
        }
        if let Some(button) = document.get_element_by_id(button_id) {
            button.set_text_content(Some(if collapsed { "＋" } else { "−" }));
            button.set_attribute("aria-expanded", if collapsed { "false" } else { "true" })?;
        }
    }
    Ok(())
}

fn render_chat(document: &Document, state: &State) -> Result<(), JsValue> {
    if let Some(container) = document.get_element_by_id("chat-messages") {
        let rows = state
            .chat
            .iter()
            .map(|message| {
                crate::windows::chat::render::render_message_html(
                    &message.role,
                    &message.content,
                    message.thinking.as_deref(),
                    message.id.as_deref(),
                    message
                        .transport
                        .as_ref()
                        .and_then(|value| value.provider.as_deref()),
                    message
                        .transport
                        .as_ref()
                        .and_then(|value| value.model.as_deref()),
                    message
                        .transport
                        .as_ref()
                        .and_then(|value| value.response_model_id.as_deref()),
                )
            })
            .collect::<String>();
        container.set_inner_html(&format!(
            "{}{}",
            rows,
            if state.is_generating {
                r#"<div class="chat-message assistant chat-pending"></div>"#
            } else {
                ""
            }
        ));
        container.set_scroll_top(container.scroll_height());
        if state.is_generating {
            crate::windows::chat::render::pin_stream_to_bottom(&container);
        }
    }
    if let Some(select) = document.get_element_by_id("chat-provider") {
        select.set_inner_html(
            &state
                .catalog
                .iter()
                .map(|provider| {
                    format!(
                        r#"<option value="{}"{}>{}</option>"#,
                        escape(&provider.id),
                        if state.selected_provider.as_deref() == Some(&provider.id) {
                            " selected"
                        } else {
                            ""
                        },
                        escape(&provider.name)
                    )
                })
                .collect::<String>(),
        );
    }
    if let Some(select) = document.get_element_by_id("chat-model") {
        let models = state
            .selected_provider
            .as_ref()
            .and_then(|id| state.catalog.iter().find(|provider| &provider.id == id))
            .map(|provider| provider.models.as_slice())
            .unwrap_or(&[]);
        select.set_inner_html(
            &models
                .iter()
                .map(|model| {
                    format!(
                        r#"<option value="{}"{}>{}</option>"#,
                        escape(&model.id),
                        if state.selected_model.as_deref() == Some(&model.id) {
                            " selected"
                        } else {
                            ""
                        },
                        escape(model.label.as_deref().unwrap_or(&model.id))
                    )
                })
                .collect::<String>(),
        );
    }
    if let Some(cancel) = document.get_element_by_id("btn-cancel") {
        cancel
            .class_list()
            .toggle_with_force("hidden", !state.is_generating)?;
        if state.is_generating {
            cancel.remove_attribute("disabled")?;
        } else {
            cancel.set_attribute("disabled", "")?;
        }
    }
    if let Some(button) = document.get_element_by_id("btn-direct-writing") {
        button.set_text_content(Some(if state.direct_writing {
            "⚡ 直接執筆 ON"
        } else {
            "⚡ 直接執筆 OFF"
        }));
        button.set_attribute(
            "aria-pressed",
            if state.direct_writing {
                "true"
            } else {
                "false"
            },
        )?;
        button
            .class_list()
            .toggle_with_force("is-active", state.direct_writing)?;
    }
    Ok(())
}

pub fn chat(document: &Document, state: &State) -> Result<(), JsValue> {
    render_chat(document, state)
}

pub fn projects(document: &Document, state: &State) -> Result<(), JsValue> {
    if let Some(list) = document.get_element_by_id("project-list") {
        let html = state.projects.iter().map(|project| format!(r#"<div class="project-list-item" title="更新: {updated}"><button data-action="open-project" data-id="{id}" class="project-list-title">{title}</button><button data-action="delete-project" data-id="{id}" class="project-list-delete">削除</button></div>"#, id=escape(&project.id), title=escape(&project.title), updated=escape(&project.updated_at))).collect::<String>();
        list.set_inner_html(&html);
    }
    Ok(())
}

fn episodes(document: &Document, state: &State) -> Result<(), JsValue> {
    if let Some(list) = document.get_element_by_id("episode-list") {
        let html = state.episodes.iter().map(|episode| { let active = if state.current_episode_id.as_deref() == Some(&episode.id) { " active" } else { "" }; format!(r#"<div class="nav-episode-item{active}" data-order="{order}"><button data-action="select-episode" data-id="{id}" class="nav-episode-title">{title}</button><button data-action="move-episode-up" data-id="{id}" title="上へ">↑</button><button data-action="move-episode-down" data-id="{id}" title="下へ">↓</button><button data-action="rename-episode" data-id="{id}" title="名前変更">✎</button><button data-action="delete-episode" data-id="{id}" title="削除">×</button></div>"#, id=escape(&episode.id), title=escape(&episode.title), order=episode.order) }).collect::<String>();
        list.set_inner_html(&html);
    }
    Ok(())
}

fn set_textarea(document: &Document, id: &str, value: &str, disabled: bool) -> Result<(), JsValue> {
    if let Some(textarea) = document
        .get_element_by_id(id)
        .and_then(|element| element.dyn_into::<HtmlTextAreaElement>().ok())
    {
        if document
            .active_element()
            .as_ref()
            .map(|element| element.id())
            != Some(id.into())
        {
            textarea.set_value(value);
        }
        textarea.set_disabled(disabled);
    }
    Ok(())
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
