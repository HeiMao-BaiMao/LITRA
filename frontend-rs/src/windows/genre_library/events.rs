use std::{cell::RefCell, rc::Rc};

use js_sys::Reflect;
use serde::Serialize;
use wasm_bindgen::{closure::Closure, JsCast, JsValue};
use wasm_bindgen_futures::spawn_local;
use web_sys::{Document, Element, Event, HtmlInputElement, HtmlTextAreaElement};

use crate::{
    data::genres::{knowledge, models::GenreUpdate, repository, sources},
    runtime::{invoke, tauri},
};

use super::{refresh_current, refresh_list, report_error, select, State, Tab};

pub fn bind(document: &Document, state: Rc<RefCell<State>>) -> Result<(), JsValue> {
    bind_click(document, Rc::clone(&state))?;
    bind_change(document, state)
}

pub async fn listen_sync(document: Document, state: Rc<RefCell<State>>) -> Result<(), JsValue> {
    let sync_document = document.clone();
    let sync_state = Rc::clone(&state);
    tauri::listen(
        "genre-chat-sync",
        Closure::wrap(Box::new(move |_payload: JsValue| {
            let document = sync_document.clone();
            let state = Rc::clone(&sync_state);
            spawn_local(async move {
                if let Err(error) = refresh_current(&document, &state).await {
                    report_error(error);
                }
            });
        }) as Box<dyn FnMut(JsValue)>),
    )
    .await?;
    let selected_document = document;
    tauri::listen(
        "genre-selected",
        Closure::wrap(Box::new(move |payload: JsValue| {
            let Ok(id) = Reflect::get(&payload, &"genreId".into()) else {
                return;
            };
            let Some(id) = id.as_string() else {
                return;
            };
            let document = selected_document.clone();
            let state = Rc::clone(&state);
            spawn_local(async move {
                if let Err(error) = select(&document, &state, id).await {
                    report_error(error);
                }
            });
        }) as Box<dyn FnMut(JsValue)>),
    )
    .await
}

fn bind_click(document: &Document, state: Rc<RefCell<State>>) -> Result<(), JsValue> {
    let document_for_event = document.clone();
    let handler = Closure::wrap(Box::new(move |event: Event| {
        let Some(target) = event
            .target()
            .and_then(|target| target.dyn_into::<Element>().ok())
        else {
            return;
        };
        let Ok(Some(action_target)) = target.closest("[data-action]") else {
            return;
        };
        let Some(action) = action_target.get_attribute("data-action") else {
            return;
        };
        let id = action_target.get_attribute("data-id");
        let document = document_for_event.clone();
        let state = Rc::clone(&state);
        spawn_local(async move {
            let result = handle_action(&document, &state, &action, id, &action_target).await;
            if let Err(error) = result {
                report_error(error);
            }
        });
    }) as Box<dyn FnMut(Event)>);
    document.add_event_listener_with_callback("click", handler.as_ref().unchecked_ref())?;
    handler.forget();
    Ok(())
}

