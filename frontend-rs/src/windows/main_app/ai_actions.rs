use std::{cell::RefCell, rc::Rc};

use wasm_bindgen::{JsCast, JsValue};
use web_sys::{Document, HtmlTextAreaElement};

use super::{sync_chat, sync_summary, ChatMessage, State};
use crate::{
    ai::cache_observability,
    data::projects,
    runtime::{ai, tauri},
};

/// 生成ステージの内部説明を TS と同じボタン表示用ラベルに変換する。
/// 戻り値: (ラベル, 判断系モデルを使うか)
fn stage_display_label(stage: &str) -> (&'static str, bool) {
    match stage {
        "場面状態を整理中" | "人物の話し方を整理中" => ("準備中…", true),
        "構想を作成中" => ("構想中…", true),
        "ビートごとに本文を生成中" | "本文候補を生成中" | "第2候補を生成中"
        | "機械検査の指摘を再生成中" => ("執筆中…", false),
        "候補を比較中" => ("比較中…", true),
        "判断モデルで査読中" => ("査読中…", true),
        "査読結果から改稿中" => ("改稿中…", false),
        "改稿の回帰を確認中" => ("検証中…", true),
        _ => ("生成中…", false),
    }
}

/// AI 設定からステージ表示用のモデル名を取得する。
/// TS の `stageModelLabel` / `truncateModelLabel` に相当。
fn stage_model_label(settings: &serde_json::Value, judgment: bool) -> String {
    let key = if judgment {
        "judgmentModel"
    } else {
        "writingModel"
    };
    let source_key = if judgment {
        "judgmentModelSource"
    } else {
        "writingModelSource"
    };
    let source = settings
        .get(source_key)
        .and_then(serde_json::Value::as_str)
        .unwrap_or("main");
    let model = if source != "main" {
        settings
            .get(key)
            .and_then(serde_json::Value::as_str)
            .filter(|m| !m.trim().is_empty())
            .or_else(|| settings.get("model").and_then(serde_json::Value::as_str))
            .unwrap_or_default()
    } else {
        settings
            .get("model")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
    };
    truncate_model_label(model)
}

/// 長いモデル ID をボタン表示用に切り詰める（TS `truncateModelLabel` 相当）。
fn truncate_model_label(label: &str) -> String {
    const MAX_CHARS: usize = 20;
    if label.chars().count() <= MAX_CHARS {
        label.to_owned()
    } else {
        let truncated: String = label.chars().take(MAX_CHARS).collect();
        format!("{truncated}…")
    }
}

/// 旧TS `systemPrompt` — 編集パートナーの役割定義。完成・洗礼済み。
pub(crate) const EDITORIAL_PARTNER_SYSTEM_PROMPT: &str = include_str!("system_prompt.txt");
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
    let (settings, project_id, episode_id, mut references) = {
        let current = state.borrow();
        let settings = current.ai_settings.clone();
        (
            settings.clone(),
            current
                .current_project
                .as_ref()
                .map(|project| project.id.clone()),
            current.current_episode_id.clone(),
            super::prompt_context::fiction_references(&current, &settings, &context),
        )
    };
    if let Some(project_id) = project_id.as_deref() {
        references.related_scenes = super::prompt_context::build_related_scenes(
            project_id,
            episode_id.as_deref(),
            &references.character_names,
        )
        .await;
        if let Some(related) = references.related_scenes.as_ref() {
            references.character_excerpts = format!("{context}\n\n{related}");
        }
    }
    // TS handleContinue: ボタンにステージラベルを表示し、完了後に元に戻す
    let btn_continue = document.get_element_by_id("btn-continue");
    let original_label = btn_continue
        .as_ref()
        .and_then(|btn| btn.text_content());
    let result = super::generation::continue_story_with_references_progress(
        &settings,
        &context,
        "自然に続きを執筆する",
        &references,
        |stage| {
            if let Some(btn) = document.get_element_by_id("btn-continue") {
                let (label, judgment) = stage_display_label(stage);
                let model = stage_model_label(&settings, judgment);
                btn.set_text_content(Some(&format!("{label}〔{model}〕")));
            }
        },
    )
    .await;
    // finally: ボタンラベルを復元
    if let Some(btn) = btn_continue.as_ref() {
        btn.set_text_content(original_label.as_deref());
    }
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
    let (settings, references) = {
        let current = state.borrow();
        let settings = current.ai_settings.clone();
        let references = super::prompt_context::fiction_references(&current, &settings, &context);
        (settings, references)
    };
    generating(document, state, true)?;
    let result = super::generation::rewrite_passage_with_references(
        &settings,
        &context,
        selected,
        "選択範囲を前後の文脈になじむように推敲する",
        &references,
    )
    .await;
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
        super::prompt_context::build_settings_context(&current, &current.ai_settings)
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
    if command == "/clear" {
        // /clear: 表示のみクリア（履歴は保持）— TS版相当
        tauri::emit("chat-clear-display", &JsValue::NULL);
        return Ok(());
    }
    if command == "/new" {
        // /new: 履歴をクリア + 生成を中止
        ai::cancel_active();
        {
            let mut current = state.borrow_mut();
            current.chat.clear();
            current.is_generating = false;
        }
        save_chat(state).await?;
        tauri::emit("chat-clear-display", &JsValue::NULL);
        super::render::all(document, &state.borrow())?;
        sync_chat(&state.borrow());
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
    save_chat(state).await?;
    super::render::all(document, &state.borrow())?;
    sync_chat(&state.borrow());
    let current = state.borrow();
    let mut messages = current
        .chat
        .iter()
        .filter(|message| {
            !message.exclude_from_context
                && !message.content.trim().is_empty()
                && matches!(message.role.as_str(), "user" | "assistant")
        })
        .rev()
        .take(30)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|message| {
            serde_json::json!({
                "role": message.role,
                "content": message.content,
            })
        })
        .collect::<Vec<_>>();
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

    if direct {
        if let Some(last_user) = messages
            .iter_mut()
            .rev()
            .find(|message| message.get("role").and_then(|value| value.as_str()) == Some("user"))
        {
            let request = last_user
                .get("content")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_owned();
            last_user["content"] = serde_json::Value::String(format!(
                "現在の本文（末尾最大12000文字）:\n{editor_context}\n\n【依頼】\n{request}"
            ));
        }
    }
    generating(document, state, true)?;
    let system = EDITORIAL_PARTNER_SYSTEM_PROMPT.to_string();

    const LENGTH_CONTINUATION_PROMPT: &str =
        "前の応答は出力上限で途中で切れています。すでに書いた内容を繰り返さず、直前の文から自然に続きを書いてください。前置き、見出し、注釈は不要です。";
    const MAX_LENGTH_CONTINUATIONS: usize = 2;

    let mut continuation_count = 0;
    let result = loop {
        let run_result =
            super::agent_tools::run(document, state, system.clone(), messages.clone(), direct)
                .await;
        match run_result {
            Ok(ref generated)
                if generated.finish_reason.as_deref() == Some("length")
                    && !generated.text.trim().is_empty()
                    && continuation_count < MAX_LENGTH_CONTINUATIONS =>
            {
                continuation_count += 1;
                // 継続用ユーザーメッセージをチャットに追加
                state.borrow_mut().chat.push(ChatMessage {
                    role: "user".into(),
                    content: LENGTH_CONTINUATION_PROMPT.into(),
                    thinking: None,
                    exclude_from_context: true,
                    id: None,
                    created_at: None,
                    transport: None,
                });
                // メッセージを再構築
                messages = state
                    .borrow()
                    .chat
                    .iter()
                    .filter(|message| {
                        !message.exclude_from_context
                            && !message.content.trim().is_empty()
                            && matches!(message.role.as_str(), "user" | "assistant")
                    })
                    .rev()
                    .take(30)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .map(|message| {
                        serde_json::json!({
                            "role": message.role,
                            "content": message.content,
                        })
                    })
                    .collect::<Vec<_>>();
                messages.push(serde_json::json!({
                    "role": "user",
                    "content": LENGTH_CONTINUATION_PROMPT,
                }));
                continue;
            }
            other => break other,
        }
    };

    generating(document, state, false)?;
    if let Err(error) = result {
        // 失敗前に表示済みのThinkingやツール結果も失わない。
        let _ = save_chat(state).await;
        return Err(error);
    }
    save_chat(state).await?;
    super::render::all(document, &state.borrow())?;
    sync_chat(&state.borrow());
    Ok(())
}

