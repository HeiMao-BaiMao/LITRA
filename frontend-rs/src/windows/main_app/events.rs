use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use js_sys::Reflect;
use serde_json::json;
use wasm_bindgen::{closure::Closure, JsCast, JsValue};
use wasm_bindgen_futures::spawn_local;
use web_sys::{Document, Element, Event, HtmlInputElement, HtmlSelectElement, HtmlTextAreaElement};

use super::{open_project, refresh_projects, report, select_episode, sync_children, State};
use crate::{
    data::{project_settings, projects},
    runtime::{tauri, windows},
};

pub fn bind(document: &Document, state: Rc<RefCell<State>>) -> Result<(), JsValue> {
    bind_click(document, Rc::clone(&state))?;
    bind_inputs(document, state)
}

fn bind_click(document: &Document, state: Rc<RefCell<State>>) -> Result<(), JsValue> {
    let event_document = document.clone();
    let handler = Closure::wrap(Box::new(move |event: Event| {
        let Some(target) = event
            .target()
            .and_then(|target| target.dyn_into::<Element>().ok())
        else {
            return;
        };
        let action_target = target
            .closest("[data-action]")
            .ok()
            .flatten()
            .unwrap_or(target);
        let action = action_target
            .get_attribute("data-action")
            .unwrap_or_else(|| {
                match action_target.id().as_str() {
                    "btn-projects" => "show-projects",
                    "btn-close-project-modal" => "hide-projects",
                    "btn-create-project" => "create-project",
                    "btn-new-episode" => "new-episode",
                    "btn-popout-summary" => "popout-summary",
                    "btn-popout-memo" => "popout-memo",
                    "btn-popout-chat" => "popout-chat",
                    "btn-popout-settings" => "popout-settings",
                    "nav-characters" | "nav-world" | "nav-relationships" => "popout-settings",
                    "btn-popout-memos" => "popout-memos",
                    "nav-memos" => "popout-memos",
                    "btn-genre-library" => "open-genres",
                    "btn-continue" => "continue",
                    "btn-rewrite" => "rewrite",
                    "btn-feedback" => "feedback",
                    "btn-generate-summary" => "generate-summary",
                    "btn-cancel" => "cancel-generation",
                    "btn-settings" => "open-ai-settings",
                    "btn-save-settings" => "save-ai-settings",
                    "btn-cancel-settings" => "cancel-ai-settings",
                    "btn-direct-writing" => "toggle-direct-writing",
                    "btn-oauth-login" => "oauth-login",
                    "btn-oauth-logout" => "oauth-logout",
                    "btn-oauth-cancel" => "oauth-cancel",
                    "btn-show-licenses" => "show-licenses",
                    "btn-close-licenses" => "close-licenses",
                    _ => "",
                }
                .into()
            });
        if action.is_empty() {
            return;
        }
        if action == "save-ai-settings" {
            event.prevent_default();
        }
        let id = action_target.get_attribute("data-id");
        let document = event_document.clone();
        let state = Rc::clone(&state);
        spawn_local(async move {
            if let Err(error) = handle_click(&document, &state, &action, id).await {
                report(error);
            }
        });
    }) as Box<dyn FnMut(Event)>);
    document.add_event_listener_with_callback("click", handler.as_ref().unchecked_ref())?;
    handler.forget();
    Ok(())
}

