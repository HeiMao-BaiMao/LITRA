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
    bind_resizer(document)?;
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

fn bind_resizer(document: &Document) -> Result<(), JsValue> {
    use crate::data::layout_store;
    use crate::ui::resizable::{
        apply_stored_ratio, create_vertical_resizer, ResizerConfig, ResizerPosition,
    };
    use wasm_bindgen::JsCast;

    let Some(el) = document
        .get_element_by_id("genre-chat-app")
        .and_then(|el| el.dyn_into::<web_sys::HtmlElement>().ok())
    else {
        return Ok(());
    };
    apply_stored_ratio(
        el.clone(),
        "--genre-chat-sidebar-width",
        layout_store::PANEL_GENRE_CHAT_SIDEBAR,
        0.22,
    );
    let _ = create_vertical_resizer(
        document,
        ResizerConfig::new(
            el,
            "--genre-chat-sidebar-width",
            ResizerPosition::Left,
            layout_store::PANEL_GENRE_CHAT_SIDEBAR,
        ),
    )?;
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

const LENGTH_CONTINUATION_PROMPT: &str =
    "前の応答は出力上限で途中で切れています。すでに書いた内容を繰り返さず、直前の文から自然に続きを書いてください。前置き、見出し、注釈は不要です。";
const MAX_LENGTH_CONTINUATIONS: usize = 2;

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
    let system = crate::data::genres::prompts::chat_system(&genre, &knowledge);
    let (provider, model) = {
        let current = state.borrow();
        (
            current.selected_provider.clone(),
            current.selected_model.clone(),
        )
    };

    // Add a pending assistant message for streaming display
    let pending_index = {
        let mut current = state.borrow_mut();
        current.messages.push(Message {
            id: String::new(),
            thread_id: thread_id.clone(),
            role: "assistant".into(),
            content: String::new(),
            thinking: None,
            provider: None,
            model: None,
            finish_reason: None,
            attachments: Vec::new(),
            created_at: String::new(),
            extra: std::collections::BTreeMap::new(),
        });
        current.messages.len() - 1
    };
    render::all(document, &state.borrow())?;

    // Run with streaming and length auto-continuation
    let mut continuation_count = 0;
    let mut accumulated_text = String::new();
    let mut accumulated_thinking = String::new();
    let mut final_provider = String::new();
    let mut final_model = String::new();

    let mut current_prompt = history;
    let result: Result<(), JsValue> = loop {
        // Reset pending message content before each run (for continuations)
        if continuation_count > 0 {
            if let Some(msg) = state.borrow_mut().messages.get_mut(pending_index) {
                msg.content.clear();
                msg.thinking = None;
            }
        }
        let generated = tools::run(
            document,
            state,
            &genre_id,
            &thread_id,
            system.clone(),
            current_prompt.clone(),
            provider.as_deref(),
            model.as_deref(),
            pending_index,
        )
        .await;
        match generated {
            Ok(ref gen)
                if gen.finish_reason.as_deref() == Some("length")
                    && !gen.text.trim().is_empty()
                    && continuation_count < MAX_LENGTH_CONTINUATIONS =>
            {
                continuation_count += 1;
                accumulated_text.push_str(&gen.text);
                if let Some(msg) = state.borrow().messages.get(pending_index) {
                    if let Some(thinking) = &msg.thinking {
                        accumulated_thinking.push_str(thinking);
                    }
                }
                final_provider = gen.provider.clone();
                final_model = gen.model.clone();
                // Build continuation prompt with accumulated context
                current_prompt = format!(
                    "{}\n\nassistant: {}\n\nuser: {}",
                    current_prompt, accumulated_text, LENGTH_CONTINUATION_PROMPT
                );
                continue;
            }
            Ok(gen) => {
                accumulated_text.push_str(&gen.text);
                if let Some(msg) = state.borrow().messages.get(pending_index) {
                    if let Some(thinking) = &msg.thinking {
                        if !accumulated_thinking.is_empty() {
                            accumulated_thinking.push('\n');
                        }
                        accumulated_thinking.push_str(thinking);
                    }
                }
                final_provider = gen.provider;
                final_model = gen.model;
                break Ok(());
            }
            Err(error) => break Err(error),
        }
    };

    // Remove the pending message from state
    state.borrow_mut().messages.pop();
    state.borrow_mut().is_streaming = false;

    result?;

    // Persist the assistant message with thinking
    let thinking = if accumulated_thinking.trim().is_empty() {
        None
    } else {
        Some(accumulated_thinking)
    };
    let document_data = chat::append(
        &genre_id,
        &thread_id,
        "assistant",
        accumulated_text,
        thinking,
        Some(final_provider),
        Some(final_model),
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
