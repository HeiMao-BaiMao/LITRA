use std::{cell::RefCell, collections::BTreeMap, rc::Rc};

use wasm_bindgen::{JsCast, JsValue};
use web_sys::{Document, HtmlTextAreaElement};

use super::{ChatMessage, State};
use crate::{data::projects, runtime::ai};

pub async fn continue_story(
    document: &Document,
    state: &Rc<RefCell<State>>,
) -> Result<(), JsValue> {
    let context = state
        .borrow()
        .editor_text
        .chars()
        .rev()
        .take(24000)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    if context.trim().is_empty() {
        return Err(JsValue::from_str("本文が空です。"));
    }
    generating(document, state, true)?;
    let settings = state.borrow().ai_settings.clone();
    let result = super::generation::continue_story(&settings, &context).await;
    generating(document, state, false)?;
    let generated = result?;
    let addition = generated.text.trim_start();
    let mut current = state.borrow_mut();
    if !current.editor_text.ends_with('\n') {
        current.editor_text.push('\n');
    }
    current.editor_text.push_str(addition);
    save_editor(&current).await?;
    super::render::all(document, &current)
}

pub async fn rewrite_selection(
    document: &Document,
    state: &Rc<RefCell<State>>,
) -> Result<(), JsValue> {
    let editor = editor(document)?;
    let start_utf16 = editor.selection_start()?.unwrap_or(0) as usize;
    let end_utf16 = editor.selection_end()?.unwrap_or(0) as usize;
    let text = editor.value();
    let (Some(start), Some(end)) = (
        utf16_to_byte(&text, start_utf16),
        utf16_to_byte(&text, end_utf16),
    ) else {
        return Err(JsValue::from_str("選択範囲が不正です。"));
    };
    if start >= end {
        return Err(JsValue::from_str("書き直す範囲を選択してください。"));
    }
    let selected = &text[start..end];
    let before = text[..start]
        .chars()
        .rev()
        .take(6_000)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    let after = text[end..].chars().take(3_000).collect::<String>();
    let context = format!("【直前】\n{before}\n\n【対象直後】\n{after}");
    let settings = state.borrow().ai_settings.clone();
    generating(document, state, true)?;
    let result = super::generation::rewrite_passage(&settings, &context, selected).await;
    generating(document, state, false)?;
    let generated = result?;
    let mut next = text[..start].to_owned();
    next.push_str(generated.text.trim());
    next.push_str(&text[end..]);
    state.borrow_mut().editor_text = next;
    save_editor(&state.borrow()).await?;
    super::render::all(document, &state.borrow())
}

pub async fn feedback_selection(
    document: &Document,
    state: &Rc<RefCell<State>>,
) -> Result<(), JsValue> {
    let editor = editor(document)?;
    let start_utf16 = editor.selection_start()?.unwrap_or(0) as usize;
    let end_utf16 = editor.selection_end()?.unwrap_or(0) as usize;
    let text = editor.value();
    let (Some(start), Some(end)) = (
        utf16_to_byte(&text, start_utf16),
        utf16_to_byte(&text, end_utf16),
    ) else {
        return Err(JsValue::from_str("選択範囲が不正です。"));
    };
    if start >= end {
        return Err(JsValue::from_str("講評する範囲を選択してください。"));
    }
    let prompt = format!(
        "次の小説本文を、文体、視点、構成、読みやすさの観点から具体的に講評してください。\n\n{}",
        &text[start..end]
    );
    generating(document, state, true)?;
    let result = generate(
        state,
        "judgment",
        "あなたは率直で建設的な小説編集者です。".into(),
        prompt,
    )
    .await;
    generating(document, state, false)?;
    let generated = result?;
    push_assistant(document, state, generated.text).await
}

pub async fn chat(
    document: &Document,
    state: &Rc<RefCell<State>>,
    content: String,
) -> Result<(), JsValue> {
    state.borrow_mut().chat.push(ChatMessage {
        role: "user".into(),
        content,
        thinking: None,
        extra: BTreeMap::new(),
    });
    save_chat(&state.borrow()).await?;
    super::render::all(document, &state.borrow())?;
    let current = state.borrow();
    let history = current
        .chat
        .iter()
        .rev()
        .take(30)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|message| format!("{}: {}", message.role, message.content))
        .collect::<Vec<_>>()
        .join("\n\n");
    let editor_context = current
        .editor_text
        .chars()
        .rev()
        .take(12000)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    let direct = current.direct_writing;
    drop(current);
    let prompt = format!("現在の本文末尾:\n{editor_context}\n\n会話:\n{history}");
    generating(document, state, true)?;
    let system = if direct {
        "あなたは日本語小説の執筆者です。最後のユーザー指示に従って、現在の本文へ追記する小説本文だけを返してください。説明や前置きは禁止です。"
    } else {
        "あなたは小説制作アプリLITRAの相談AIです。日本語で具体的に答えてください。"
    };
    let result = if direct {
        generate(state, "chat", system.into(), prompt).await
    } else {
        super::agent_tools::run(state, system.into(), prompt).await
    };
    generating(document, state, false)?;
    let result = result?;
    if direct {
        {
            let mut current = state.borrow_mut();
            if !current.editor_text.ends_with('\n') {
                current.editor_text.push('\n');
            }
            current.editor_text.push_str(result.text.trim_start());
        }
        save_editor(&state.borrow()).await?;
        push_assistant(document, state, "本文へ直接反映しました。".into()).await
    } else {
        push_assistant(document, state, result.text).await
    }
}