pub async fn summary(document: &Document, state: &Rc<RefCell<State>>) -> Result<(), JsValue> {
    let (text, project_id, episode_id, episode_title) = {
        let current = state.borrow();
        let project_id = current
            .current_project
            .as_ref()
            .map(|project| project.id.clone());
        let episode_id = current.current_episode_id.clone();
        let episode_title = episode_id.as_ref().and_then(|id| {
            current
                .episodes
                .iter()
                .find(|episode| &episode.id == id)
                .map(|episode| episode.title.clone())
        });
        (
            current.editor_text.clone(),
            project_id,
            episode_id,
            episode_title,
        )
    };
    if text.trim().is_empty() {
        return Err(JsValue::from_str("本文が空です。"));
    }
    let (Some(project_id), Some(episode_id)) = (project_id, episode_id) else {
        return Err(JsValue::from_str("エピソードを選択してください。"));
    };
    generating(document, state, true)?;
    let prompt = crate::windows::main_app::generation::old_prompts::summary_episode(
        &text,
        episode_title.as_deref(),
        Some(&episode_id),
    );
    let result = generate(
        state,
        "background",
        super::ai_actions::EDITORIAL_PARTNER_SYSTEM_PROMPT.into(),
        prompt,
    )
    .await;
    generating(document, state, false)?;
    let generated = result?;
    let (summary, one_liner) =
        crate::windows::main_app::generation::old_prompts::parse_summary_output(&generated.text);
    if summary.is_none() && one_liner.is_none() {
        return Err(JsValue::from_str(
            "要約応答を解析できませんでした。保存内容は変更していません。",
        ));
    }
    super::events::set_summary_parts(
        &mut state.borrow_mut(),
        &episode_id,
        summary.as_deref(),
        one_liner.as_deref(),
    );
    let value = state.borrow().summaries.clone();
    projects::write_document(&project_id, "summaries", &value).await?;
    super::render::all(document, &state.borrow())?;
    sync_summary(&state.borrow());
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
    sync_chat(&state.borrow());
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
    let result =
        ai::generate_with(role, system, prompt, provider.as_deref(), model.as_deref()).await?;
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
    save_chat(state).await?;
    super::render::all(document, &state.borrow())?;
    sync_chat(&state.borrow());
    Ok(())
}
pub(super) async fn save_chat(state: &Rc<RefCell<State>>) -> Result<(), JsValue> {
    let Some((project_id, chat)) = ({
        let current = state.borrow();
        current
            .current_project
            .as_ref()
            .map(|project| (project.id.clone(), current.chat.clone()))
    }) else {
        return Ok(());
    };
    let updated_at = js_sys::Date::new_0()
        .to_iso_string()
        .as_string()
        .unwrap_or_default();
    let value = super::chat_document_value(&chat, &updated_at);
    projects::write_document(&project_id, "chat", &value).await
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
    sync_chat(&state.borrow());
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