async fn handle_click(
    document: &Document,
    state: &Rc<RefCell<State>>,
    action: &str,
    id: Option<String>,
) -> Result<(), JsValue> {
    match action {
        "show-projects" => set_modal(document, false)?,
        "hide-projects" => set_modal(document, true)?,
        "create-project" => {
            let Some(input) = document
                .get_element_by_id("project-title-input")
                .and_then(|item| item.dyn_into::<HtmlInputElement>().ok())
            else {
                return Ok(());
            };
            let title = input.value().trim().to_owned();
            if !title.is_empty() {
                let project = projects::create(&title).await?;
                input.set_value("");
                refresh_projects(document, state).await?;
                open_project(document, state, project.id).await?;
                set_modal(document, true)?;
            }
        }
        "open-project" => {
            if let Some(id) = id {
                open_project(document, state, id).await?;
                set_modal(document, true)?;
            }
        }
        "delete-project" => {
            if let Some(id) = id {
                if confirm("このプロジェクトを削除しますか？") {
                    projects::remove(&id).await?;
                    if state
                        .borrow()
                        .current_project
                        .as_ref()
                        .map(|project| project.id.as_str())
                        == Some(&id)
                    {
                        *state.borrow_mut() = State {
                            summaries: json!({"summaries":{}}),
                            memos: json!({"memos":{}}),
                            ..Default::default()
                        };
                    }
                    refresh_projects(document, state).await?;
                    super::render::all(document, &state.borrow())?;
                }
            }
        }
        "new-episode" => {
            let Some(project_id) = state
                .borrow()
                .current_project
                .as_ref()
                .map(|project| project.id.clone())
            else {
                return Ok(());
            };
            let title = prompt(
                "エピソード名",
                &format!("第{}話", state.borrow().episodes.len() + 1),
            )
            .unwrap_or_else(|| "新規エピソード".into());
            let episode = projects::create_episode(&project_id, &title).await?;
            state.borrow_mut().episodes = projects::list_episodes(&project_id).await?;
            select_episode(document, state, episode.id).await?;
        }
        "select-episode" => {
            if let Some(id) = id {
                select_episode(document, state, id).await?;
            }
        }
        "rename-episode" => {
            if let Some(id) = id {
                let Some(project_id) = state
                    .borrow()
                    .current_project
                    .as_ref()
                    .map(|project| project.id.clone())
                else {
                    return Ok(());
                };
                let old = state
                    .borrow()
                    .episodes
                    .iter()
                    .find(|episode| episode.id == id)
                    .map(|episode| episode.title.clone())
                    .unwrap_or_default();
                if let Some(title) = prompt("エピソード名を変更", &old) {
                    projects::update_episode_title(&project_id, &id, &title).await?;
                    state.borrow_mut().episodes = projects::list_episodes(&project_id).await?;
                    super::render::all(document, &state.borrow())?;
                }
            }
        }
        "move-episode-up" | "move-episode-down" => {
            let (Some(project_id), Some(id)) = (
                state
                    .borrow()
                    .current_project
                    .as_ref()
                    .map(|project| project.id.clone()),
                id,
            ) else {
                return Ok(());
            };
            let mut ids = state
                .borrow()
                .episodes
                .iter()
                .map(|episode| episode.id.clone())
                .collect::<Vec<_>>();
            if let Some(index) = ids.iter().position(|episode_id| episode_id == &id) {
                let target = if action == "move-episode-up" {
                    index.checked_sub(1)
                } else if index + 1 < ids.len() {
                    Some(index + 1)
                } else {
                    None
                };
                if let Some(target) = target {
                    ids.swap(index, target);
                    projects::reorder_episodes(&project_id, &ids).await?;
                    state.borrow_mut().episodes = projects::list_episodes(&project_id).await?;
                    super::render::all(document, &state.borrow())?;
                }
            }
        }
        "delete-episode" => {
            if let Some(id) = id {
                let Some(project_id) = state
                    .borrow()
                    .current_project
                    .as_ref()
                    .map(|project| project.id.clone())
                else {
                    return Ok(());
                };
                if confirm("このエピソードを削除しますか？") {
                    projects::remove_episode(&project_id, &id).await?;
                    state.borrow_mut().episodes = projects::list_episodes(&project_id).await?;
                    let next = state
                        .borrow()
                        .episodes
                        .first()
                        .map(|episode| episode.id.clone());
                    if let Some(next) = next {
                        select_episode(document, state, next).await?;
                    } else {
                        state.borrow_mut().current_episode_id = None;
                        state.borrow_mut().editor_text.clear();
                        super::render::all(document, &state.borrow())?;
                    }
                }
            }
        }
        "popout-summary" => windows::open_managed_window(
            "summary",
            "summary-window.html",
            "エピソード要約",
            520.0,
            620.0,
        )
        .await
        .map(|_| ())?,
        "popout-memo" => {
            windows::open_managed_window("memo", "memo-window.html", "エピソードメモ", 520.0, 620.0)
                .await
                .map(|_| ())?
        }
        "popout-chat" => {
            windows::open_managed_window("chat", "chat-window.html", "リトラチャット", 620.0, 760.0)
                .await
                .map(|_| ())?
        }
        "popout-settings" => {
            windows::open_managed_window("settings", "settings-window.html", "設定", 820.0, 760.0)
                .await
                .map(|_| ())?
        }
        "popout-memos" => windows::open_managed_window(
            "project-memos",
            "project-memo-window.html",
            "プロジェクトメモ",
            760.0,
            680.0,
        )
        .await
        .map(|_| ())?,
        "open-genres" => windows::open_managed_window(
            "genre-library",
            "genre-library.html",
            "ジャンルライブラリ",
            1100.0,
            760.0,
        )
        .await
        .map(|_| ())?,
        "continue" => super::ai_actions::continue_story(document, state).await?,
        "rewrite" => super::ai_actions::rewrite_selection(document, state).await?,
        "feedback" => super::ai_actions::feedback_selection(document, state).await?,
        "generate-summary" => super::ai_actions::summary(document, state).await?,
        "cancel-generation" => super::ai_actions::cancel(document, state),
        "open-ai-settings" => super::settings::open(document, state).await?,
        "save-ai-settings" => super::settings::save(document, state).await?,
        "cancel-ai-settings" => super::settings::cancel(document)?,
        "oauth-login" | "oauth-logout" | "oauth-cancel" => {
            let provider = document
                .get_element_by_id("setting-provider")
                .and_then(|item| item.dyn_into::<HtmlSelectElement>().ok())
                .map(|select| select.value())
                .unwrap_or_default();
            match action {
                "oauth-login" => super::settings::start_oauth(document, &provider).await?,
                "oauth-logout" => super::settings::logout_oauth(document, &provider).await?,
                _ => super::settings::cancel_oauth(document, &provider).await?,
            }
        }
        "show-licenses" => super::settings::show_licenses(document)?,
        "close-licenses" => super::settings::close_licenses(document)?,
        "toggle-direct-writing" => {
            let next = !state.borrow().direct_writing;
            state.borrow_mut().direct_writing = next;
            super::render::all(document, &state.borrow())?;
            sync_children(&state.borrow());
        }
        _ => {}
    }
    Ok(())
}

