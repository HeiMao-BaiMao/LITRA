use std::{cell::RefCell, rc::Rc};

use wasm_bindgen::{closure::Closure, JsCast, JsValue};
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
    view(document, state)?;
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

pub fn view(document: &Document, state: &State) -> Result<(), JsValue> {
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
        let rows = state.chat.iter().map(chat_message_html).collect::<String>();
        // 最後のメッセージが空のアシスタント（ストリーミング中の進捗枠）の場合、
        // それ自体が chat-pending として描画されるため、追加の pending 吹き出しは出さない。
        // （二重の「…」吹き出しを防ぐ）
        let last_is_empty_assistant = state.chat.last().is_some_and(|message| {
            message.role == "assistant"
                && message.content.trim().is_empty()
                && message
                    .thinking
                    .as_deref()
                    .unwrap_or_default()
                    .trim()
                    .is_empty()
        });
        container.set_inner_html(&format!(
            "{}{}",
            rows,
            if state.is_generating && !last_is_empty_assistant {
                r#"<div class="chat-message assistant chat-pending"></div>"#
            } else {
                ""
            }
        ));
        crate::windows::chat::render::collapse_thinking_before_tool_cards(&container);
        crate::windows::chat::render::scroll_stream_cards_to_bottom(&container);
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

pub fn episode_textareas(document: &Document, state: &State) -> Result<(), JsValue> {
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
    Ok(())
}

pub fn schedule_editor(document: &Document, state: &Rc<RefCell<State>>) {
    {
        let mut current = state.borrow_mut();
        if current.editor_render_scheduled {
            return;
        }
        current.editor_render_scheduled = true;
    }
    let Some(window) = web_sys::window() else {
        state.borrow_mut().editor_render_scheduled = false;
        return;
    };
    let document = document.clone();
    let state = Rc::clone(state);
    let callback = Closure::once_into_js(move |_timestamp: f64| {
        state.borrow_mut().editor_render_scheduled = false;
        let value = state.borrow().editor_text.clone();
        if let Some(editor) = document
            .get_element_by_id("editor")
            .and_then(|element| element.dyn_into::<HtmlTextAreaElement>().ok())
        {
            editor.set_value(&value);
            editor.set_scroll_top(editor.scroll_height());
        }
    });
    let _ = window.request_animation_frame(callback.unchecked_ref());
}

/// ストリーミング中のチャット更新を次の描画フレームへまとめる。
///
/// AIのトークン到着頻度に合わせて全履歴を再描画すると、DOM更新とJSON化が
/// 入力処理を圧迫するため、1フレームにつき最大1回だけ末尾を更新する。
pub fn schedule_chat(document: &Document, state: &Rc<RefCell<State>>) {
    {
        let mut current = state.borrow_mut();
        if current.chat_render_scheduled {
            return;
        }
        current.chat_render_scheduled = true;
    }

    let Some(window) = web_sys::window() else {
        state.borrow_mut().chat_render_scheduled = false;
        let current = state.borrow();
        if let Err(error) = chat(document, &current) {
            web_sys::console::error_1(
                &format!("[litra-chat] render failed before animation frame: {error:?}").into(),
            );
        }
        super::sync_chat(&current);
        return;
    };

    let document = document.clone();
    let state = Rc::clone(state);
    let callback = Closure::once_into_js(move |_timestamp: f64| {
        state.borrow_mut().chat_render_scheduled = false;
        let current = state.borrow();
        if let Err(error) = render_chat_incremental(&document, &current) {
            web_sys::console::error_1(
                &format!("[litra-chat] incremental render failed: {error:?}").into(),
            );
        }
        super::sync_chat_progress(&current);
    });
    let _ = window.request_animation_frame(callback.unchecked_ref());
}

fn render_chat_incremental(document: &Document, state: &State) -> Result<(), JsValue> {
    if !state.is_generating || state.chat.is_empty() {
        return render_chat(document, state);
    }
    let Some(container) = document.get_element_by_id("chat-messages") else {
        return Ok(());
    };
    let last_is_empty_assistant = state.chat.last().is_some_and(|message| {
        message.role == "assistant"
            && message.content.trim().is_empty()
            && message
                .thinking
                .as_deref()
                .unwrap_or_default()
                .trim()
                .is_empty()
    });
    let expected_children = state.chat.len() + usize::from(!last_is_empty_assistant);
    let message_nodes = container.query_selector_all(".chat-message")?;
    if message_nodes.length() != expected_children as u32 {
        return render_chat(document, state);
    }
    let Some(last) = message_nodes
        .item((state.chat.len() - 1) as u32)
        .and_then(|node| node.dyn_into::<web_sys::Element>().ok())
    else {
        return render_chat(document, state);
    };
    let follow_bottom = crate::windows::chat::render::should_follow_bottom(&container);
    last.set_outer_html(&chat_message_html(
        state.chat.last().expect("chat is not empty"),
    ));
    crate::windows::chat::render::collapse_thinking_before_tool_cards(&container);
    crate::windows::chat::render::scroll_stream_cards_to_bottom(&container);
    if follow_bottom {
        container.set_scroll_top(container.scroll_height());
        crate::windows::chat::render::pin_stream_to_bottom(&container);
    }
    Ok(())
}

fn chat_message_html(message: &super::ChatMessage) -> String {
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
}

pub fn projects(document: &Document, state: &State) -> Result<(), JsValue> {
    if let Some(list) = document.get_element_by_id("project-list") {
        let html = if state.projects.is_empty() {
            "<div class=\"project-list-empty\">プロジェクトがありません。</div>".to_string()
        } else {
            state.projects.iter().map(|project| format!(
                r#"<div class="project-list-item"><div class="project-list-info"><div class="project-list-title">{title}</div><div class="project-list-meta">更新: {updated}</div></div><div class="project-list-actions"><button data-action="open-project" data-id="{id}">開く</button><button data-action="rename-project" data-id="{id}">✎</button><button data-action="delete-project" data-id="{id}" class="danger">削除</button></div></div>"#,
                id=escape(&project.id),
                title=escape(&project.title),
                updated=escape(&project.updated_at),
            )).collect::<String>()
        };
        list.set_inner_html(&html);
    }
    Ok(())
}

fn episodes(document: &Document, state: &State) -> Result<(), JsValue> {
    if let Some(list) = document.get_element_by_id("episode-list") {
        let count = state.episodes.len();
        let html = state.episodes.iter().enumerate().map(|(index, episode)| {
            let active = if state.current_episode_id.as_deref() == Some(&episode.id) { " active" } else { "" };
            let up_disabled = if index == 0 { " disabled" } else { "" };
            let down_disabled = if index + 1 >= count { " disabled" } else { "" };
            format!(
                r#"<div class="nav-episode-item{active}" data-order="{order}" data-id="{id}"><span class="nav-episode-drag-handle" draggable="true">≡</span><div class="nav-episode-move-controls"><button class="nav-episode-move" data-action="move-episode-up" data-id="{id}"{up_disabled} title="上へ">▲</button><button class="nav-episode-move" data-action="move-episode-down" data-id="{id}"{down_disabled} title="下へ">▼</button></div><div class="nav-episode-title-container" data-action="select-episode" data-id="{id}"><button data-action="select-episode" data-id="{id}" class="nav-episode-title">{title}</button><button data-action="rename-episode" data-id="{id}" class="nav-episode-edit" title="名前変更">✎</button><button data-action="delete-episode" data-id="{id}" class="nav-episode-delete" title="削除">×</button></div></div>"#,
                active=active,
                order=episode.order,
                id=escape(&episode.id),
                title=escape(&episode.title),
                up_disabled=up_disabled,
                down_disabled=down_disabled,
            )
        }).collect::<String>();
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
