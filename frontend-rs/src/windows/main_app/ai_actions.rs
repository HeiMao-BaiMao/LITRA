use std::{cell::RefCell, rc::Rc};

use wasm_bindgen::{JsCast, JsValue};
use web_sys::{Document, HtmlTextAreaElement};

use super::{sync_children, ChatMessage, State};
use crate::{
    ai::cache_observability,
    data::projects,
    runtime::{ai, tauri},
};

/// 旧TS `systemPrompt` — 編集パートナーの役割定義。完成・洗礼済み。
pub(crate) const EDITORIAL_PARTNER_SYSTEM_PROMPT: &str =
    include_str!("system_prompt.txt");
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
    let settings_context = {
        let current = state.borrow();
        format!(
            "プロジェクト: {}\nエピソード: {}\n",
            current.current_project.as_ref().map(|p| p.title.as_str()).unwrap_or(""),
            current.current_episode_id.as_deref().unwrap_or(""),
        )
    };
    let prompt = crate::windows::main_app::generation::old_prompts::feedback(
        &text[start..end],
        &settings_context,
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
    let command = content.trim();
    if command == "/clear" || command == "/new" {
        if command == "/new" {
            ai::cancel_active();
        }
        {
            let mut current = state.borrow_mut();
            current.chat.clear();
            current.is_generating = false;
        }
        save_chat(&state.borrow()).await?;
        tauri::emit("chat-clear-display", &JsValue::NULL);
        super::render::all(document, &state.borrow())?;
        sync_children(&state.borrow());
        return Ok(());
    }
    state.borrow_mut().chat.push(ChatMessage {
        role: "user".into(),
        content,
        thinking: None,
        exclude_from_context: false,
        id: None,
        created_at: None,
        transport: None,
    });
    save_chat(&state.borrow()).await?;
    super::render::all(document, &state.borrow())?;
    sync_children(&state.borrow());
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
    let direct = current.direct_writing;
    let editor_context = current
        .editor_text
        .chars()
        .rev()
        .take(12000)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    drop(current);

    let prompt = if direct {
        format!("現在の本文（末尾最大12000文字）:\n{editor_context}\n\n【依頼】\n{history}")
    } else {
        // TS版と同様: チャット履歴をそのまま渡す。
        // システムプロンプト（編集パートナー + ツールガイダンス）だけで
        // チャット応答とツール呼出のバランスを取る。余計なプレフィックスは不要。
        history
    };
    generating(document, state, true)?;
    let system = EDITORIAL_PARTNER_SYSTEM_PROMPT.to_string();
    let result = super::agent_tools::run(state, system, prompt, direct).await;
    generating(document, state, false)?;
    let result = result?;
    if direct {
        push_assistant(
            document,
            state,
            if result.text.trim().is_empty() {
                "本文を編集しました。".to_string()
            } else {
                result.text
            },
        )
        .await
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
    let prompt = crate::windows::main_app::generation::old_prompts::summary_episode(&text, None, None);
    let result = generate(state, "background", super::ai_actions::EDITORIAL_PARTNER_SYSTEM_PROMPT.into(), prompt).await;
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
    super::render::all(document, &state.borrow())?;
    sync_children(&state.borrow());
    Ok(())
}

pub fn cancel(document: &Document, state: &Rc<RefCell<State>>) {
    ai::cancel_active();
    // 進行中の AbortController を解放
    if let Some(controller) = state.borrow_mut().abort_controller.take() {
        let _ = controller.abort();
    }
    state.borrow_mut().is_generating = false;
    let _ = super::render::all(document, &state.borrow());
    sync_children(&state.borrow());
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
    let result = ai::generate_with(role, system, prompt, provider.as_deref(), model.as_deref()).await?;
    // キャッシュ使用量を記録（非同期・ベストエフォート）
    let _ = cache_observability::record_provider_cache_usage(
        role,
        &result.provider,
        &result.model,
        &serde_json::Value::Null, // provider_metadata は現状の ai::generate_with では取得不可
    );
    Ok(result)
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
        exclude_from_context: false,
        id: None,
        created_at: None,
        transport: None,
    });
    super::render::all(document, &state.borrow())?;
    sync_children(&state.borrow());
    Ok(())
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
    super::render::all(document, &state.borrow())?;
    sync_children(&state.borrow());
    Ok(())
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