fn bind_inputs(document: &Document, state: Rc<RefCell<State>>) -> Result<(), JsValue> {
    let timeout = Rc::new(Cell::new(None::<i32>));
    let handler_state = Rc::clone(&state);
    let timeout_state = Rc::clone(&timeout);
    let handler = Closure::wrap(Box::new(move |event: Event| {
        let Some(textarea) = event
            .target()
            .and_then(|target| target.dyn_into::<HtmlTextAreaElement>().ok())
        else {
            return;
        };
        let field = textarea.id();
        if !matches!(
            field.as_str(),
            "editor" | "episode-summary" | "episode-memo"
        ) {
            return;
        }
        let value = textarea.value();
        let (project_id, episode_id, file_name) = {
            let current = handler_state.borrow();
            (
                current
                    .current_project
                    .as_ref()
                    .map(|project| project.id.clone()),
                current.current_episode_id.clone(),
                current
                    .current_episode_id
                    .as_ref()
                    .and_then(|id| current.episodes.iter().find(|episode| &episode.id == id))
                    .map(|episode| episode.file_name.clone()),
            )
        };
        let (Some(project_id), Some(episode_id)) = (project_id, episode_id) else {
            return;
        };
        if field == "editor" {
            handler_state.borrow_mut().editor_text = value.clone();
        } else {
            set_document_content(&mut handler_state.borrow_mut(), &field, &episode_id, &value);
        }
        let Some(window) = web_sys::window() else {
            return;
        };
        if let Some(id) = timeout_state.take() {
            window.clear_timeout_with_handle(id);
        }
        let state = Rc::clone(&handler_state);
        let callback = Closure::once_into_js(move || {
            spawn_local(async move {
                let result = if field == "editor" {
                    if let Some(file_name) = file_name {
                        projects::write_episode(&project_id, &file_name, &value).await
                    } else {
                        Ok(())
                    }
                } else {
                    let current = state.borrow();
                    let document = if field == "episode-summary" {
                        current.summaries.clone()
                    } else {
                        current.memos.clone()
                    };
                    drop(current);
                    projects::write_document(
                        &project_id,
                        if field == "episode-summary" {
                            "summaries"
                        } else {
                            "memos"
                        },
                        &document,
                    )
                    .await
                };
                if let Err(error) = result {
                    report(error);
                }
            });
        });
        if let Ok(id) = window
            .set_timeout_with_callback_and_timeout_and_arguments_0(callback.unchecked_ref(), 400)
        {
            timeout_state.set(Some(id));
        }
    }) as Box<dyn FnMut(Event)>);
    document.add_event_listener_with_callback("input", handler.as_ref().unchecked_ref())?;
    handler.forget();
    bind_chat_form(document, Rc::clone(&state))?;
    bind_selectors(document, state)?;
    bind_webdav_toggle(document)?;
    Ok(())
}