pub async fn summary(document: &Document, state: &Rc<RefCell<State>>) -> Result<(), JsValue> {
    let text = state.borrow().editor_text.clone();
    if text.trim().is_empty() {
        return Err(JsValue::from_str("本文が空です。"));
    }
    generating(document, state, true)?;
    let result = generate(state, "background", "あなたは小説の要約者です。本文にない事実を加えず、日本語で簡潔なあらすじだけを返してください。".into(), text).await;
    generating(document, state, false)?;
    let (project_id, episode_id) = {
        let current = state.borrow();
        (
            current
                .current_project
                .as_ref()
                .map(|project| project.id.clone()),
            current.current_episode_id.clone(),
        )
    };
    let (Some(project_id), Some(episode_id)) = (project_id, episode_id) else {
        return Ok(());
    };
    super::events::set_document_content(
        &mut state.borrow_mut(),
        "episode-summary",
        &episode_id,
        result?.text.trim(),
    );
    let value = state.borrow().summaries.clone();
    projects::write_document(&project_id, "summaries", &value).await?;
    super::render::all(document, &state.borrow())
}

pub fn cancel(document: &Document, state: &Rc<RefCell<State>>) {
    ai::cancel_active();
    state.borrow_mut().is_generating = false;
    let _ = super::render::all(document, &state.borrow());
}

async fn generate(
    state: &Rc<RefCell<State>>,
    role: &str,
    system: String,
    prompt: String,
) -> Result<ai::GeneratedText, JsValue> {
    let current = state.borrow();
    let provider = (role == "chat")
        .then(|| current.selected_provider.clone())
        .flatten();
    let model = (role == "chat")
        .then(|| current.selected_model.clone())
        .flatten();
    drop(current);
    ai::generate_with(role, system, prompt, provider.as_deref(), model.as_deref()).await
}
async fn push_assistant(
    document: &Document,
    state: &Rc<RefCell<State>>,
    content: String,
) -> Result<(), JsValue> {
    state.borrow_mut().chat.push(ChatMessage {
        role: "assistant".into(),
        content,
        thinking: None,
        extra: BTreeMap::new(),
    });
    save_chat(&state.borrow()).await?;
    super::render::all(document, &state.borrow())
}
async fn save_chat(state: &State) -> Result<(), JsValue> {
    let Some(project) = &state.current_project else {
        return Ok(());
    };
    let value =
        serde_json::to_value(&state.chat).map_err(|error| JsValue::from_str(&error.to_string()))?;
    projects::write_document(&project.id, "chat", &value).await
}
async fn save_editor(state: &State) -> Result<(), JsValue> {
    let (Some(project), Some(id)) = (&state.current_project, &state.current_episode_id) else {
        return Ok(());
    };
    let Some(episode) = state.episodes.iter().find(|episode| &episode.id == id) else {
        return Ok(());
    };
    projects::write_episode(&project.id, &episode.file_name, &state.editor_text).await
}
fn editor(document: &Document) -> Result<HtmlTextAreaElement, JsValue> {
    document
        .get_element_by_id("editor")
        .and_then(|item| item.dyn_into::<HtmlTextAreaElement>().ok())
        .ok_or_else(|| JsValue::from_str("editor missing"))
}
fn generating(document: &Document, state: &Rc<RefCell<State>>, value: bool) -> Result<(), JsValue> {
    state.borrow_mut().is_generating = value;
    super::render::all(document, &state.borrow())
}

fn utf16_to_byte(text: &str, target: usize) -> Option<usize> {
    if target == 0 {
        return Some(0);
    }
    let mut units = 0;
    for (byte, character) in text.char_indices() {
        if units == target {
            return Some(byte);
        }
        units += character.len_utf16();
        if units > target {
            return None;
        }
    }
    (units == target).then_some(text.len())
}