async fn handle_action(
    document: &Document,
    state: &Rc<RefCell<State>>,
    action: &str,
    id: Option<String>,
    element: &Element,
) -> Result<(), JsValue> {
    match action {
        "new-genre" => {
            if let Some(name) = prompt("新しいジャンル名を入力してください", None)
            {
                let genre = repository::create(name.trim()).await?;
                refresh_list(document, state).await?;
                select(document, state, genre.id).await?;
            }
        }
        "select" => {
            if let Some(id) = id {
                select(document, state, id).await?;
            }
        }
        "rename" => {
            if let Some(id) = id {
                let old = state
                    .borrow()
                    .genres
                    .iter()
                    .find(|item| item.id == id)
                    .map(|item| item.name.clone())
                    .unwrap_or_default();
                if let Some(name) = prompt("ジャンル名を変更", Some(&old)) {
                    repository::update(
                        &id,
                        GenreUpdate {
                            name: Some(name.trim().into()),
                            ..Default::default()
                        },
                    )
                    .await?;
                    refresh_current(document, state).await?;
                }
            }
        }
        "delete" => {
            if let Some(id) = id {
                if confirm("このジャンルと関連する資料・知識をすべて削除しますか？")
                {
                    repository::remove(&id).await?;
                    {
                        let mut current = state.borrow_mut();
                        current.current_genre_id = None;
                        current.genre = None;
                        current.sources.clear();
                        current.knowledge = None;
                    }
                    refresh_list(document, state).await?;
                }
            }
        }
        "tab-overview" => set_tab(document, state, Tab::Overview)?,
        "tab-sources" => set_tab(document, state, Tab::Sources)?,
        "tab-analysis" => set_tab(document, state, Tab::Analysis)?,
        "tab-knowledge" => set_tab(document, state, Tab::Knowledge)?,
        "import-source" => import_source(document, state).await?,
        "choose-source" => {
            if let Some(id) = id {
                state.borrow_mut().current_source_id = Some(id);
                set_tab(document, state, Tab::Analysis)?;
            }
        }
        "view-source" => {
            if let (Some(genre_id), Some(source_id)) = (state.borrow().current_genre_id.clone(), id)
            {
            let source = sources::load(&genre_id, &source_id).await?;
            alert(&format!(
                "{}（{}セグメント）\n\n{}",
                source.metadata.title,
                source.segments.len(),
                source.content.chars().take(2000).collect::<String>()
            ));
            }
        }
        "delete-source" => {
            if let (Some(genre_id), Some(source_id)) = (state.borrow().current_genre_id.clone(), id)
            {
                if confirm("この資料を削除しますか？") {
                    sources::remove(&genre_id, &source_id).await?;
                    refresh_current(document, state).await?;
                }
            }
        }
        "create-knowledge" => create_knowledge(document, state).await?,
        "edit-knowledge" => {
            if let Some(id) = id {
                edit_knowledge(document, state, &id).await?;
            }
        }
        "toggle-knowledge" => {
            if let (Some(genre_id), Some(id), Some(status)) = (
                state.borrow().current_genre_id.clone(),
                id,
                element.get_attribute("data-status"),
            ) {
                knowledge::set_item_status(&genre_id, &id, &status).await?;
                refresh_current(document, state).await?;
            }
        }
        "delete-knowledge" => {
            if let (Some(genre_id), Some(id)) = (state.borrow().current_genre_id.clone(), id) {
                if confirm("この知識を削除しますか？") {
                    knowledge::remove_item(&genre_id, &id).await?;
                    refresh_current(document, state).await?;
                }
            }
        }
        "accept-candidate" | "hold-candidate" | "reject-candidate" => {
            if let (Some(genre_id), Some(id)) = (state.borrow().current_genre_id.clone(), id) {
                let status = match action {
                    "accept-candidate" => "accepted",
                    "hold-candidate" => "on_hold",
                    _ => "rejected",
                };
                knowledge::set_candidate_status(&genre_id, &id, status).await?;
                refresh_current(document, state).await?;
            }
        }
        "open-chat" => open_chat(state).await?,
        "analyze-source" => alert("AI分析のRust接続を準備中です。"),
        _ => {}
    }
    Ok(())
}

