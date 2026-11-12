use std::{cell::RefCell, rc::Rc};

use serde::Deserialize;
use serde_json::{json, Map, Value};
use wasm_bindgen::JsValue;
use web_sys::Document;

use super::{ChatMessage, ChatTransportMetadata, State};
use crate::{
    ai::capability,
    data::projects,
    runtime::{ai, invoke},
};

const MAX_TOOL_ROUNDS: usize = 16;

/// 重複するツール呼び出しを検出した場合に中断するためのしきい値
const MAX_DUPLICATE_CALLS: usize = 2;

mod common_sense;
mod craft;
mod genre;
mod project;
mod writing;

fn available_definitions(direct_creative_edit: bool, has_episode: bool) -> Vec<Value> {
    let mut definitions = definitions();
    if direct_creative_edit {
        // npm版 createAiTools({ directCreativeEdit: true }) と同様、
        // 通常の提案・多段執筆ツールを公開せず、hashline編集だけを許可する。
        definitions.retain(|definition| {
            !matches!(
                definition["name"].as_str(),
                Some("continuePassage" | "rewritePassage" | "lineEditPassage")
            )
        });
    }
    if !has_episode {
        // npm版はエピソードが開かれていない間は本文編集ツールを登録しない。
        definitions.retain(|definition| {
            !matches!(
                definition["name"].as_str(),
                Some("editEpisode" | "editEpisodeBatch")
            )
        });
    }
    definitions
}

