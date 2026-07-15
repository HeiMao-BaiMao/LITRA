use std::{cell::RefCell, rc::Rc};

use js_sys::Reflect;
use wasm_bindgen::{closure::Closure, JsCast, JsValue};
use wasm_bindgen_futures::spawn_local;
use web_sys::{Document, Element, Event, HtmlSelectElement, HtmlTextAreaElement};

use crate::{
    data::genres::{chat, sources},
    runtime::{ai, tauri},
};

use super::{load_genre, refresh, report, send, State};

pub fn bind(document: &Document, state: Rc<RefCell<State>>) -> Result<(), JsValue> {
    let click_document = document.clone();
    let click_state = Rc::clone(&state);
    let click = Closure::wrap(Box::new(move |event: Event| {
        let Some(target) = event
            .target()
            .and_then(|target| target.dyn_into::<Element>().ok())
        else {
            return;
        };
        let Ok(Some(target)) = target.closest("[data-action]") else {
            return;
        };
        let Some(action) = target.get_attribute("data-action") else {
            return;
        };
        let id = target.get_attribute("data-id");
        let document = click_document.clone();
        let state = Rc::clone(&click_state);
        spawn_local(async move {
            if let Err(error) = action_click(&document, &state, &action, id).await {
                report(error);
            }
        });
    }) as Box<dyn FnMut(Event)>);
    document.add_event_listener_with_callback("click", click.as_ref().unchecked_ref())?;
    click.forget();

    let form = document
        .get_element_by_id("chat-form")
        .ok_or_else(|| JsValue::from_str("chat form is missing"))?;
    let submit_document = document.clone();
    let submit_state = Rc::clone(&state);
    let submit = Closure::wrap(Box::new(move |event: Event| {
        event.prevent_default();
        let Some(input) = submit_document
            .get_element_by_id("chat-input")
            .and_then(|item| item.dyn_into::<HtmlTextAreaElement>().ok())
        else {
            return;
        };
        let content = input.value().trim().to_owned();
        if content.is_empty() {
            return;
        }
        input.set_value("");
        let document = submit_document.clone();
        let state = Rc::clone(&submit_state);
        spawn_local(async move {
            if let Err(error) = send(&document, &state, content).await {
                state.borrow_mut().is_streaming = false;
                let _ = super::render::all(&document, &state.borrow());
                report(error);
            }
        });
    }) as Box<dyn FnMut(Event)>);
    form.add_event_listener_with_callback("submit", submit.as_ref().unchecked_ref())?;
    submit.forget();
    let change_document = document.clone();
    let change_state = Rc::clone(&state);
    let change = Closure::wrap(Box::new(move |event: Event| {
        let Some(select) = event
            .target()
            .and_then(|target| target.dyn_into::<HtmlSelectElement>().ok())
        else {
            return;
        };
        if select.id() == "chat-provider" {
            let provider = select.value();
            let model = change_state
                .borrow()
                .catalog
                .iter()
                .find(|item| item.id == provider)
                .and_then(|item| item.models.first())
                .map(|item| item.id.clone());
            let mut current = change_state.borrow_mut();
            current.selected_provider = Some(provider);
            current.selected_model = model;
        } else if select.id() == "chat-model" {
            change_state.borrow_mut().selected_model = Some(select.value());
        } else {
            return;
        }
        let _ = super::render::all(&change_document, &change_state.borrow());
    }) as Box<dyn FnMut(Event)>);
    document.add_event_listener_with_callback("change", change.as_ref().unchecked_ref())?;
    change.forget();
    Ok(())
}

