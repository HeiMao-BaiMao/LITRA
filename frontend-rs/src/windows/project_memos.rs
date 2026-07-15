use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use js_sys::{Object, Reflect};
use serde::Deserialize;
use wasm_bindgen::{closure::Closure, JsCast, JsValue};
use web_sys::{Document, Element, Event, HtmlInputElement, HtmlTextAreaElement};

use crate::runtime::tauri;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectMemo {
    id: String,
    title: String,
    content: String,
    #[serde(rename = "updatedAt")]
    _updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectMemosSyncPayload {
    memos: Vec<ProjectMemo>,
    current_memo_id: Option<String>,
}

#[derive(Default)]
struct ProjectMemosState {
    memos: Vec<ProjectMemo>,
    current_memo_id: Option<String>,
}

pub async fn mount(document: &Document) -> Result<(), JsValue> {
    tauri::listen_dpi_zoom();
    let container = document
        .query_selector("#memos-container")?
        .ok_or_else(|| JsValue::from_str("project memos container is missing"))?;
    container.set_inner_html(
        r#"<div class="memos-editor">
          <div class="memos-editor-sidebar">
            <button type="button" class="memos-add-button" data-action="create">＋ 新しいメモ</button>
            <div id="memos-list" class="memos-list"></div>
          </div>
          <div id="memos-editor-detail" class="memos-editor-detail">
            <div class="memos-detail-header"><h3>メモ</h3></div>
            <div class="memos-empty">メモを選択または作成してください</div>
          </div>
        </div>"#,
    );

    let state = Rc::new(RefCell::new(ProjectMemosState::default()));
    let update_timeout = Rc::new(Cell::new(None::<i32>));

    {
        let document = document.clone();
        let state = Rc::clone(&state);
        tauri::listen(
            "project-memos-sync",
            Closure::wrap(Box::new(move |payload: JsValue| {
                let Ok(payload) =
                    serde_wasm_bindgen::from_value::<ProjectMemosSyncPayload>(payload)
                else {
                    return;
                };
                {
                    let mut state = state.borrow_mut();
                    state.memos = payload.memos;
                    state.current_memo_id = payload.current_memo_id;
                }
                let _ = render(&document, &state.borrow());
            }) as Box<dyn FnMut(JsValue)>),
        )
        .await?;
    }

    bind_clicks(&container, Rc::clone(&state))?;
    bind_inputs(&container, Rc::clone(&state), update_timeout)?;
    tauri::emit("project-memos-ready", &Object::new());
    Ok(())
}

fn render(document: &Document, state: &ProjectMemosState) -> Result<(), JsValue> {
    let list = document
        .query_selector("#memos-list")?
        .ok_or_else(|| JsValue::from_str("project memos list is missing"))?;
    let mut list_html = String::new();
    for memo in &state.memos {
        let active = if state.current_memo_id.as_deref() == Some(&memo.id) {
            " active"
        } else {
            ""
        };
        let title = if memo.title.is_empty() {
            "（無題）".to_owned()
        } else {
            escape_html(&memo.title)
        };
        list_html.push_str(&format!(
            r#"<div class="memos-list-item{active}">
              <button type="button" class="memos-list-name" data-action="select" data-id="{id}">{title}</button>
              <button type="button" class="memos-list-delete" data-action="delete" data-id="{id}" title="削除">×</button>
            </div>"#,
            id = escape_html(&memo.id),
        ));
    }
    list.set_inner_html(&list_html);

    let detail = document
        .query_selector("#memos-editor-detail")?
        .ok_or_else(|| JsValue::from_str("project memo detail is missing"))?;
    let selected = state
        .current_memo_id
        .as_deref()
        .and_then(|id| state.memos.iter().find(|memo| memo.id == id));
    let existing_id = detail
        .query_selector(":scope > .memos-detail")?
        .and_then(|element| element.get_attribute("data-memo-id"));
    let active_id = document.active_element().map(|element| element.id());

    if let Some(memo) = selected {
        if existing_id.as_deref() == Some(&memo.id) {
            if active_id.as_deref() != Some("memo-title-input") {
                if let Some(input) = detail
                    .query_selector("#memo-title-input")?
                    .and_then(|element| element.dyn_into::<HtmlInputElement>().ok())
                {
                    input.set_value(&memo.title);
                }
            }
            if active_id.as_deref() != Some("memo-content-textarea") {
                if let Some(textarea) = detail
                    .query_selector("#memo-content-textarea")?
                    .and_then(|element| element.dyn_into::<HtmlTextAreaElement>().ok())
                {
                    textarea.set_value(&memo.content);
                    resize_textarea(&textarea);
                }
            }
            return Ok(());
        }
        detail.set_inner_html(&format!(
            r#"<div class="memos-detail-header"><h3>メモ</h3></div>
            <div class="memos-detail" data-memo-id="{id}">
              <div class="memos-title-row">
                <input id="memo-title-input" type="text" class="memos-title-input" placeholder="メモタイトル" value="{title}">
              </div>
              <textarea id="memo-content-textarea" class="memos-content-textarea" placeholder="内容を自由に書いてください..." spellcheck="false">{content}</textarea>
            </div>"#,
            id = escape_html(&memo.id),
            title = escape_html(&memo.title),
            content = escape_html(&memo.content),
        ));
        if let Some(textarea) = detail
            .query_selector("#memo-content-textarea")?
            .and_then(|element| element.dyn_into::<HtmlTextAreaElement>().ok())
        {
            resize_textarea(&textarea);
        }
    } else {
        detail.set_inner_html(
            r#"<div class="memos-detail-header"><h3>メモ</h3></div>
            <div class="memos-empty">メモを選択または作成してください</div>"#,
        );
    }
    Ok(())
}

fn bind_clicks(container: &Element, state: Rc<RefCell<ProjectMemosState>>) -> Result<(), JsValue> {
    let on_click = Closure::wrap(Box::new(move |event: Event| {
        let Some(target) = event
            .target()
            .and_then(|target| target.dyn_into::<Element>().ok())
        else {
            return;
        };
        let Some(action) = target.get_attribute("data-action") else {
            return;
        };
        match action.as_str() {
            "create" => {
                let Some(window) = web_sys::window() else {
                    return;
                };
                let Ok(Some(title)) =
                    window.prompt_with_message("メモのタイトルを入力してください")
                else {
                    return;
                };
                let title = title.trim();
                if title.is_empty() {
                    let _ = window.alert_with_message("タイトルを入力してください");
                    return;
                }
                emit_string("project-memos-create", "title", title);
            }
            "select" => {
                if let Some(id) = target.get_attribute("data-id") {
                    emit_string("project-memos-select", "id", &id);
                }
            }
            "delete" => {
                let Some(id) = target.get_attribute("data-id") else {
                    return;
                };
                let title = state
                    .borrow()
                    .memos
                    .iter()
                    .find(|memo| memo.id == id)
                    .map(|memo| {
                        if memo.title.is_empty() {
                            "（無題）".to_owned()
                        } else {
                            memo.title.clone()
                        }
                    })
                    .unwrap_or_else(|| "（無題）".to_owned());
                let confirmed = web_sys::window()
                    .and_then(|window| {
                        window
                            .confirm_with_message(&format!("「{title}」を削除しますか？"))
                            .ok()
                    })
                    .unwrap_or(false);
                if confirmed {
                    emit_string("project-memos-delete", "id", &id);
                }
            }
            _ => {}
        }
    }) as Box<dyn FnMut(Event)>);
    container.add_event_listener_with_callback("click", on_click.as_ref().unchecked_ref())?;
    on_click.forget();
    Ok(())
}

fn bind_inputs(
    container: &Element,
    state: Rc<RefCell<ProjectMemosState>>,
    update_timeout: Rc<Cell<Option<i32>>>,
) -> Result<(), JsValue> {
    let on_input = Closure::wrap(Box::new(move |event: Event| {
        let Some(target) = event.target() else {
            return;
        };
        let (field, value) = if let Ok(input) = target.clone().dyn_into::<HtmlInputElement>() {
            if input.id() != "memo-title-input" {
                return;
            }
            ("title", input.value())
        } else if let Ok(textarea) = target.dyn_into::<HtmlTextAreaElement>() {
            if textarea.id() != "memo-content-textarea" {
                return;
            }
            resize_textarea(&textarea);
            ("content", textarea.value())
        } else {
            return;
        };
        let Some(id) = state.borrow().current_memo_id.clone() else {
            return;
        };
        let Some(window) = web_sys::window() else {
            return;
        };
        if let Some(timeout_id) = update_timeout.take() {
            window.clear_timeout_with_handle(timeout_id);
        }
        let callback = Closure::once_into_js(move || {
            let payload = Object::new();
            let _ = Reflect::set(&payload, &"id".into(), &id.into());
            let _ = Reflect::set(&payload, &field.into(), &value.into());
            tauri::emit("project-memos-update", &payload);
        });
        if let Ok(timeout_id) = window
            .set_timeout_with_callback_and_timeout_and_arguments_0(callback.unchecked_ref(), 400)
        {
            update_timeout.set(Some(timeout_id));
        }
    }) as Box<dyn FnMut(Event)>);
    container.add_event_listener_with_callback("input", on_input.as_ref().unchecked_ref())?;
    on_input.forget();
    Ok(())
}

fn resize_textarea(textarea: &HtmlTextAreaElement) {
    let style = textarea.style();
    let _ = style.set_property("height", "auto");
    let height = textarea.scroll_height().min(30 * 24);
    let _ = style.set_property("height", &format!("{height}px"));
}

fn emit_string(event: &str, key: &str, value: &str) {
    let payload = Object::new();
    let _ = Reflect::set(&payload, &key.into(), &value.into());
    tauri::emit(event, &payload);
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