pub async fn run(
    document: &Document,
    state: &Rc<RefCell<State>>,
    mut system: String,
    mut messages: Vec<Value>,
    direct_creative_edit: bool,
) -> Result<ai::GeneratedText, JsValue> {
    let cancellation_epoch = ai::cancellation_epoch();
    let definitions =
        available_definitions(direct_creative_edit, current_episode_id(state).is_some());
    let tool_names = definitions
        .iter()
        .filter_map(|d| d["name"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    let tool_name_refs = tool_names.iter().map(String::as_str).collect::<Vec<_>>();
    system.push_str("\n\nNOVEL CRAFT PRINCIPLES — apply these 10 core principles to all story consultation, editorial critique, and prose writing:\n");
    system.push_str(super::generation::craft::principles(Some("light")));
    if direct_creative_edit {
        let scaffold = {
            let current = state.borrow();
            super::generation::scaffold(&current.ai_settings).map(str::to_owned)
        };
        system.push_str("\n\n");
        system.push_str(super::generation::old_prompts::fiction_direction(
            scaffold.as_deref(),
        ));
    }
    system.push_str(&build_tool_guidance(&tool_name_refs, direct_creative_edit));
    let settings_context = {
        let current = state.borrow();
        super::prompt_context::build_settings_context(&current, &current.ai_settings)
    };
    if !settings_context.trim().is_empty() {
        system.push_str("\n\nSTORY REFERENCE DATA — established project canon (worldbuilding, characters, relationships, memos, craft notes, recent synopses):\n1. BEFORE writing fiction or answering any question about this project → look up every relevant character, location, term, relationship, and craft note in the reference block below.\n2. Treat recorded facts as binding canon unless the author's current request explicitly modifies them. Apply an authorized change only to the requested scope; preserve all other recorded facts (names, spellings, forms of address, speech style, relationships, world rules, and recorded craft rules).\n3. IF a fact is not recorded below → it is unknown. NEVER assert unrecorded backstory, relationships, or lore as established canon.\n4. Reference data informs YOU, not the viewpoint character: never leak facts into narration or dialogue that the viewpoint character or speaker has not yet learned.\n5. Derive each character's plausible knowledge, local familiarity, and vocabulary from their recorded social attributes (age, occupation, position, origin, duration of membership/stay).\n\n");
        system.push_str(&crate::ai::prompt_data::format_reference_data(
            "story_reference",
            &settings_context,
        ));
    }
    let (project_id, current_episode, provider, model) = {
        let current = state.borrow();
        (
            current
                .current_project
                .as_ref()
                .map(|project| project.id.clone()),
            current.current_episode_id.clone(),
            current.selected_provider.clone(),
            current.selected_model.clone(),
        )
    };
    let search_priority = state
        .borrow()
        .ai_settings
        .get("webSearchPriority")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let Some(project_id) = project_id else {
        let prompt = messages
            .iter()
            .filter_map(|message| message.get("content")?.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        let generated = ai::generate_with(
            "chat",
            system,
            prompt,
            provider.as_deref(),
            model.as_deref(),
        )
        .await?;
        state.borrow_mut().chat.push(ChatMessage {
            role: "assistant".into(),
            content: generated.text.clone(),
            thinking: None,
            exclude_from_context: false,
            id: None,
            created_at: None,
            transport: Some(chat_transport(
                &generated.provider,
                &generated.model,
                generated.finish_reason.as_deref(),
            )),
        });
        render_progress(document, state);
        return Ok(generated);
    };
    // 直前のラウンドで同じツール+同じ引数での呼び出しを検出し、ループ暴走を防ぐ
    let mut recent_calls: Vec<(String, String)> = Vec::new();
    // verifyToolCallNeed 後のリトライでツール呼び出しを強制するための tool_choice
    let mut forced_tool_choice: Option<String> = None;
    // ツール結果を受け取ったモデルが空応答を返した場合の最終回答リトライは1回だけ行う。
    let mut tool_result_continuations = 0usize;
    // ツール呼び出しなしで空応答になった場合も、プレースホルダ表示の前に
    // 1回だけ同じ会話で再試行する(reasoning モデルが思考だけで停止する事象への保険)。
    let mut empty_answer_retries = 0usize;
    for _ in 0..MAX_TOOL_ROUNDS {
        ai::ensure_not_cancelled(cancellation_epoch)?;
        let progress_index = {
            let mut current = state.borrow_mut();
            current.chat.push(ChatMessage {
                role: "assistant".into(),
                content: String::new(),
                thinking: None,
                exclude_from_context: false,
                id: None,
                created_at: None,
                transport: None,
            });
            current.chat.len() - 1
        };
        render_progress(document, state);
        {
            let current = state.borrow();
            super::sync_chat(&current);
        }
        let progress_document = document.clone();
        let progress_state = Rc::clone(state);
        let conversation_key = current_episode
            .as_deref()
            .map(|episode| format!("episode:{project_id}:{episode}"));
        let turn_result = ai::agent_turn_observed(
            "chat",
            system.clone(),
            messages.clone(),
            definitions.clone(),
            provider.as_deref(),
            model.as_deref(),
            search_priority.clone(),
            forced_tool_choice.clone(),
            conversation_key.as_deref(),
            move |update| {
                if let Some(message) = progress_state.borrow_mut().chat.get_mut(progress_index) {
                    match update {
                        ai::AgentStreamUpdate::TextDelta(delta) => message.content.push_str(&delta),
                        ai::AgentStreamUpdate::ReasoningDelta(delta) => message
                            .thinking
                            .get_or_insert_with(String::new)
                            .push_str(&delta),
                    }
                }
                render_progress(&progress_document, &progress_state);
            },
        )
        .await;
        ai::ensure_not_cancelled(cancellation_epoch)?;
        let turn = match turn_result {
            Ok(turn) => turn,
            Err(error) => {
                remove_empty_progress(state, progress_index);
                render_progress(document, state);
                return Err(error);
            }
        };
        if turn.tool_calls.is_empty() {
            let has_tool_result = messages
                .iter()
                .any(|message| message.get("role").and_then(Value::as_str) == Some("tool"));
            if turn.text.trim().is_empty() && has_tool_result && tool_result_continuations == 0 {
                tool_result_continuations += 1;
                if let Some(message) = state.borrow_mut().chat.get_mut(progress_index) {
                    message.content = "（ツール結果を確認し、最終回答を生成中…）".into();
                    message.transport = Some(chat_transport(
                        &turn.provider,
                        &turn.model,
                        turn.finish_reason.as_deref(),
                    ));
                }
                render_progress(document, state);
                // TS版 streamChatWithAutoContinuation の allowTools=false 相当。
                forced_tool_choice = Some("none".into());
                continue;
            }
            // ツール結果が無い場合の空応答も、同じ会話でもう1回だけ再試行する。
            if turn.text.trim().is_empty() && empty_answer_retries == 0 {
                empty_answer_retries += 1;
                if let Some(message) = state.borrow_mut().chat.get_mut(progress_index) {
                    message.content = "（応答の生成を再試行中…）".into();
                    message.transport = Some(chat_transport(
                        &turn.provider,
                        &turn.model,
                        turn.finish_reason.as_deref(),
                    ));
                }
                render_progress(document, state);
                continue;
            }
            if verify_tool_call_need(&messages, &turn.text, &tool_names).await {
                if let Some(message) = state.borrow_mut().chat.get_mut(progress_index) {
                    message.transport = Some(chat_transport(
                        &turn.provider,
                        &turn.model,
                        turn.finish_reason.as_deref(),
                    ));
                }
                let mut assistant_parts = Vec::new();
                if !turn.text.trim().is_empty() {
                    assistant_parts.push(json!({"type":"text","text":turn.text}));
                }
                append_native_tool_context(&mut assistant_parts, &turn);
                push_responses_assistant(
                    &mut messages,
                    json!(assistant_parts),
                    turn.responses_reasoning.as_ref(),
                    &turn.responses_tool_items,
                );
                messages.push(json!({"role":"user","content":"まだ必要なツールを呼び出していないようです。先にツールを呼び出してから、必要であれば説明を続けてください。"}));
                // TS resolveForcedToolChoice 相当: thinking モデルでは "auto"、それ以外は "required"
                forced_tool_choice = capability::resolve_forced_tool_choice(
                    &turn.provider,
                    &turn.model,
                    turn.thinking_enabled,
                );
                continue;
            }
            if turn.text.trim().is_empty() {
                // 診断ログ: 空応答の状況(終了理由・捕捉済み reasoning 量・
                // 履歴内のツール結果の有無と合計サイズ)を記録する。
                // - reasoningChars=0 は reasoning_content 捕捉漏れの手掛かり。
                // - toolResultChars が巨大(数万〜数十万字)なら、上限撤去後の
                //   ツール結果肥大による要求サイズ超過が原因と確定できる。
                let tool_result_chars: usize = messages
                    .iter()
                    .filter(|message| message.get("role").and_then(Value::as_str) == Some("tool"))
                    .map(|message| {
                        message
                            .get("content")
                            .map(|content| content.to_string().chars().count())
                            .unwrap_or(0)
                    })
                    .sum();
                web_sys::console::log_1(
                    &format!(
                        "[litra-tool] empty-final-turn finishReason={:?} reasoningChars={} toolResultInHistory={} toolResultChars={}",
                        turn.finish_reason,
                        turn.reasoning.chars().count(),
                        has_tool_result,
                        tool_result_chars,
                    )
                    .into(),
                );
            }
            if let Some(message) = state.borrow_mut().chat.get_mut(progress_index) {
                if message.content.trim().is_empty() {
                    message.content = if has_tool_result {
                        "（ツールの実行結果を受け取りましたが、応答の生成に失敗しました。もう一度送信してください。）"
                            .into()
                    } else {
                        "（応答がありませんでした）".into()
                    };
                }
                message.transport = Some(chat_transport(
                    &turn.provider,
                    &turn.model,
                    turn.finish_reason.as_deref(),
                ));
            }
            render_progress(document, state);
            return Ok(ai::GeneratedText {
                text: turn.text,
                provider: turn.provider,
                model: turn.model,
                finish_reason: turn.finish_reason,
            });
        }
        if let Some(message) = state.borrow_mut().chat.get_mut(progress_index) {
            message.transport = Some(chat_transport(
                &turn.provider,
                &turn.model,
                turn.finish_reason.as_deref(),
            ));
        }
        remove_empty_progress(state, progress_index);
        render_progress(document, state);
        // 重複ツール呼び出し検出
        for call in &turn.tool_calls {
            let input_str = serde_json::to_string(&call.input).unwrap_or_default();
            let signature = (call.name.clone(), input_str);
            let duplicate_count = recent_calls
                .iter()
                .filter(|s| s.0 == signature.0 && s.1 == signature.1)
                .count();
            if duplicate_count >= MAX_DUPLICATE_CALLS {
                state.borrow_mut().chat.push(ChatMessage {
                    role: "assistant".into(),
                    content: "（ツール実行後にモデルが停止しました。追加の指示を送ってください。）"
                        .into(),
                    thinking: None,
                    exclude_from_context: false,
                    id: None,
                    created_at: None,
                    transport: None,
                });
                render_progress(document, state);
                return Err(JsValue::from_str(&format!(
                    "AI tool loop aborted: tool '{}' called repeatedly with the same input (likely stuck)",
                    call.name
                )));
            }
            // Count calls in this batch too, before any side effects execute.
            recent_calls.push(signature);
        }
        if recent_calls.len() > 8 {
            let drop_count = recent_calls.len() - 8;
            recent_calls.drain(0..drop_count);
        }

        let mut assistant_parts = Vec::new();
        if !turn.text.trim().is_empty() {
            assistant_parts.push(json!({"type":"text","text":turn.text}));
        }
        append_native_tool_context(&mut assistant_parts, &turn);
        for call in &turn.tool_calls {
            assistant_parts.push(json!({
                "type":"tool-call",
                "toolCallId":call.id,
                "toolName":call.name,
                "input":call.input,
            }));
        }
        push_responses_assistant(
            &mut messages,
            json!(assistant_parts),
            turn.responses_reasoning.as_ref(),
            &turn.responses_tool_items,
        );
        let mut results = Vec::new();
        for call in turn.tool_calls {
            ai::ensure_not_cancelled(cancellation_epoch)?;
            web_sys::console::log_1(
                &format!(
                    "[litra-tool] start callId={} name={} provider={} model={}",
                    call.id, call.name, turn.provider, turn.model
                )
                .into(),
            );
            upsert_tool_card(
                state,
                &call.id,
                &call.name,
                "実行中",
                Some(&call.input),
                None,
                &turn.provider,
                &turn.model,
            );
            render_progress(document, state);
            let mut report_tool_progress = |stage: &str| {
                web_sys::console::log_1(
                    &format!(
                        "[litra-tool] progress callId={} name={} stage={stage}",
                        call.id, call.name
                    )
                    .into(),
                );
                let status = format!("実行中（{stage}）");
                upsert_tool_card(
                    state,
                    &call.id,
                    &call.name,
                    &status,
                    Some(&call.input),
                    None,
                    &turn.provider,
                    &turn.model,
                );
                render_progress(document, state);
            };
            // A model can return an unadvertised name or malformed arguments even
            // when the provider accepts our schema. Enforce the local catalog.
            let execution = match crate::ai::tool_validation::validate_call(
                &definitions,
                &call.name,
                &call.input,
            ) {
                Ok(()) => {
                    execute(
                        state,
                        &project_id,
                        current_episode.as_deref(),
                        &call.name,
                        call.input.clone(),
                        &mut report_tool_progress,
                    )
                    .await
                }
                Err(error) => Ok(json!({"error": error})),
            };
            ai::ensure_not_cancelled(cancellation_epoch)?;
            let (status, output) = match execution {
                Ok(output) if output.get("error").is_none() => {
                    web_sys::console::log_1(
                        &format!(
                            "[litra-tool] finish callId={} name={} status=success",
                            call.id, call.name
                        )
                        .into(),
                    );
                    ("成功", output)
                }
                Ok(output) => {
                    let message = output
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("ツールがエラー結果を返しました。");
                    web_sys::console::error_1(
                        &format!(
                            "[litra-tool] finish callId={} name={} status=error message={message}",
                            call.id, call.name
                        )
                        .into(),
                    );
                    ("失敗", output)
                }
                Err(error) => {
                    web_sys::console::error_1(
                        &format!(
                            "[litra-tool] finish callId={} name={} status=error message={}",
                            call.id,
                            call.name,
                            js_error(&error)
                        )
                        .into(),
                    );
                    ("失敗", json!({"error":js_error(&error)}))
                }
            };
            upsert_tool_card(
                state,
                &call.id,
                &call.name,
                status,
                Some(&call.input),
                Some(&output),
                &turn.provider,
                &turn.model,
            );
            render_progress(document, state);
            results.push(json!({
                "type":"tool-result",
                "toolCallId":call.id,
                "toolName":call.name,
                "output":{"type":"json","value":output},
            }));
        }
        messages.push(json!({"role":"tool","content":results}));
        // 強制tool_choiceは「ツールが必要」と判定した1回の再試行だけに適用する。
        forced_tool_choice = None;
    }
    // ツールループが最大ラウンド数に達した場合のフォールバックメッセージ
    state.borrow_mut().chat.push(ChatMessage {
        role: "assistant".into(),
        content: "（ツール実行後にモデルが停止しました。追加の指示を送ってください。）".into(),
        thinking: None,
        exclude_from_context: false,
        id: None,
        created_at: None,
        transport: None,
    });
    render_progress(document, state);
    Err(JsValue::from_str(
        "AI tool loop exceeded the maximum number of rounds",
    ))
}

fn current_episode_id(state: &Rc<RefCell<State>>) -> Option<String> {
    state.borrow().current_episode_id.clone()
}

fn push_responses_assistant(
    messages: &mut Vec<Value>,
    content: Value,
    reasoning_item: Option<&Value>,
    responses_tool_items: &[Value],
) {
    let mut message = json!({"role":"assistant","content":content});
    let mut response_items = Vec::new();
    if let Some(item) = reasoning_item {
        response_items.push(item.clone());
    }
    response_items.extend(responses_tool_items.iter().cloned());
    if !response_items.is_empty() {
        message["responsesItems"] = Value::Array(response_items);
    }
    messages.push(message);
}

fn append_native_tool_context(parts: &mut Vec<Value>, turn: &ai::AgentTurn) {
    if !turn.reasoning.trim().is_empty() {
        parts.push(json!({
            "type": "reasoning",
            "text": turn.reasoning,
        }));
    }
    for block in &turn.anthropic_thinking {
        parts.push(json!({
            "type": "anthropic-thinking-block",
            "block": block,
        }));
    }
    for block in &turn.anthropic_tool_context {
        parts.push(json!({
            "type": "anthropic-server-block",
            "block": block,
        }));
    }
    for part in &turn.google_tool_context {
        parts.push(json!({
            "type": "google-server-part",
            "part": part,
        }));
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolCallNeed {
    needs_tools: bool,
}

async fn verify_tool_call_need(messages: &[Value], response: &str, tool_names: &[String]) -> bool {
    let user_request = messages
        .iter()
        .rev()
        .find(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let prompt =
        super::generation::old_prompts::tool_call_need(user_request, Some(response), tool_names);
    crate::ai::structured_output::generate_structured_object::<ToolCallNeed>(
        "judgment",
        Some("You audit assistant responses. Decide one thing: did the request require an actual tool call that the assistant failed to perform? Return ONLY a JSON object. IF uncertain → set needsTools=false."),
        &prompt,
        json!({"type":"object","properties":{"needsTools":{"type":"boolean"},"missingTools":{"type":"array","items":{"type":"string"}},"reason":{"type":"string"}},"required":["needsTools","reason"],"additionalProperties":false}),
        None, None,
    ).await.map(|value| value.needs_tools).unwrap_or(false)
}

fn render_progress(document: &Document, state: &Rc<RefCell<State>>) {
    super::render::schedule_chat(document, state);
}

fn remove_empty_progress(state: &Rc<RefCell<State>>, index: usize) {
    let mut current = state.borrow_mut();
    if current.chat.get(index).is_some_and(|message| {
        message.content.trim().is_empty()
            && message
                .thinking
                .as_deref()
                .unwrap_or_default()
                .trim()
                .is_empty()
    }) {
        current.chat.remove(index);
    }
}

fn chat_transport(
    provider: &str,
    model: &str,
    finish_reason: Option<&str>,
) -> ChatTransportMetadata {
    ChatTransportMetadata {
        provider: Some(provider.into()),
        model: Some(model.into()),
        base_url: None,
        protocol: None,
        response_id: None,
        response_model_id: None,
        finish_reason: finish_reason.map(|s| s.into()),
        max_tokens: None,
        max_context_tokens: None,
        created_at: Some(now()),
        kind: Some("chat".into()),
    }
}

pub fn make_transport(
    provider: &str,
    model: &str,
    finish_reason: Option<&str>,
    kind: &str,
) -> ChatTransportMetadata {
    ChatTransportMetadata {
        provider: Some(provider.into()),
        model: Some(model.into()),
        base_url: None,
        protocol: None,
        response_id: None,
        response_model_id: None,
        finish_reason: finish_reason.map(|s| s.into()),
        max_tokens: None,
        max_context_tokens: None,
        created_at: Some(now()),
        kind: Some(kind.into()),
    }
}

fn upsert_tool_card(
    state: &Rc<RefCell<State>>,
    call_id: &str,
    name: &str,
    status: &str,
    input: Option<&Value>,
    output: Option<&Value>,
    provider: &str,
    model: &str,
) {
    let content = format_tool_card(call_id, name, status, input, output);
    let mut current = state.borrow_mut();
    if let Some(message) = current
        .chat
        .iter_mut()
        .find(|message| message.id.as_deref() == Some(call_id))
    {
        message.content = content;
        return;
    }
    current.chat.push(ChatMessage {
        role: "assistant".into(),
        content,
        thinking: None,
        exclude_from_context: true,
        id: Some(call_id.into()),
        created_at: Some(now()),
        transport: Some(chat_transport(provider, model, None)),
    });
}

fn format_tool_card(
    call_id: &str,
    name: &str,
    status: &str,
    input: Option<&Value>,
    output: Option<&Value>,
) -> String {
    let chips = {
        let mut chips = Vec::new();
        if let Some(input) = input {
            chips.extend(summarize_tool_input(name, input));
        }
        if let Some(output) = output {
            chips.extend(summarize_tool_output(name, output));
        }
        chips
    };
    let input_display = input
        .map(|value| display_json(value, 6_000))
        .unwrap_or_else(|| "（モデルがツール引数を生成中です）".into());
    let result = output
        .map(|value| display_json(value, 12_000))
        .unwrap_or_else(|| "（実行中）".into());
    let chips_line = if chips.is_empty() {
        String::new()
    } else {
        format!("\nチップ: {}", chips.join("|"))
    };
    format!(
        "【ツール{status}: {name}】\n状態: {status}\nID: {call_id}{chips_line}\n入力: {input_display}\n結果:\n{result}"
    )
}

/// TS版 `summarizeToolInput` の移植 — ツール名と入力から要約チップを生成する。
fn summarize_tool_input(name: &str, input: &Value) -> Vec<String> {
    let Some(obj) = input.as_object() else {
        return vec![];
    };
    match name {
        "editEpisode" => {
            // hashline パッチの `input` からセクション数と操作行数を要約する。
            let input = obj.get("input").and_then(Value::as_str).unwrap_or("");
            let sections = input
                .lines()
                .filter(|l| {
                    let t = l.trim_start();
                    t.starts_with('[') && t.contains('#') && t.trim_end().ends_with(']')
                })
                .count();
            let ops = input
                .lines()
                .filter(|l| {
                    let t = l.trim_start();
                    t.starts_with("SWAP") || t.starts_with("DEL") || t.starts_with("INS")
                })
                .count();
            let mut chips = Vec::new();
            if sections > 0 {
                chips.push(format!("{sections}セクション"));
            }
            if ops > 0 {
                chips.push(format!("{ops}操作"));
            }
            chips
        }
        "editEpisodeBatch" => obj
            .get("edits")
            .and_then(Value::as_array)
            .map(|edits| vec![format!("{}範囲", edits.len())])
            .unwrap_or_default(),
        "searchEpisodes" | "findEpisodeLines" => {
            let query = obj.get("query").and_then(Value::as_str).unwrap_or("");
            if query.is_empty() {
                vec![]
            } else {
                vec![format!("検索: {query}")]
            }
        }
        "updateCharacter" => {
            let id = obj
                .get("characterId")
                .and_then(Value::as_str)
                .unwrap_or("?");
            let fields = obj
                .get("updates")
                .and_then(Value::as_object)
                .map(|o| o.keys().cloned().collect::<Vec<_>>().join(", "))
                .unwrap_or_else(|| "未指定".into());
            vec![format!("ID: {id}"), format!("項目: {fields}")]
        }
        "updateWorldEntry" => {
            let id = obj.get("entryId").and_then(Value::as_str).unwrap_or("?");
            let fields = obj
                .get("updates")
                .and_then(Value::as_object)
                .map(|o| o.keys().cloned().collect::<Vec<_>>().join(", "))
                .unwrap_or_else(|| "未指定".into());
            vec![format!("ID: {id}"), format!("項目: {fields}")]
        }
        "createCharacter" => {
            let mut chips = Vec::new();
            if let Some(name) = obj.get("name").and_then(Value::as_str) {
                chips.push(format!("名前: {name}"));
            }
            chips
        }
        "createWorldEntry" => {
            let mut chips = Vec::new();
            if let Some(name) = obj.get("name").and_then(Value::as_str) {
                chips.push(format!("名前: {name}"));
            }
            if let Some(cat) = obj.get("category").and_then(Value::as_str) {
                chips.push(format!("カテゴリ: {cat}"));
            }
            chips
        }
        "retrieveEpisode" => {
            let id = obj.get("episodeId").and_then(Value::as_str).unwrap_or("?");
            vec![format!("episodeId: {id}")]
        }
        "saveEpisodeSummary" | "saveEpisodeOneLiner" | "saveEpisodeSummaryAndOneLiner" => {
            let id = obj.get("episodeId").and_then(Value::as_str).unwrap_or("?");
            vec![format!("episodeId: {id}")]
        }
        "webSearch" => {
            let query = obj.get("query").and_then(Value::as_str).unwrap_or("");
            if query.is_empty() {
                vec![]
            } else {
                vec![format!("検索: {query}")]
            }
        }
        "webFetch" => {
            let url = obj.get("url").and_then(Value::as_str).unwrap_or("");
            if url.is_empty() {
                vec![]
            } else {
                vec![format!("URL: {url}")]
            }
        }
        _ => {
            // Default: show first key name
            obj.keys()
                .next()
                .map(|k| vec![k.clone()])
                .unwrap_or_default()
        }
    }
}

/// TS版 `summarizeToolOutput` の移植 — ツール出力から要約チップを生成する。
fn summarize_tool_output(name: &str, output: &Value) -> Vec<String> {
    let Some(obj) = output.as_object() else {
        return vec![];
    };
    let mut chips = Vec::new();
    if let Some(success) = obj.get("success").and_then(Value::as_bool) {
        chips.push(if success {
            "成功".into()
        } else {
            "失敗".into()
        });
    }
    if let Some(msg) = obj.get("message").and_then(Value::as_str) {
        if !msg.is_empty() {
            chips.push(msg.into());
        }
    }
    if let Some(n) = obj.get("appliedEdits").and_then(Value::as_i64) {
        chips.push(format!("適用 {n}件"));
    }
    if let Some(range) = obj.get("editedLineRange").and_then(Value::as_object) {
        let start = range
            .get("startLine")
            .and_then(Value::as_i64)
            .map(|v| v.to_string())
            .unwrap_or_else(|| "?".into());
        let end = range
            .get("endLine")
            .and_then(Value::as_i64)
            .map(|v| v.to_string())
            .unwrap_or_else(|| "?".into());
        chips.push(format!("{start}-{end}行"));
    }
    if let Some(n) = obj.get("replacementLineCount").and_then(Value::as_i64) {
        chips.push(format!("置換後 {n}行"));
    }
    if let Some(matches) = obj.get("matches").and_then(Value::as_array) {
        chips.push(format!("一致 {}件", matches.len()));
    }
    if let Some(n) = obj.get("totalLines").and_then(Value::as_i64) {
        chips.push(format!("全 {n}行"));
    }
    if let Some(updated) = obj.get("searchIndexUpdated").and_then(Value::as_bool) {
        chips.push(if updated {
            "索引更新済み".into()
        } else {
            "索引未更新".into()
        });
    }
    if let Some(n) = obj.get("indexedDocuments").and_then(Value::as_i64) {
        chips.push(format!("索引 {n}件"));
    }
    if name == "listCharacters" || name == "listWorldEntries" {
        let key = if name == "listCharacters" {
            "characters"
        } else {
            "entries"
        };
        if let Some(list) = obj.get(key).and_then(Value::as_array) {
            chips.push(format!("{}件", list.len()));
        }
    }
    chips
}

fn display_json(value: &Value, limit: usize) -> String {
    let text = serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string());
    if text.chars().count() <= limit {
        return text;
    }
    let mut truncated = text.chars().take(limit).collect::<String>();
    truncated.push_str("\n…（省略）");
    truncated
}

fn now() -> String {
    js_sys::Date::new_0()
        .to_iso_string()
        .as_string()
        .unwrap_or_default()
}

fn edit_line_range_summary(item: &Value) -> Value {
    json!({
        "startLine": item.get("startLine").cloned().unwrap_or(Value::Null),
        "endLine": item.get("endLine").cloned().unwrap_or(Value::Null),
        "replacementLineCount": item.get("replacementLineCount").cloned().unwrap_or(Value::Null),
    })
}

/// ツール入力の episodeId を解決する。空または未指定なら現在のエピソードにフォールバック。
fn resolve_episode_id(
    input: &serde_json::Map<String, Value>,
    current_episode: Option<&str>,
) -> Result<String, JsValue> {
    if let Some(id) = input.get("episodeId").and_then(Value::as_str) {
        if !id.is_empty() {
            return Ok(id.to_string());
        }
    }
    current_episode
        .map(String::from)
        .ok_or_else(|| JsValue::from_str("episodeId is required (no current episode)"))
}

async fn execute(
    state: &Rc<RefCell<State>>,
    project_id: &str,
    current_episode: Option<&str>,
    name: &str,
    input: Value,
    on_progress: &mut dyn FnMut(&str),
) -> Result<Value, JsValue> {
    if writing::handles(name) {
        return writing::execute(state, project_id, current_episode, name, input, on_progress)
            .await;
    }
    if genre::handles(name) {
        return genre::execute(name, input).await;
    }
    if project::handles(name) {
        return project::execute(state, project_id, current_episode, name, input).await;
    }
    if craft::handles(name) {
        return craft::execute(state, project_id, current_episode, name, input, on_progress).await;
    }
    if common_sense::handles(name) {
        return common_sense::execute(state, project_id, current_episode, name, input, on_progress)
            .await;
    }
    let mut input = input.as_object().cloned().unwrap_or_default();
    let value: Value = match name {
        "listEpisodes" => {
            invoke::invoke(
                "list_episodes_with_summaries",
                &json!({"projectId":project_id}),
            )
            .await?
        }
        "rebuildSearchIndex" => {
            invoke::invoke("rebuild_search_index", &json!({"projectId":project_id})).await?
        }
        "webSearch" => invoke::invoke("web_search", &json!({"req":input.clone()})).await?,
        "webFetch" => invoke::invoke("web_fetch", &json!({"req":input.clone()})).await?,
        "saveEpisodeSummaryAndOneLiner" => {
            let episode_id = input.get("episodeId").cloned().unwrap_or(Value::Null);
            let content = input.get("content").cloned().unwrap_or(Value::Null);
            let one_liner = input.get("oneLiner").cloned().unwrap_or(Value::Null);
            invoke::invoke::<_, ()>(
                "save_episode_summary_and_one_liner",
                &json!({"req":{"projectId":project_id,"episodeId":episode_id,"content":content,"oneLiner":one_liner}}),
            )
            .await?;
            let search_index_updated = invoke::invoke::<_, Value>(
                "rebuild_search_index",
                &json!({"projectId":project_id}),
            )
            .await
            .is_ok();
            json!({
                "success": true,
                "message": "要約と一行要約を保存しました。",
                "searchIndexUpdated": search_index_updated,
            })
        }
        "getEpisodeLines" => {
            let episode_id = resolve_episode_id(&input, current_episode)?;
            let start = input
                .get("startLine")
                .and_then(Value::as_u64)
                .map(|v| v as u32);
            let end = input
                .get("endLine")
                .and_then(Value::as_u64)
                .map(|v| v as u32);
            let episodes = state.borrow().episodes.clone();
            super::hashline_tools::ground_episode_lines(
                project_id,
                &episode_id,
                &episodes,
                start,
                end,
            )
            .await?
        }
        "findEpisodeLines" => {
            let episode_id = resolve_episode_id(&input, current_episode)?;
            let query = input
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let context = input
                .get("contextLines")
                .and_then(Value::as_u64)
                .map(|v| v as u32);
            let max = input
                .get("maxMatches")
                .and_then(Value::as_u64)
                .map(|v| v as usize);
            let case_sensitive = input.get("caseSensitive").and_then(Value::as_bool);
            let episodes = state.borrow().episodes.clone();
            super::hashline_tools::ground_find_episode_lines(
                project_id,
                &episode_id,
                &episodes,
                &query,
                context,
                max,
                case_sensitive,
            )
            .await?
        }
        "editEpisode" => {
            let patch_input = input
                .get("input")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    JsValue::from_str("editEpisode requires 'input' (the hashline patch text)")
                })?
                .to_string();
            let reason = input
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let episodes = state.borrow().episodes.clone();
            let result = super::hashline_tools::apply_hashline_edit(
                project_id,
                &episodes,
                &patch_input,
                &reason,
            )
            .await?;
            // 現在のエピソードが編集されていればエディタ本文を再読み込み
            let edited_id = result
                .get("episodeId")
                .and_then(Value::as_str)
                .map(String::from);
            if let Some(edited_id) = edited_id {
                if Some(edited_id.as_str()) == current_episode {
                    if let Some(file_name) = episodes
                        .iter()
                        .find(|ep| ep.id == edited_id)
                        .map(|ep| ep.file_name.clone())
                    {
                        if let Ok(text) = projects::read_episode(project_id, &file_name).await {
                            state.borrow_mut().editor_text = text;
                        }
                    }
                }
            }
            let _: Value = invoke::invoke("rebuild_search_index", &json!({"projectId":project_id}))
                .await
                .unwrap_or(Value::Null);
            result
        }
        "editEpisodeBatch" => {
            let episode_id = resolve_episode_id(&input, current_episode)?;
            let edits = input
                .get("edits")
                .and_then(Value::as_array)
                .filter(|edits| !edits.is_empty())
                .ok_or_else(|| {
                    JsValue::from_str("editEpisodeBatch requires a non-empty 'edits' array")
                })?
                .clone();
            let result: Value = invoke::invoke(
                "edit_episode_text_batch",
                &json!({
                    "req": {
                        "projectId": project_id,
                        "episodeId": episode_id,
                        "edits": edits,
                    }
                }),
            )
            .await?;
            let success = result
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if success {
                if let Some(new_text) = result.get("newText").and_then(Value::as_str) {
                    if current_episode == Some(episode_id.as_str()) {
                        state.borrow_mut().editor_text = new_text.to_owned();
                    }
                }
            }
            let search_index_updated = if success {
                invoke::invoke::<_, Value>("rebuild_search_index", &json!({"projectId":project_id}))
                    .await
                    .is_ok()
            } else {
                false
            };
            let edit_results = result
                .get("editResults")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let edited_line_ranges = edit_results
                .iter()
                .filter(|item| item.get("success").and_then(Value::as_bool) == Some(true))
                .map(edit_line_range_summary)
                .collect::<Vec<_>>();
            let failed_line_ranges = edit_results
                .iter()
                .filter(|item| item.get("success").and_then(Value::as_bool) != Some(true))
                .map(|item| {
                    let mut range = edit_line_range_summary(item);
                    if let Some(object) = range.as_object_mut() {
                        if let Some(message) = item.get("message") {
                            object.insert("message".into(), message.clone());
                        }
                    }
                    range
                })
                .collect::<Vec<_>>();
            let message = result
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("一括編集の結果を取得できませんでした。");
            let mut output = result.as_object().cloned().unwrap_or_default();
            output.insert(
                "editedLineRanges".into(),
                Value::Array(edited_line_ranges.clone()),
            );
            output.insert("failedLineRanges".into(), Value::Array(failed_line_ranges));
            output.insert(
                "editSummary".into(),
                Value::String(if success {
                    format!("{}件の編集を一括適用しました。", edited_line_ranges.len())
                } else {
                    message.to_owned()
                }),
            );
            output.insert(
                "searchIndexUpdated".into(),
                Value::Bool(search_index_updated),
            );
            Value::Object(output)
        }
        command => {
            if command == "retrieveEpisode" {
                // npm版の公開契約は `type`。バックエンドの永続化契約へ変換してから渡す。
                if let Some(content_type) = input.remove("type") {
                    input.insert("contentType".into(), content_type);
                }
            }
            input.insert("projectId".into(), Value::String(project_id.into()));
            let command = match command {
                "retrieveEpisode" => "retrieve_episode_content",
                "searchEpisodes" => "search_episodes",
                "getEditLog" => "get_edit_log",
                "saveEpisodeSummary" => "save_episode_summary",
                "saveEpisodeOneLiner" => "save_episode_one_liner",
                _ => return Ok(json!({"error":format!("Unknown tool: {name}")})),
            };
            invoke::invoke(command, &json!({"req":input})).await?
        }
    };
    if matches!(
        name,
        "saveEpisodeSummary" | "saveEpisodeOneLiner" | "saveEpisodeSummaryAndOneLiner"
    ) {
        let summaries = projects::read_document(project_id, "summaries")
            .await?
            .unwrap_or_else(|| json!({"summaries":{}}));
        state.borrow_mut().summaries = summaries;
    }
    if name == "saveEpisodeSummary" {
        return Ok(json!({"success":true,"message":"要約を保存しました。"}));
    }
    if name == "saveEpisodeOneLiner" {
        return Ok(json!({"success":true,"message":"一行要約を保存しました。"}));
    }
    Ok(value)
}

fn definitions() -> Vec<Value> {
    let mut definitions = vec![
        tool(
            "listEpisodes",
            "Lists episodes with IDs, order, titles and one-line summaries.",
            object([]),
        ),
        tool(
            "retrieveEpisode",
            "Retrieves an episode summary or full manuscript text.",
            object_with_required(
                [("episodeId", string()), ("type", enum_string(&["summary", "fullText"]))],
                &["episodeId", "type"],
            ),
        ),
        tool(
            "searchEpisodes",
            "Searches project episodes and summaries.",
            object_with_required([("query", string()), ("limit", integer())], &["query"]),
        ),
        tool(
            "rebuildSearchIndex",
            "Rebuilds the project search index when results are stale.",
            object([]),
        ),
        tool(
            "getEpisodeLines",
            "Reads episode text as hashline-numbered lines: a `[episodeId#TAG]` header plus `LINE:TEXT` rows. Copy the header (including #TAG) and line numbers verbatim to anchor an editEpisode.",
            object_with_required(
                [
                    ("episodeId", string()),
                    ("startLine", integer()),
                    ("endLine", integer()),
                ],
                &["episodeId"],
            ),
        ),
        tool(
            "findEpisodeLines",
            "Searches an episode and returns matching lines with context as hashline-numbered output (`[episodeId#TAG]` header + `LINE:TEXT` rows).",
            object_with_required(
                [
                    ("episodeId", string()),
                    ("query", string()),
                    ("contextLines", integer()),
                    ("maxMatches", integer()),
                    ("caseSensitive", boolean()),
                ],
                &["episodeId", "query"],
            ),
        ),
        tool(
            "editEpisode",
            "Edits an episode with a hashline patch. `input` is the full patch: one or more `[episodeId#TAG]` sections (TAG from your latest getEpisodeLines/findEpisodeLines) followed by line ops — `SWAP N.=M:` replace lines, `DEL N.=M` delete, `INS.PRE N:`/`INS.POST N:`/`INS.HEAD:`/`INS.TAIL:` insert, each body row a `+TEXT` literal. Read lines first; the #TAG certifies the snapshot.",
            object([
                ("input", string()),
                ("reason", string()),
            ]),
        ),
        tool(
            "editEpisodeBatch",
            "同じ編集前本文に対する複数の非連続範囲を一括置換します。1-based行番号、expectedText、replacementText、reasonを各範囲に指定し、範囲は重複させません。複数箇所を編集する場合に使います。",
            batch_edit_schema(),
        ),
        tool(
            "getEditLog",
            "Reads recent manuscript edit history and reasons.",
            object_with_required([("episodeId", string()), ("limit", integer())], &[]),
        ),
        tool(
            "saveEpisodeSummary",
            "Saves a detailed episode summary.",
            object([("episodeId", string()), ("content", string())]),
        ),
        tool(
            "saveEpisodeOneLiner",
            "Saves a 30-80 Japanese character one-line episode summary.",
            object([("episodeId", string()), ("oneLiner", string())]),
        ),
        tool(
            "saveEpisodeSummaryAndOneLiner",
            "Saves the detailed and one-line episode summaries together.",
            object([
                ("episodeId", string()),
                ("content", string()),
                ("oneLiner", string()),
            ]),
        ),
        tool(
            "webSearch",
            "Fallback Exa web search for current factual information when the provider's native search is unavailable.",
            object_with_required(
                [
                    ("query", string()),
                    ("numResults", integer()),
                    ("livecrawl", enum_string(&["fallback", "preferred"])),
                    ("type", enum_string(&["auto", "fast", "deep"])),
                    ("contextMaxCharacters", integer()),
                ],
                &["query"],
            ),
        ),
        tool(
            "webFetch",
            "Fetches readable content from a URL.",
            object_with_required(
                [
                    ("url", string()),
                    ("format", enum_string(&["text", "markdown", "html"])),
                    ("timeout", integer()),
                ],
                &["url"],
            ),
        ),
    ];
    definitions.extend(project::definitions());
    definitions.extend(genre::definitions());
    definitions.extend(writing::definitions());
    definitions.extend(craft::definitions());
    definitions.extend(common_sense::definitions());
    definitions
}

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({"name":name,"description":description,"inputSchema":input_schema})
}
fn object<const N: usize>(properties: [(&str, Value); N]) -> Value {
    let required = properties.iter().map(|(key, _)| *key).collect::<Vec<_>>();
    object_with_required(properties, &required)
}
fn object_with_required<const N: usize>(
    properties: [(&str, Value); N],
    required: &[&str],
) -> Value {
    let properties = properties
        .into_iter()
        .map(|(key, value)| (key.into(), value))
        .collect::<Map<String, Value>>();
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}
fn batch_edit_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "episodeId": {"type": "string"},
            "edits": {
                "type": "array",
                "minItems": 1,
                "maxItems": 50,
                "items": {
                    "type": "object",
                    "properties": {
                        "startLine": {"type": "integer", "minimum": 1},
                        "endLine": {"type": "integer", "minimum": 1},
                        "expectedText": {"type": "string"},
                        "replacementText": {"type": "string"},
                        "reason": {"type": "string"}
                    },
                    "required": ["startLine", "endLine", "expectedText", "replacementText", "reason"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["edits"],
        "additionalProperties": false
    })
}
fn string() -> Value {
    json!({"type":"string"})
}
fn integer() -> Value {
    json!({"type":"integer"})
}
fn boolean() -> Value {
    json!({"type":"boolean"})
}
fn enum_string(values: &[&str]) -> Value {
    json!({"type":"string","enum":values})
}
fn js_error(error: &JsValue) -> String {
    error.as_string().unwrap_or_else(|| format!("{error:?}"))
}

// ============================================================
//  ツールガイダンス — TS版 buildToolGuidancePrompt の移植
// ============================================================

/// 利用可能なツールに応じて動的にツールガイダンスを生成する。
/// TS版 `buildToolGuidancePrompt` の完全移植。
fn build_tool_guidance(tool_names: &[&str], direct_creative_edit: bool) -> String {
    use std::collections::BTreeSet;
    let available: BTreeSet<&str> = tool_names.iter().copied().collect();
    let mut s = String::from(BASE_TOOL_GUIDANCE);

    // EPISODE TEXT EDITING
    let has_episode_tools = available.contains("findEpisodeLines")
        || available.contains("getEpisodeLines")
        || available.contains("editEpisode")
        || available.contains("editEpisodeBatch");
    if has_episode_tools {
        s.push_str(r#"

EPISODE TEXT EDITING (hashline) — follow in this exact order:
1. WHEN THE USER ASKS TO WRITE OR APPLY FICTION: 「〜を書いて」「本文に追加して」「小説の続きを書いて」「物語を作って」「以下の内容を反映して」など、本文の執筆・追記・反映・修正を明示的に依頼された場合 → チャット上の相談や下書き提示だけで終わらせず、必ず適切な執筆/編集ツールを呼び出して実行すること。
2. GROUND FIRST: Before any edit, ALWAYS read the target lines with `getEpisodeLines` (line range) or `findEpisodeLines` (keyword search). They return a `[episodeId#TAG]` header plus 1-based `LINE:TEXT` rows. NEVER guess line numbers or line contents from memory.
3. APPLY HASHLINE PATCH (`editEpisode`): pass `input` containing one or more sections. Each section begins with the exact `[episodeId#TAG]` header returned by the latest read (copy verbatim, including `#TAG`), followed by line operations:
   - `SWAP N.=M:` replace original lines N..M (inclusive) with the `+TEXT` body rows below.
   - `DEL N.=M` delete original lines N..M (no body rows).
   - `INS.PRE N:` / `INS.POST N:` insert `+TEXT` body rows immediately before / after line N.
   - `INS.HEAD:` / `INS.TAIL:` insert `+TEXT` body rows at the start / end of the episode.
   - Every body row MUST start with `+` (`+TEXT` for text; a bare `+` for an empty line; `+- item` for a Markdown bullet). NEVER include `-old` lines or unprefixed context lines.
   - Single-line shorthand: `SWAP N.=N:` or `DEL N`.
4. IMMUTABLE LINE NUMBERS PER CALL: all line numbers in one `editEpisode` call refer to the snapshot identified by `#TAG` and do not shift across hunks in the same call. Touch only lines you have actually read.
5. KEEP RANGES TIGHT: target ONLY the lines that actually change. Never widen `SWAP` across unchanged surrounding lines; use `INS.*` for pure insertions.
6. RE-GROUND AFTER EVERY EDIT: each successful `editEpisode` mints a new `#TAG` and renumbers lines. Use the updated `numberedText` from the tool response (or call `getEpisodeLines` again) before any subsequent edit. On a stale-tag error, STOP and re-read the range before retrying.
7. ATOMIC MULTI-HUNK EDITS: combine related changes into multiple hunks (or sections) inside a SINGLE `editEpisode` call so they apply atomically.
8. BATCH EXACT-RANGE EDITS (`editEpisodeBatch`): when applying multiple non-contiguous 1-based line replacements from the same pre-edit snapshot with exact `expectedText`, `replacementText`, and Japanese `reason`, call `editEpisodeBatch` once rather than chaining separate calls.
9. LANGUAGE & CONFIRMATION: manuscript body text MUST be Japanese unless the user explicitly requested another language. Execute clearly requested edits immediately without asking for confirmation first; ask only when the target scope or canon impact is genuinely ambiguous.
10. AUDITABLE `reason`: every edit requires a concrete Japanese `reason` stating the specific flaw fixed or narrative goal achieved (never vague filler like 「より自然にするため」). This reason is recorded permanently in the project edit log for future sessions and consistency checks.
11. CONCISE COMPLETION REPORT: after a successful edit, report the changed line ranges and summary once in Japanese. Do not reprint the raw patch unless requested.
"#);
    }

    // NEW FICTION GENERATION (continuePassage)
    if available.contains("continuePassage") {
        s.push_str(r#"

NEW FICTION GENERATION (`continuePassage`):
- IF the user asks to write a new continuation, scene, passage, or dialogue sequence for the manuscript → you MUST call `continuePassage`. Do NOT draft the prose directly in chat and do NOT bypass `continuePassage` by writing fresh story prose straight into `editEpisode`.
- Pass the complete author directive in `instruction` (desired events, emotional direction, pacing, length, viewpoint constraints, and anything to include or avoid).
- `continuePassage` runs the dedicated writing pipeline (continuity cards, planning, multi-candidate selection, judgment review, and quality/common-sense checks) and stores the result in the proposal cache without modifying the episode file by itself.
- IF the user explicitly asked to write/append the continuation into the manuscript right now → immediately call `applyPassageProposal` with the returned `proposalId`. Never copy `generatedText` into `editEpisode`.
- IF `continuePassage` fails → report the error honestly in Japanese; never silently substitute chat-model prose.
"#);
    }

    // DIRECT CREATIVE EDITING MODE
    if direct_creative_edit && available.contains("editEpisode") {
        s.push_str(r#"

DIRECT CREATIVE EDITING MODE — ACTIVE:
- This mode replaces the multi-stage `continuePassage` / `rewritePassage` / `lineEditPassage` pipeline. When asked to write or edit fiction, compose the finished Japanese manuscript prose yourself following all narration-mode, canon, and style rules, and apply it directly via `editEpisode` (hashline patch) in this same turn.
- Ground first with `getEpisodeLines` or `findEpisodeLines` to obtain the current `[episodeId#TAG]`. For appending at the end of an episode, use `INS.TAIL:` (or `INS.POST N:` after the last line) with `+TEXT` rows. Never retype unchanged lines.
- Do NOT merely print the story prose in chat: the task is complete only after `editEpisode` returns success.
- If `editEpisode` rejects due to a stale tag, re-read with `getEpisodeLines` and retry once with the fresh `[episodeId#TAG]`. If it still fails, report the failure honestly without claiming the manuscript was updated.
"#);
    }

    // CACHED PASSAGE PROPOSALS
    let has_proposal_tools = available.contains("listPassageProposals")
        || available.contains("getPassageProposal")
        || available.contains("applyPassageProposal");
    if has_proposal_tools {
        s.push_str(r#"

CACHED PASSAGE PROPOSALS (`listPassageProposals`, `getPassageProposal`, `applyPassageProposal`):
- Continuation proposals generated by `continuePassage` persist across turns. Call `listPassageProposals` when no `proposalId` is in context or when the user asks about earlier proposals.
- Call `getPassageProposal` to inspect or quote the exact full text of a cached proposal.
- Call `applyPassageProposal` when the user asks to adopt/write a cached proposal into the episode. It appends the cached text cleanly and marks the proposal as applied; never re-apply an already-applied proposal unless the user explicitly asks to duplicate it.
"#);
    }

    if available.contains("rewritePassage") {
        s.push_str(r#"

CREATIVE REWRITE (`rewritePassage`):
- IF the user asks to rewrite, polish, or produce a stylistic variant of an existing manuscript passage → call `rewritePassage` instead of rewriting it inline in chat. It invokes the dedicated writing model with full context and style rules.
- `targetText` MUST be an exact, verbatim copy of the target passage from the manuscript (verify with `findEpisodeLines` or `getEpisodeLines` first; never paraphrase).
- Pass the user's stylistic or narrative direction in `instruction` (in Japanese).
- Present the returned `rewrittenText` as a proposal; apply it with `editEpisode` only when the user asks to apply it to the manuscript.
- IF `rewritePassage` fails or returns empty → report that honestly in Japanese, then provide an inline rewrite as a fallback.
"#);
    }
    if available.contains("lineEditPassage") {
        s.push_str(r#"

LINE EDITING (`lineEditPassage`):
- IF the user asks for professional editorial line-editing with concrete revision proposals (ペン入れ, 推敲, 校閲, 添削) → call `lineEditPassage`.
- `passageText` MUST be a verbatim copy of ONE contiguous manuscript span. If the target is very long, propose working scene by scene (roughly 1,000–3,000 characters per pass) and confirm with the user.
- Pass the user's editorial focus in `instruction` (in Japanese).
- Present the review's key findings followed by each numbered replacement proposal (`targetText` → `replacementText`). The tool does not modify the episode automatically.
- For general critique/feedback that does not ask for concrete replacement patches, answer directly without calling `lineEditPassage`.
"#);
    }
    if available.contains("listEpisodes")
        || available.contains("retrieveEpisode")
        || available.contains("searchEpisodes")
    {
        s.push_str(r#"

PAST EPISODE RETRIEVAL (`listEpisodes`, `searchEpisodes`, `retrieveEpisode`, `rebuildSearchIndex`):
- When the target episode is unknown, locate candidates first with `listEpisodes` or `searchEpisodes`.
- Prefer `retrieveEpisode` with `type: "summary"` when a synopsis suffices; request `type: "fullText"` only when exact wording, dialogue, or scene detail is required.
- Call `rebuildSearchIndex` only when search results are demonstrably missing or stale, then search again.
"#);
    }
    if available.contains("getEditLog") {
        s.push_str(r#"

EDIT LOG (`getEditLog`):
- Before continuing, rewriting, or critiquing a passage whose past revision intent matters — or whenever the user asks why a change was made — call `getEditLog`. NEVER guess past editorial intent.
- Call `getEditLog` at most once per episode per turn.
"#);
    }
    if available.contains("saveEpisodeSummaryAndOneLiner") {
        s.push_str(
            r#"

SUMMARY SAVING (`saveEpisodeSummaryAndOneLiner`):
- Call only when the user asks to create, save, update, or regenerate an episode summary.
- Base both `content` (detailed summary) and `oneLiner` (single-sentence core) strictly on events explicitly written in the episode text.
- Call `saveEpisodeSummaryAndOneLiner` once with both fields together, and do not dump the full summary text in chat before calling the tool.
"#,
        );
    }
    if available.contains("createCharacter") || available.contains("updateCharacter") {
        s.push_str(r#"

CHARACTER SETTINGS (`listCharacters`, `createCharacter`, `updateCharacter`):
1. Before `createCharacter`, ALWAYS call `listCharacters` and compare names, kana readings, aliases, surnames, titles/ranks, forms of address, spacing, and spelling variants.
2. IF the character already exists → NEVER create a duplicate; use `updateCharacter` when an update is requested.
3. IF identity is ambiguous → do NOT create a record; ask or report the candidate match in Japanese.
4. Call `createCharacter` at most once per distinct person in a turn.
5. Before `updateCharacter`, verify `characterId` and existing field values; modify only the requested fields.
6. Store kana pronunciation in `reading`, and nicknames / title forms / alternate spellings in `alias`.
7. Format `customFields` as an array of `{label, value}` objects with Japanese values.
"#);
    }
    if available.contains("createWorldEntry") || available.contains("updateWorldEntry") {
        s.push_str(
            r#"

WORLDBUILDING SETTINGS (`listWorldEntries`, `createWorldEntry`, `updateWorldEntry`):
- Always call `listWorldEntries` before creating or updating an entry to prevent duplicates and verify `entryId` and current values.
- Modify only the requested fields; never invent unstated lore to fill blank fields.
- Format `customFields` as an array of `{label, value}` objects with Japanese values.
"#,
        );
    }
    if available.contains("createRelationship") || available.contains("updateRelationship") {
        s.push_str(r#"

RELATIONSHIPS (`listRelationships`, `createRelationship`, `updateRelationship`):
- Call both `listCharacters` and `listRelationships` before creating or updating a relationship.
- Use only verified `characterId` values returned by `listCharacters`; never guess IDs from similar names.
- Update an existing relationship record when the pair and episode scope already exist instead of creating a duplicate.
- Keep `direction` as `"a-to-b"`, `"b-to-a"`, or `"mutual"`, and write `description` in natural Japanese.
"#);
    }
    if available.contains("createProjectMemo") || available.contains("updateProjectMemo") {
        s.push_str(r#"

MEMOS (`listEpisodeMemos`, `getEpisodeMemo`, `saveEpisodeMemo`, `listProjectMemos`, `getProjectMemo`, `createProjectMemo`, `updateProjectMemo`):
- Read existing memos before creating or updating to avoid duplicate topics and preserve unrelated notes.
- Write all stored titles and memo bodies in Japanese.
- Never save tentative assistant ideas as project canon memos unless the user explicitly asks to record them.
"#);
    }
    if available.contains("craftAdvice") {
        s.push_str(r#"

CRAFT CONSULTATION (`craftAdvice`):
- IF the user asks for story/scene consultation (作劇相談: how a scene should develop, how to resolve a plot or pacing stall, why a dramatic beat feels flat, or which structural option to pick) → call `craftAdvice` with the full consultation context in Japanese.
- `craftAdvice` runs the judgment model with the full novel-principles ruleset to produce a diagnosis, concrete options with tradeoffs, and a clear recommendation. Do not answer 作劇相談 solely from chat-model improvisation when `craftAdvice` is available.
- Tool routing: concrete line-level edits (ペン入れ/添削) → `lineEditPassage`; prose rewriting → `rewritePassage`; new scene/continuation generation → `continuePassage`.
"#);
    }
    if available.contains("recordCraftNote") || available.contains("getCraftNotes") {
        s.push_str(r#"

CRAFT NOTES (`recordCraftNote`, `getCraftNotes`):
- Call `recordCraftNote` after a writing/editing cycle when a clear craft lesson emerged (an adopted revision, a praised technique, a recurring review flag, or an explicit author preference).
- Pass concrete evidence in `record`: what was written, what the review or author judged, what was adopted or rejected, and why.
- Call `getCraftNotes` when the user asks about accumulated craft lessons or before continuing work where past craft notes apply.
- Never store plot facts, character settings, or worldbuilding lore as craft notes.
"#);
    }
    if available.contains("checkCommonSense") {
        s.push_str(r#"

COMMON SENSE CHECK (`checkCommonSense`):
- After writing or editing manuscript prose — especially in direct creative editing mode — call `checkCommonSense` on the newly written or modified passage before reporting completion.
- If `checkCommonSense` reports `major` findings (calendar/school-year mismatches, seasonal contradictions, physical/causal impossibilities, legal/era anachronisms not overridden by worldbuilding), fix them with `editEpisode` before finishing.
- `checkCommonSense` audits real-world plausibility; for project canon continuity, use `checkConsistency`.
"#);
    }

    s
}
const BASE_TOOL_GUIDANCE: &str = r#"
TOOL USE — follow these steps in this exact order for every request:

STEP 1 — DECIDE & ROUTE:
- IF the request requires reading, searching, verifying, writing, editing, saving, updating, creating, deleting, or auditing application data AND a matching tool is available below → you MUST invoke that tool.
- For web research, prefer the selected provider's native hosted search according to the user's search priority; use `webSearch` (Exa fallback) when native search is unavailable or when Exa format is needed.
- Describing a plan, printing hypothetical tool arguments, or outputting prose in chat instead of calling a required write/generation tool is an incomplete execution.
- IF no tool is needed → answer directly in Japanese and skip Steps 2–5.

STEP 2 — READ BEFORE WRITE:
- Before creating or modifying any record or episode text, read the target's current ID, tag, and values using the corresponding list/get/find/search tool.
- NEVER invent or guess an ID or `[episodeId#TAG]`. Reuse reliable read results already obtained in the current turn instead of calling the same read tool redundantly.

STEP 3 — WRITE PRECISELY ONCE:
- Modify only what the user requested; preserve all unrelated fields and lines intact.
- Execute each write operation once. After a write tool returns success, NEVER repeat the identical write call.
- NEVER overwrite existing fields with guesses or empty strings.

STEP 4 — HANDLE ERRORS HONESTLY:
- NEVER claim a tool action succeeded when it failed or was not called.
- If a tool call fails, state the cause briefly in Japanese and retry only the failed operation with corrected inputs. If the same call fails twice with the same error, stop retrying and report the issue clearly in Japanese.

STEP 5 — REPORT CONCISELY AND STOP:
- Once all required tool calls have succeeded, provide one concise Japanese report summarizing what was done (e.g., updated fields or edited line ranges) and stop calling tools.
- Do not dump raw hashline patches or full JSON payloads unless the user asks for them.

JAPANESE DATA CHECK — verify before every create/update/save tool call:
1. Every natural-language field value persisted by a tool MUST be natural Japanese. 保存する説明文・メモ・要約・理由は必ず日本語で書くこと。If a draft value is descriptive English, translate it into natural Japanese before calling the tool.
2. Preserve verbatim without translation: IDs, schema keys, field names, enum values, exact source quotations, exact-match target text, code, URLs, filenames, and established foreign proper nouns.
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatch_rejects_tools_hidden_by_mode_and_episode_selection() {
        use crate::ai::tool_validation::validate_call;
        let direct = available_definitions(true, true);
        assert!(
            validate_call(&direct, "continuePassage", &json!({"instruction":"続けて"})).is_err()
        );
        let no_episode = available_definitions(false, false);
        assert!(validate_call(
            &no_episode,
            "editEpisode",
            &json!({"input":"patch","reason":"修正"})
        )
        .is_err());
        assert!(validate_call(
            &available_definitions(false, true),
            "editEpisode",
            &json!({"input":"patch","reason":"修正"})
        )
        .is_ok());
    }

    #[test]
    fn batch_edit_validation_runs_before_dispatch() {
        use crate::ai::tool_validation::validate_call;
        let tools = available_definitions(false, true);
        assert!(validate_call(&tools, "editEpisodeBatch", &json!({"edits":[]})).is_err());
        assert!(validate_call(
            &tools,
            "editEpisodeBatch",
            &json!({"edits":[{
                "startLine":0,"endLine":1,"expectedText":"a","replacementText":"b","reason":"修正"
            }]})
        )
        .is_err());
    }

    #[test]
    fn tool_schemas_reject_missing_or_unknown_arguments() {
        let tools = definitions();
        let edit = tools
            .iter()
            .find(|tool| tool["name"] == "editEpisode")
            .expect("editEpisode definition");
        let schema = &edit["inputSchema"];
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["required"].as_array().map(Vec::len), Some(2));
    }

    #[test]
    fn npm_compatible_tool_contracts_keep_optional_fields_optional() {
        let tools = definitions();
        let batch = tools
            .iter()
            .find(|tool| tool["name"] == "editEpisodeBatch")
            .expect("editEpisodeBatch definition");
        assert_eq!(batch["inputSchema"]["required"], json!(["edits"]));
        assert_eq!(batch["inputSchema"]["properties"]["edits"]["minItems"], 1);

        let retrieve = tools
            .iter()
            .find(|tool| tool["name"] == "retrieveEpisode")
            .expect("retrieveEpisode definition");
        assert!(retrieve["inputSchema"]["properties"].get("type").is_some());
        assert!(retrieve["inputSchema"]["properties"]
            .get("contentType")
            .is_none());

        let web_search = tools
            .iter()
            .find(|tool| tool["name"] == "webSearch")
            .expect("webSearch definition");
        assert_eq!(web_search["inputSchema"]["required"], json!(["query"]));
    }

    #[test]
    fn every_tool_name_is_unique() {
        let tools = definitions();
        let mut names = tools
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect::<Vec<_>>();
        let count = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), count);
    }

    #[test]
    fn tool_progress_card_contains_renderer_contract() {
        let content = format_tool_card(
            "call-1",
            "searchEpisodes",
            "実行中",
            Some(&json!({"query":"伏線"})),
            None,
        );
        assert!(content.starts_with("【ツール実行中: searchEpisodes】"));
        assert!(content.contains("状態: 実行中"));
        assert!(content.contains("ID: call-1"));
        assert!(content.contains("チップ: 検索: 伏線"));
        assert!(content.contains("結果:\n（実行中）"));
    }
}