pub async fn listen(document: Document, state: Rc<RefCell<State>>) -> Result<(), JsValue> {
    let selected_document = document.clone();
    let selected_state = Rc::clone(&state);
    tauri::listen(
        "genre-selected",
        Closure::wrap(Box::new(move |payload: JsValue| {
            let Ok(value) = Reflect::get(&payload, &"genreId".into()) else {
                return;
            };
            let Some(id) = value.as_string() else {
                return;
            };
            let document = selected_document.clone();
            let state = Rc::clone(&selected_state);
            spawn_local(async move {
                if let Err(error) = load_genre(&document, &state, id).await {
                    report(error);
                }
            });
        }) as Box<dyn FnMut(JsValue)>),
    )
    .await?;
    let send_document = document.clone();
    let send_state = Rc::clone(&state);
    tauri::listen(
        "genre-chat-send",
        Closure::wrap(Box::new(move |payload: JsValue| {
            let Ok(value) = Reflect::get(&payload, &"content".into()) else {
                return;
            };
            let Some(content) = value.as_string() else {
                return;
            };
            let document = send_document.clone();
            let state = Rc::clone(&send_state);
            spawn_local(async move {
                if let Err(error) = send(&document, &state, content).await {
                    report(error);
                }
            });
        }) as Box<dyn FnMut(JsValue)>),
    )
    .await?;
    tauri::listen(
        "genre-chat-stop",
        Closure::wrap(Box::new(move |_payload: JsValue| {
            ai::cancel_active();
            state.borrow_mut().is_streaming = false;
            let _ = super::render::all(&document, &state.borrow());
        }) as Box<dyn FnMut(JsValue)>),
    )
    .await
}

async fn action_click(
    document: &Document,
    state: &Rc<RefCell<State>>,
    action: &str,
    id: Option<String>,
) -> Result<(), JsValue> {
    let genre_id = state.borrow().genre_id.clone();
    match action {
        "new-thread" => {
            if let Some(genre_id) = genre_id {
                let title = prompt("新しいスレッド名", "新規スレッド")
                    .unwrap_or_else(|| "新規スレッド".into());
                let thread = chat::create(&genre_id, &title).await?;
                state.borrow_mut().current_thread_id = Some(thread.id);
                refresh(document, state).await?;
            }
        }
        "select-thread" => {
            if let (Some(genre_id), Some(id)) = (genre_id, id) {
                let chat = chat::load(&genre_id, &id).await?;
                let mut current = state.borrow_mut();
                current.current_thread_id = Some(id);
                current.messages = chat.messages;
                super::render::all(document, &current)?;
            }
        }
        "rename-thread" => {
            if let (Some(genre_id), Some(id)) = (genre_id, id) {
                let old = state
                    .borrow()
                    .threads
                    .iter()
                    .find(|thread| thread.id == id)
                    .map(|thread| thread.title.clone())
                    .unwrap_or_default();
                if let Some(title) = prompt("スレッド名を変更", &old) {
                    chat::rename(&genre_id, &id, title).await?;
                    refresh(document, state).await?;
                }
            }
        }
        "archive-thread" => {
            if let (Some(genre_id), Some(id)) = (genre_id, id) {
                chat::archive(&genre_id, &id).await?;
                if state.borrow().current_thread_id.as_deref() == Some(&id) {
                    state.borrow_mut().current_thread_id = None;
                }
                refresh(document, state).await?;
            }
        }
        "delete-thread" => {
            if let (Some(genre_id), Some(id)) = (genre_id, id) {
                if confirm("このスレッドを削除しますか？") {
                    chat::remove(&genre_id, &id).await?;
                    if state.borrow().current_thread_id.as_deref() == Some(&id) {
                        state.borrow_mut().current_thread_id = None;
                    }
                    refresh(document, state).await?;
                }
            }
        }
        "cancel" => {
            ai::cancel_active();
            state.borrow_mut().is_streaming = false;
            super::render::all(document, &state.borrow())?;
        }
        "register-source" => {
            if let Some(genre_id) = genre_id {
                let Some(input) = document
                    .get_element_by_id("chat-input")
                    .and_then(|item| item.dyn_into::<HtmlTextAreaElement>().ok())
                else {
                    return Ok(());
                };
                let content = input.value().trim().to_owned();
                if !content.is_empty() {
                    if let Some(title) = prompt("資料のタイトルを入力してください", "チャット資料")
                    {
                        sources::create(&genre_id, &title, &content).await?;
                        input.set_value("");
                        alert("資料として登録しました");
                    }
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn prompt(message: &str, default: &str) -> Option<String> {
    let value = web_sys::window()?
        .prompt_with_message_and_default(message, default)
        .ok()??;
    (!value.trim().is_empty()).then(|| value.trim().to_owned())
}
fn confirm(message: &str) -> bool {
    web_sys::window()
        .and_then(|window| window.confirm_with_message(message).ok())
        .unwrap_or(false)
}
fn alert(message: &str) {
    if let Some(window) = web_sys::window() {
        let _ = window.alert_with_message(message);
    }
}
