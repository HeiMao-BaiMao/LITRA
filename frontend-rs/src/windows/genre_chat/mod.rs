mod events;
mod render;
mod tools;

use std::{cell::RefCell, rc::Rc};

use wasm_bindgen::prelude::*;
use web_sys::Document;

use crate::{
    data::genres::{
        chat::{self, Message, Thread},
        knowledge,
        models::Genre,
        repository,
    },
    runtime::{ai, tauri},
};

#[wasm_bindgen(
    inline_js = r#"export function genreIdFromLocation(){return new URLSearchParams(location.search).get('genreId') || '';}"#
)]
extern "C" {
    #[wasm_bindgen(js_name = genreIdFromLocation)]
    fn genre_id_from_location() -> String;
}

#[derive(Default)]
struct State {
    genre_id: Option<String>,
    genre: Option<Genre>,
    threads: Vec<Thread>,
    current_thread_id: Option<String>,
    messages: Vec<Message>,
    is_streaming: bool,
    catalog: Vec<ai::CatalogProvider>,
    selected_provider: Option<String>,
    selected_model: Option<String>,
}

pub async fn mount(document: &Document) -> Result<(), JsValue> {
    tauri::listen_dpi_zoom();
    let state = Rc::new(RefCell::new(State::default()));
    events::bind(document, Rc::clone(&state))?;
    events::listen(document.clone(), Rc::clone(&state)).await?;
    state.borrow_mut().catalog = ai::catalog().await.unwrap_or_default();
    if let Ok((provider, model)) = ai::selection("chat").await {
        let mut current = state.borrow_mut();
        current.selected_provider = Some(provider);
        current.selected_model = Some(model);
    }
    let genre_id = genre_id_from_location();
    if !genre_id.is_empty() {
        load_genre(document, &state, genre_id).await?;
    }
    Ok(())
}

async fn load_genre(
    document: &Document,
    state: &Rc<RefCell<State>>,
    genre_id: String,
) -> Result<(), JsValue> {
    let genre = repository::load(&genre_id).await?;
    let threads = chat::list(&genre_id).await?;
    let current_id = state
        .borrow()
        .current_thread_id
        .clone()
        .filter(|id| threads.iter().any(|thread| &thread.id == id))
        .or_else(|| threads.first().map(|thread| thread.id.clone()));
    let messages = match current_id.as_deref() {
        Some(id) => chat::load(&genre_id, id).await?.messages,
        None => Vec::new(),
    };
    let mut current = state.borrow_mut();
    current.genre_id = Some(genre_id);
    current.genre = Some(genre);
    current.threads = threads;
    current.current_thread_id = current_id;
    current.messages = messages;
    render::all(document, &current)
}

async fn refresh(document: &Document, state: &Rc<RefCell<State>>) -> Result<(), JsValue> {
    let Some(genre_id) = state.borrow().genre_id.clone() else {
        return Ok(());
    };
    load_genre(document, state, genre_id).await
}

async fn send(
    document: &Document,
    state: &Rc<RefCell<State>>,
    content: String,
) -> Result<(), JsValue> {
    let (genre_id, genre) = {
        let current = state.borrow();
        (current.genre_id.clone(), current.genre.clone())
    };
    let (Some(genre_id), Some(genre)) = (genre_id, genre) else {
        return Err(JsValue::from_str("ジャンルが選択されていません。"));
    };
    let thread_id = if let Some(id) = state.borrow().current_thread_id.clone() {
        id
    } else {
        let thread = chat::create(&genre_id, &content.chars().take(30).collect::<String>()).await?;
        state.borrow_mut().current_thread_id = Some(thread.id.clone());
        thread.id
    };
    let document_data =
        chat::append(&genre_id, &thread_id, "user", content, None, None, None).await?;
    {
        let mut current = state.borrow_mut();
        current.messages = document_data.messages.clone();
        current.is_streaming = true;
    }
    render::all(document, &state.borrow())?;
    let knowledge = knowledge::load(&genre_id).await?;
    let history = document_data
        .messages
        .iter()
        .rev()
        .take(40)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|message| format!("{}: {}", message.role, message.content))
        .collect::<Vec<_>>()
        .join("\n\n");
    let accepted = knowledge
        .items
        .iter()
        .filter(|item| item.status == "active")
        .map(|item| format!("- [{}] {}: {}", item.category, item.title, item.statement))
        .collect::<Vec<_>>()
        .join("\n");
    let system = format!("あなたは小説制作アプリLITRAのジャンル相談AIです。ジャンル『{}』について、保存済みの定義と会話を根拠に日本語で回答してください。保存知識にない内容は推測だと明示してください。\n\nジャンル説明: {}\nユーザー定義: {}\n\n採用済み知識:\n{}", genre.name, genre.description, genre.user_definition, accepted);
    let (provider, model) = {
        let current = state.borrow();
        (
            current.selected_provider.clone(),
            current.selected_model.clone(),
        )
    };
    let generated = tools::run(
        state,
        &genre_id,
        &thread_id,
        system,
        history,
        provider.as_deref(),
        model.as_deref(),
    )
    .await;
    state.borrow_mut().is_streaming = false;
    let generated = generated?;
    let document_data = chat::append(
        &genre_id,
        &thread_id,
        "assistant",
        generated.text,
        None,
        Some(generated.provider),
        Some(generated.model),
    )
    .await?;
    state.borrow_mut().messages = document_data.messages;
    refresh(document, state).await?;
    let payload = js_sys::Object::new();
    tauri::emit("genre-chat-sync", &payload);
    Ok(())
}

fn report(error: JsValue) {
    if let Some(window) = web_sys::window() {
        let _ = window.alert_with_message(&format!(
            "エラー: {}",
            error.as_string().unwrap_or_else(|| format!("{error:?}"))
        ));
    }
}