fn bind_webdav_toggle(document: &Document) -> Result<(), JsValue> {
    let Some(input) = document
        .get_element_by_id("setting-webdav-enabled")
        .and_then(|item| item.dyn_into::<HtmlInputElement>().ok())
    else {
        return Ok(());
    };
    let event_document = document.clone();
    let handler = Closure::wrap(Box::new(move |_event: Event| {
        let _ = super::settings::integrations::update_enabled(&event_document);
    }) as Box<dyn FnMut(Event)>);
    input.add_event_listener_with_callback("change", handler.as_ref().unchecked_ref())?;
    handler.forget();
    Ok(())
}

fn bind_chat_form(document: &Document, state: Rc<RefCell<State>>) -> Result<(), JsValue> {
    let Some(form) = document.get_element_by_id("chat-form") else {
        return Ok(());
    };
    let event_document = document.clone();
    let handler = Closure::wrap(Box::new(move |event: Event| {
        event.prevent_default();
        let Some(input) = event_document
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
        let document = event_document.clone();
        let state = Rc::clone(&state);
        spawn_local(async move {
            if let Err(error) = super::ai_actions::chat(&document, &state, content).await {
                state.borrow_mut().is_generating = false;
                let _ = super::render::all(&document, &state.borrow());
                report(error);
            }
        });
    }) as Box<dyn FnMut(Event)>);
    form.add_event_listener_with_callback("submit", handler.as_ref().unchecked_ref())?;
    handler.forget();
    Ok(())
}

fn bind_selectors(document: &Document, state: Rc<RefCell<State>>) -> Result<(), JsValue> {
    let event_document = document.clone();
    let handler = Closure::wrap(Box::new(move |event: Event| {
        let Some(select) = event
            .target()
            .and_then(|target| target.dyn_into::<HtmlSelectElement>().ok())
        else {
            return;
        };
        if select.id() == "setting-provider" {
            let provider = select.value();
            let _ = super::settings::provider_changed(&event_document, &state, &provider);
        } else if select.id() == "chat-provider" {
            let provider = select.value();
            let model = state
                .borrow()
                .catalog
                .iter()
                .find(|item| item.id == provider)
                .and_then(|item| item.models.first())
                .map(|item| item.id.clone());
            let mut current = state.borrow_mut();
            current.selected_provider = Some(provider);
            current.selected_model = model;
        } else if select.id() == "chat-model" {
            state.borrow_mut().selected_model = Some(select.value());
        } else {
            return;
        }
        let _ = super::render::all(&event_document, &state.borrow());
    }) as Box<dyn FnMut(Event)>);
    document.add_event_listener_with_callback("change", handler.as_ref().unchecked_ref())?;
    handler.forget();
    Ok(())
}

pub(super) fn set_document_content(
    state: &mut State,
    field: &str,
    episode_id: &str,
    content: &str,
) {
    let target = if field == "episode-summary" {
        &mut state.summaries
    } else {
        &mut state.memos
    };
    let root = if field == "episode-summary" {
        "summaries"
    } else {
        "memos"
    };
    let entry = if field == "episode-summary" {
        json!({"content":content,"oneLiner":"","updatedAt":js_sys::Date::new_0().to_iso_string().as_string().unwrap_or_default()})
    } else {
        json!({"content":content,"updatedAt":js_sys::Date::new_0().to_iso_string().as_string().unwrap_or_default()})
    };
    if let Some(map) = target.get_mut(root).and_then(|value| value.as_object_mut()) {
        map.insert(episode_id.into(), entry);
    }
}