fn bind_change(document: &Document, state: Rc<RefCell<State>>) -> Result<(), JsValue> {
    let document_for_event = document.clone();
    let handler = Closure::wrap(Box::new(move |event: Event| {
        let Some(element) = event
            .target()
            .and_then(|target| target.dyn_into::<Element>().ok())
        else {
            return;
        };
        let Some(field) = element.get_attribute("data-genre-field") else {
            return;
        };
        let value = element
            .clone()
            .dyn_into::<HtmlInputElement>()
            .map(|item| item.value())
            .or_else(|_| {
                element
                    .dyn_into::<HtmlTextAreaElement>()
                    .map(|item| item.value())
            })
            .unwrap_or_default();
        let Some(genre_id) = state.borrow().current_genre_id.clone() else {
            return;
        };
        let mut update = GenreUpdate::default();
        match field.as_str() {
            "name" => update.name = Some(value),
            "aliases" => update.aliases = Some(split(&value)),
            "description" => update.description = Some(value),
            "userDefinition" => update.user_definition = Some(value),
            "notes" => update.notes = Some(value),
            "tags" => update.tags = Some(split(&value)),
            _ => return,
        }
        let document = document_for_event.clone();
        let state = Rc::clone(&state);
        spawn_local(async move {
            match repository::update(&genre_id, update).await {
                Ok(_) => {
                    if let Err(error) = refresh_current(&document, &state).await {
                        report_error(error);
                    }
                }
                Err(error) => report_error(error),
            }
        });
    }) as Box<dyn FnMut(Event)>);
    document.add_event_listener_with_callback("change", handler.as_ref().unchecked_ref())?;
    handler.forget();
    Ok(())
}

fn set_tab(document: &Document, state: &Rc<RefCell<State>>, tab: Tab) -> Result<(), JsValue> {
    state.borrow_mut().current_tab = tab;
    super::render::all(document, &state.borrow())
}

async fn import_source(document: &Document, state: &Rc<RefCell<State>>) -> Result<(), JsValue> {
    let Some(genre_id) = state.borrow().current_genre_id.clone() else {
        return Ok(());
    };
    let Some(title) = prompt("資料のタイトルを入力してください", None) else {
        return Ok(());
    };
    let Some(content) = prompt("資料の本文を入力してください（Markdown形式）", None)
    else {
        return Ok(());
    };
    let source = sources::create(&genre_id, title.trim(), content.trim()).await?;
    state.borrow_mut().current_source_id = Some(source.metadata.id);
    state.borrow_mut().current_tab = Tab::Analysis;
    refresh_current(document, state).await
}

async fn create_knowledge(document: &Document, state: &Rc<RefCell<State>>) -> Result<(), JsValue> {
    let Some(genre_id) = state.borrow().current_genre_id.clone() else {
        return Ok(());
    };
    let Some(title) = prompt("知識のタイトル", None) else {
        return Ok(());
    };
    let Some(statement) = prompt("知識の内容", None) else {
        return Ok(());
    };
    knowledge::create_item(&genre_id, title, statement).await?;
    refresh_current(document, state).await
}

async fn edit_knowledge(
    document: &Document,
    state: &Rc<RefCell<State>>,
    item_id: &str,
) -> Result<(), JsValue> {
    let current = state.borrow();
    let Some(genre_id) = current.current_genre_id.clone() else {
        return Ok(());
    };
    let Some(item) = current
        .knowledge
        .as_ref()
        .and_then(|doc| doc.items.iter().find(|item| item.id == item_id))
        .cloned()
    else {
        return Ok(());
    };
    drop(current);
    let Some(title) = prompt("知識のタイトル", Some(&item.title)) else {
        return Ok(());
    };
    let Some(statement) = prompt("知識の内容", Some(&item.statement)) else {
        return Ok(());
    };
    knowledge::update_item(&genre_id, item_id, title, statement).await?;
    refresh_current(document, state).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenChatArgs<'a> {
    genre_id: &'a str,
}
async fn open_chat(state: &Rc<RefCell<State>>) -> Result<(), JsValue> {
    let Some(id) = state.borrow().current_genre_id.clone() else {
        return Ok(());
    };
    invoke::invoke::<_, ()>("open_genre_chat_window", &OpenChatArgs { genre_id: &id }).await
}

fn prompt(message: &str, default: Option<&str>) -> Option<String> {
    let window = web_sys::window()?;
    let value = match default {
        Some(value) => window
            .prompt_with_message_and_default(message, value)
            .ok()?,
        None => window.prompt_with_message(message).ok()?,
    }?;
    (!value.trim().is_empty()).then_some(value)
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
fn split(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_owned)
        .collect()
}
