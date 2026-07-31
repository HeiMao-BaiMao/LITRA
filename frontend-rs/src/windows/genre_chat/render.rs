use ammonia::Builder;
use pulldown_cmark::{html, Options, Parser};
use std::{cell::RefCell, rc::Rc};

use wasm_bindgen::{closure::Closure, JsCast, JsValue};
use web_sys::Document;

use crate::data::genres::chat::Message;

use super::State;

pub fn all(document: &Document, state: &State) -> Result<(), JsValue> {
    render_catalog(document, state)?;
    if let Some(genre) = &state.genre {
        if let Some(title) = document.get_element_by_id("genre-chat-title") {
            title.set_text_content(Some(&format!("{} - ジャンルリトラチャット", genre.name)));
        }
        if let Some(title) = document.get_element_by_id("genre-chat-genre-name") {
            title.set_text_content(Some(&genre.name));
        }
    }
    if let Some(list) = document.get_element_by_id("thread-list") {
        let rows = state.threads.iter().map(|thread| { let selected = if state.current_thread_id.as_deref() == Some(&thread.id) { " selected" } else { "" }; format!(r#"<div class="thread-list-item{selected}"><span data-action="select-thread" data-id="{id}" class="thread-list-title">{title}</span><div class="thread-item-actions"><button data-action="rename-thread" data-id="{id}" title="名前変更">✎</button><button data-action="archive-thread" data-id="{id}" title="アーカイブ">−</button><button data-action="delete-thread" data-id="{id}" title="削除">×</button></div></div>"#, id=escape(&thread.id), title=escape(&thread.title)) }).collect::<String>();
        list.set_inner_html(&format!(r#"<div class="thread-list-header"><button data-action="new-thread">＋ 新規スレッド</button></div>{rows}"#));
    }
    if let Some(container) = document.get_element_by_id("chat-messages") {
        let rows = state.messages.iter().map(message_html).collect::<String>();
        let pending = if state.is_streaming {
            r#"<div class="chat-message assistant chat-pending"></div>"#
        } else {
            ""
        };
        container.set_inner_html(&format!("{rows}{pending}"));
        container.set_scroll_top(container.scroll_height());
    }
    if let Some(send) = document.get_element_by_id("btn-send") {
        if state.is_streaming {
            send.set_attribute("disabled", "")?;
        } else {
            send.remove_attribute("disabled")?;
        }
    }
    if let Some(cancel) = document.get_element_by_id("btn-cancel") {
        cancel
            .class_list()
            .toggle_with_force("hidden", !state.is_streaming)?;
        if state.is_streaming {
            cancel.remove_attribute("disabled")?;
        } else {
            cancel.set_attribute("disabled", "")?;
        }
    }
    Ok(())
}

pub fn schedule(document: &Document, state: &Rc<RefCell<State>>) {
    {
        let mut current = state.borrow_mut();
        if current.render_scheduled {
            return;
        }
        current.render_scheduled = true;
    }
    let Some(window) = web_sys::window() else {
        state.borrow_mut().render_scheduled = false;
        let current = state.borrow();
        let _ = all(document, &current);
        return;
    };
    let document = document.clone();
    let state = Rc::clone(state);
    let callback = Closure::once_into_js(move |_timestamp: f64| {
        state.borrow_mut().render_scheduled = false;
        let current = state.borrow();
        let _ = render_streaming_message(&document, &current);
    });
    let _ = window.request_animation_frame(callback.unchecked_ref());
}

fn render_streaming_message(document: &Document, state: &State) -> Result<(), JsValue> {
    if !state.is_streaming || state.messages.is_empty() {
        return all(document, state);
    }
    let Some(container) = document.get_element_by_id("chat-messages") else {
        return Ok(());
    };
    let message_nodes = container.query_selector_all(".chat-message")?;
    if message_nodes.length() != (state.messages.len() + 1) as u32 {
        return all(document, state);
    }
    let Some(last) = message_nodes
        .item((state.messages.len() - 1) as u32)
        .and_then(|node| node.dyn_into::<web_sys::Element>().ok())
    else {
        return all(document, state);
    };
    last.set_outer_html(&message_html(
        state.messages.last().expect("messages is not empty"),
    ));
    container.set_scroll_top(container.scroll_height());
    Ok(())
}

fn message_html(message: &Message) -> String {
    format!(
        r#"<div class="chat-message {}">{}{}</div>"#,
        escape(&message.role),
        message
            .thinking
            .as_deref()
            .filter(|text| !text.trim().is_empty())
            .map(|text| format!(r#"<details class="thinking-panel"><summary class="thinking-summary">思考</summary><div class="thinking-content">{}</div></details>"#, markdown(text)))
            .unwrap_or_default(),
        markdown(&message.content)
    )
}

fn render_catalog(document: &Document, state: &State) -> Result<(), JsValue> {
    if let Some(select) = document.get_element_by_id("chat-provider") {
        let options = state
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
            .collect::<String>();
        select.set_inner_html(&options);
    }
    if let Some(select) = document.get_element_by_id("chat-model") {
        let models = state
            .selected_provider
            .as_deref()
            .and_then(|id| state.catalog.iter().find(|provider| provider.id == id))
            .map(|provider| provider.models.as_slice())
            .unwrap_or(&[]);
        let options = models
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
            .collect::<String>();
        select.set_inner_html(&options);
    }
    Ok(())
}

fn markdown(value: &str) -> String {
    let mut output = String::new();
    html::push_html(
        &mut output,
        Parser::new_ext(
            value,
            Options::ENABLE_GFM | Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH,
        ),
    );
    Builder::default().clean(&output).to_string()
}
fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