pub async fn listen_children(document: Document, state: Rc<RefCell<State>>) -> Result<(), JsValue> {
    for event in [
        "summary-ready",
        "memo-ready",
        "settings-ready",
        "project-memos-ready",
        "chat-ready",
    ] {
        let state = Rc::clone(&state);
        tauri::listen(
            event,
            Closure::wrap(
                Box::new(move |_payload: JsValue| sync_children(&state.borrow()))
                    as Box<dyn FnMut(JsValue)>,
            ),
        )
        .await?;
    }
    listen_update(
        "summary-update",
        "episode-summary",
        document.clone(),
        Rc::clone(&state),
    )
    .await?;
    listen_update(
        "memo-update",
        "episode-memo",
        document.clone(),
        Rc::clone(&state),
    )
    .await?;
    listen_settings(document.clone(), Rc::clone(&state)).await?;
    listen_project_memos(document.clone(), Rc::clone(&state)).await?;
    listen_chat(document, state).await
}

async fn listen_update(
    event_name: &str,
    field: &'static str,
    document: Document,
    state: Rc<RefCell<State>>,
) -> Result<(), JsValue> {
    tauri::listen(
        event_name,
        Closure::wrap(Box::new(move |payload: JsValue| {
            let episode_id = Reflect::get(&payload, &"episodeId".into())
                .ok()
                .and_then(|value| value.as_string());
            let content = Reflect::get(&payload, &"content".into())
                .ok()
                .and_then(|value| value.as_string());
            let (Some(episode_id), Some(content)) = (episode_id, content) else {
                return;
            };
            let Some(project_id) = state
                .borrow()
                .current_project
                .as_ref()
                .map(|project| project.id.clone())
            else {
                return;
            };
            set_document_content(&mut state.borrow_mut(), field, &episode_id, &content);
            let value = if field == "episode-summary" {
                state.borrow().summaries.clone()
            } else {
                state.borrow().memos.clone()
            };
            let kind = if field == "episode-summary" {
                "summaries"
            } else {
                "memos"
            };
            let document = document.clone();
            let state = Rc::clone(&state);
            spawn_local(async move {
                if let Err(error) = projects::write_document(&project_id, kind, &value).await {
                    report(error);
                } else {
                    let _ = super::render::all(&document, &state.borrow());
                }
            });
        }) as Box<dyn FnMut(JsValue)>),
    )
    .await
}

#[derive(Clone, Copy)]
enum ChildAction {
    CreateCharacter,
    UpdateCharacter,
    DeleteCharacter,
    SelectCharacter,
    CreateWorld,
    UpdateWorld,
    DeleteWorld,
    SelectWorld,
    SelectView,
    UpdateRelationships,
    CreateMemo,
    UpdateMemo,
    DeleteMemo,
    SelectMemo,
    ChatSend,
    ChatStop,
    DirectToggle,
    ChatSettings,
}

async fn listen_chat(document: Document, state: Rc<RefCell<State>>) -> Result<(), JsValue> {
    for (event, action) in [
        ("chat-send", ChildAction::ChatSend),
        ("chat-stop", ChildAction::ChatStop),
        ("chat-direct-writing-toggle", ChildAction::DirectToggle),
        ("chat-settings-change", ChildAction::ChatSettings),
    ] {
        register_child(event, action, document.clone(), Rc::clone(&state)).await?;
    }
    Ok(())
}

async fn listen_settings(document: Document, state: Rc<RefCell<State>>) -> Result<(), JsValue> {
    for (event, action) in [
        ("settings-create-character", ChildAction::CreateCharacter),
        ("settings-update-character", ChildAction::UpdateCharacter),
        ("settings-delete-character", ChildAction::DeleteCharacter),
        ("settings-select-character", ChildAction::SelectCharacter),
        ("settings-create-world", ChildAction::CreateWorld),
        ("settings-update-world", ChildAction::UpdateWorld),
        ("settings-delete-world", ChildAction::DeleteWorld),
        ("settings-select-world", ChildAction::SelectWorld),
        ("settings-select-view", ChildAction::SelectView),
        (
            "settings-update-relationships",
            ChildAction::UpdateRelationships,
        ),
    ] {
        register_child(event, action, document.clone(), Rc::clone(&state)).await?;
    }
    Ok(())
}

