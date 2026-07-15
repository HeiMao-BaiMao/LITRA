use ammonia::Builder;
use pulldown_cmark::{html, Options, Parser};
use wasm_bindgen::JsValue;
use web_sys::Document;

use super::State;

pub fn all(document: &Document, state: &State) -> Result<(), JsValue> {
    if let Some(genre) = &state.genre {
        if let Some(title) = document.get_element_by_id("genre-chat-title") {
            title.set_text_content(Some(&format!("{} - ジャンルリトラチャット", genre.name)));
        }
        if let Some(title) = document.get_element_by_id("genre-chat-genre-name") {
            title.set_text_content(Some(&genre.name));
        }
    }
    if let Some(list) = document.get_element_by_id("thread-list") {
        let rows = state.threads.iter().map(|thread| { let active = if state.current_thread_id.as_deref() == Some(&thread.id) { " active" } else { "" }; format!(r#"<div class="thread-list-item{active}"><button data-action="select-thread" data-id="{id}" class="thread-list-title">{title}</button><button data-action="rename-thread" data-id="{id}" title="名前変更">✎</button><button data-action="archive-thread" data-id="{id}" title="アーカイブ">−</button><button data-action="delete-thread" data-id="{id}" title="削除">×</button></div>"#, id=escape(&thread.id), title=escape(&thread.title)) }).collect::<String>();
        list.set_inner_html(&format!(r#"<button data-action="new-thread" class="thread-create-button">＋ 新規スレッド</button>{rows}"#));
    }
    if let Some(container) = document.get_element_by_id("chat-messages") {
        let rows = state.messages.iter().map(|message| format!(r#"<div class="chat-message {}">{}{}</div>"#, escape(&message.role), message.thinking.as_deref().filter(|text| !text.trim().is_empty()).map(|text| format!(r#"<details class="thinking-panel"><summary class="thinking-summary">思考</summary><div class="thinking-content">{}</div></details>"#, markdown(text))).unwrap_or_default(), markdown(&message.content))).collect::<String>();
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

pub fn selection(document: &Document, provider: &str, model: &str) -> Result<(), JsValue> {
    if let Some(select) = document.get_element_by_id("chat-provider") {
        select.set_inner_html(&format!(
            r#"<option value="{}">{}</option>"#,
            escape(provider),
            escape(provider)
        ));
    }
    if let Some(select) = document.get_element_by_id("chat-model") {
        select.set_inner_html(&format!(
            r#"<option value="{}">{}</option>"#,
            escape(model),
            escape(model)
        ));
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