async fn listen_project_memos(
    document: Document,
    state: Rc<RefCell<State>>,
) -> Result<(), JsValue> {
    for (event, action) in [
        ("project-memos-create", ChildAction::CreateMemo),
        ("project-memos-update", ChildAction::UpdateMemo),
        ("project-memos-delete", ChildAction::DeleteMemo),
        ("project-memos-select", ChildAction::SelectMemo),
    ] {
        register_child(event, action, document.clone(), Rc::clone(&state)).await?;
    }
    Ok(())
}

async fn register_child(
    event: &'static str,
    action: ChildAction,
    document: Document,
    state: Rc<RefCell<State>>,
) -> Result<(), JsValue> {
    tauri::listen(
        event,
        Closure::wrap(Box::new(move |payload: JsValue| {
            let value = serde_wasm_bindgen::from_value::<serde_json::Value>(payload)
                .unwrap_or_else(|_| json!({}));
            let document = document.clone();
            let state = Rc::clone(&state);
            spawn_local(async move {
                if let Err(error) = apply_child(action, &document, &state, value).await {
                    report(error);
                }
            });
        }) as Box<dyn FnMut(JsValue)>),
    )
    .await
}

async fn apply_child(
    action: ChildAction,
    document: &Document,
    state: &Rc<RefCell<State>>,
    payload: serde_json::Value,
) -> Result<(), JsValue> {
    let Some(project_id) = state
        .borrow()
        .current_project
        .as_ref()
        .map(|project| project.id.clone())
    else {
        return Ok(());
    };
    match action {
        ChildAction::CreateCharacter => {
            if let Some(name) = payload.get("name").and_then(|value| value.as_str()) {
                let doc = project_settings::create_character(&project_id, name).await?;
                state.borrow_mut().characters = doc
                    .get("characters")
                    .and_then(|value| value.as_array())
                    .cloned()
                    .unwrap_or_default();
            }
        }
        ChildAction::UpdateCharacter => {
            if let Some(value) = payload.get("character") {
                let doc = project_settings::update_character(&project_id, value).await?;
                state.borrow_mut().characters = doc
                    .get("characters")
                    .and_then(|value| value.as_array())
                    .cloned()
                    .unwrap_or_default();
            }
        }
        ChildAction::DeleteCharacter => {
            if let Some(id) = payload.get("id").and_then(|value| value.as_str()) {
                let doc = project_settings::delete_character(&project_id, id).await?;
                let mut current = state.borrow_mut();
                current.characters = doc
                    .get("characters")
                    .and_then(|value| value.as_array())
                    .cloned()
                    .unwrap_or_default();
                current.current_character_id = current
                    .characters
                    .first()
                    .and_then(|value| value.get("id")?.as_str())
                    .map(str::to_owned);
            }
        }
        ChildAction::SelectCharacter => {
            state.borrow_mut().current_character_id = payload
                .get("id")
                .and_then(|value| value.as_str())
                .map(str::to_owned)
        }
        ChildAction::CreateWorld => {
            let name = payload
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or("新規項目");
            let category = payload
                .get("category")
                .and_then(|value| value.as_str())
                .unwrap_or("other");
            let doc = project_settings::create_world(&project_id, name, category).await?;
            state.borrow_mut().world_entries = doc
                .get("entries")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_default();
        }
        ChildAction::UpdateWorld => {
            if let Some(value) = payload.get("entry") {
                let doc = project_settings::update_world(&project_id, value).await?;
                state.borrow_mut().world_entries = doc
                    .get("entries")
                    .and_then(|value| value.as_array())
                    .cloned()
                    .unwrap_or_default();
            }
        }
        ChildAction::DeleteWorld => {
            if let Some(id) = payload.get("id").and_then(|value| value.as_str()) {
                let doc = project_settings::delete_world(&project_id, id).await?;
                let mut current = state.borrow_mut();
                current.world_entries = doc
                    .get("entries")
                    .and_then(|value| value.as_array())
                    .cloned()
                    .unwrap_or_default();
                current.current_world_entry_id = current
                    .world_entries
                    .first()
                    .and_then(|value| value.get("id")?.as_str())
                    .map(str::to_owned);
            }
        }
        ChildAction::SelectWorld => {
            state.borrow_mut().current_world_entry_id = payload
                .get("id")
                .and_then(|value| value.as_str())
                .map(str::to_owned)
        }
        ChildAction::SelectView => {
            state.borrow_mut().current_view = payload
                .get("view")
                .and_then(|value| value.as_str())
                .unwrap_or("characters")
                .into()
        }
        ChildAction::UpdateRelationships => {
            if let Some(map) = payload.get("map") {
                state.borrow_mut().relationships = map.clone();
                projects::write_document(&project_id, "relationships", map).await?;
            }
        }
        ChildAction::CreateMemo => {
            if let Some(title) = payload.get("title").and_then(|value| value.as_str()) {
                let memo = project_settings::create_memo(&project_id, title).await?;
                let id = memo
                    .get("id")
                    .and_then(|value| value.as_str())
                    .map(str::to_owned);
                let mut current = state.borrow_mut();
                current.project_memos.push(memo);
                current.current_memo_id = id;
            }
        }
        ChildAction::UpdateMemo => {
            let id = payload
                .get("id")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            let title = payload.get("title").and_then(|value| value.as_str());
            let content = payload.get("content").and_then(|value| value.as_str());
            let memo = project_settings::update_memo(&project_id, id, title, content).await?;
            if let Some(position) = state
                .borrow()
                .project_memos
                .iter()
                .position(|item| item.get("id").and_then(|value| value.as_str()) == Some(id))
            {
                state.borrow_mut().project_memos[position] = memo;
            }
        }
        ChildAction::DeleteMemo => {
            if let Some(id) = payload.get("id").and_then(|value| value.as_str()) {
                project_settings::delete_memo(&project_id, id).await?;
                let mut current = state.borrow_mut();
                current
                    .project_memos
                    .retain(|item| item.get("id").and_then(|value| value.as_str()) != Some(id));
                current.current_memo_id = current
                    .project_memos
                    .first()
                    .and_then(|item| item.get("id")?.as_str())
                    .map(str::to_owned);
            }
        }
        ChildAction::SelectMemo => {
            state.borrow_mut().current_memo_id = payload
                .get("id")
                .and_then(|value| value.as_str())
                .map(str::to_owned)
        }
        ChildAction::ChatSend => {
            if let Some(content) = payload.get("content").and_then(|value| value.as_str()) {
                super::ai_actions::chat(document, state, content.to_owned()).await?;
            }
        }
        ChildAction::ChatStop => super::ai_actions::cancel(document, state),
        ChildAction::DirectToggle => {
            let next = !state.borrow().direct_writing;
            state.borrow_mut().direct_writing = next;
        }
        ChildAction::ChatSettings => {
            if let Some(provider) = payload.get("provider").and_then(|value| value.as_str()) {
                state.borrow_mut().selected_provider = Some(provider.into());
            }
            if let Some(model) = payload.get("model").and_then(|value| value.as_str()) {
                state.borrow_mut().selected_model = Some(model.into());
            }
        }
    }
    super::render::all(document, &state.borrow())?;
    sync_children(&state.borrow());
    Ok(())
}

fn set_modal(document: &Document, hidden: bool) -> Result<(), JsValue> {
    if let Some(modal) = document.get_element_by_id("project-modal") {
        modal.class_list().toggle_with_force("hidden", hidden)?;
    }
    Ok(())
}
fn prompt(message: &str, default: &str) -> Option<String> {
    let value = web_sys::window()?
        .prompt_with_message_and_default(message, default)
        .ok()??;
    (!value.trim().is_empty()).then(|| value.trim().into())
}
fn confirm(message: &str) -> bool {
    web_sys::window()
        .and_then(|window| window.confirm_with_message(message).ok())
        .unwrap_or(false)
}
