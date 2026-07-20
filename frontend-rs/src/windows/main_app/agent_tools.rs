use std::{cell::RefCell, rc::Rc};

use serde::Deserialize;
use serde_json::{json, Map, Value};
use wasm_bindgen::JsValue;
use web_sys::Document;

use super::{sync_chat, ChatMessage, ChatTransportMetadata, State};
use crate::{
    data::projects,
    runtime::{ai, invoke},
};

const MAX_TOOL_ROUNDS: usize = 16;

/// 重複するツール呼び出しを検出した場合に中断するためのしきい値
const MAX_DUPLICATE_CALLS: usize = 2;

mod genre;
mod project;
mod writing;

pub async fn run(
    document: &Document,
    state: &Rc<RefCell<State>>,
    mut system: String,
    mut messages: Vec<Value>,
    direct_creative_edit: bool,
) -> Result<ai::GeneratedText, JsValue> {
    let definitions = definitions();
    let tool_names = definitions
        .iter()
        .filter_map(|d| d["name"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    let tool_name_refs = tool_names.iter().map(String::as_str).collect::<Vec<_>>();
    system.push_str(&build_tool_guidance(&tool_name_refs, direct_creative_edit));
    let settings_context = {
        let current = state.borrow();
        super::prompt_context::build_settings_context(&current, &current.ai_settings)
    };
    if !settings_context.trim().is_empty() {
        system.push_str("\n\nSTORY REFERENCE DATA — this project's established facts (worldbuilding, characters, relationships, memos, recent synopses):\n1. BEFORE writing fiction or answering anything about this story → look up every character, place, and term of the current scene in the data below.\n2. Facts recorded there are true. Use them exactly as recorded. NEVER contradict or restyle them.\n3. IF a fact is not recorded there → it is unknown. NEVER state it as established canon.\n4. The data does NOT expand what the viewpoint character knows.\n5. Derive plausible knowledge and experience from recorded social attributes.\n6. 設定資料に記録された事実は必ず記録通りに使うこと。\n\n<reference_data name=\"story_reference\">\n");
        system.push_str(
            &settings_context
                .replace("<reference_data", "＜reference_data")
                .replace("</reference_data", "＜/reference_data"),
        );
        system.push_str("\n</reference_data>");
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
            transport: Some(chat_transport(&generated.provider, &generated.model, generated.finish_reason.as_deref())),
        });
        render_progress(document, state);
        return Ok(generated);
    };
    // 直前のラウンドで同じツール+同じ引数での呼び出しを検出し、ループ暴走を防ぐ
    let mut recent_calls: Vec<(String, String)> = Vec::new();
    for _ in 0..MAX_TOOL_ROUNDS {
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
        let progress_document = document.clone();
        let progress_state = Rc::clone(state);
        let turn_result = ai::agent_turn_observed(
            "chat",
            system.clone(),
            messages.clone(),
            definitions.clone(),
            provider.as_deref(),
            model.as_deref(),
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
        let turn = match turn_result {
            Ok(turn) => turn,
            Err(error) => {
                remove_empty_progress(state, progress_index);
                render_progress(document, state);
                return Err(error);
            }
        };
        if turn.tool_calls.is_empty() {
            if verify_tool_call_need(&messages, &turn.text, &tool_names).await {
                if let Some(message) = state.borrow_mut().chat.get_mut(progress_index) {
                    message.transport = Some(chat_transport(&turn.provider, &turn.model, turn.finish_reason.as_deref()));
                }
                messages.push(json!({"role":"assistant","content":turn.text}));
                messages.push(json!({"role":"user","content":"まだ必要なツールを呼び出していないようです。先にツールを呼び出してから、必要であれば説明を続けてください。"}));
                continue;
            }
            if let Some(message) = state.borrow_mut().chat.get_mut(progress_index) {
                if message.content.trim().is_empty() {
                    message.content = if direct_creative_edit {
                        "本文を編集しました。".into()
                    } else {
                        "（応答がありませんでした）".into()
                    };
                }
                message.transport = Some(chat_transport(&turn.provider, &turn.model, turn.finish_reason.as_deref()));
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
            message.transport = Some(chat_transport(&turn.provider, &turn.model, turn.finish_reason.as_deref()));
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
                    content: "（ツール実行後にモデルが停止しました。追加の指示を送ってください。）".into(),
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
        }
        recent_calls.extend(turn.tool_calls.iter().map(|c| {
            (
                c.name.clone(),
                serde_json::to_string(&c.input).unwrap_or_default(),
            )
        }));
        if recent_calls.len() > 8 {
            let drop_count = recent_calls.len() - 8;
            recent_calls.drain(0..drop_count);
        }

        let mut assistant_parts = Vec::new();
        if !turn.text.trim().is_empty() {
            assistant_parts.push(json!({"type":"text","text":turn.text}));
        }
        for call in &turn.tool_calls {
            assistant_parts.push(json!({
                "type":"tool-call",
                "toolCallId":call.id,
                "toolName":call.name,
                "input":call.input,
            }));
        }
        messages.push(json!({"role":"assistant","content":assistant_parts}));
        let mut results = Vec::new();
        for call in turn.tool_calls {
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
            let execution = execute(
                state,
                &project_id,
                current_episode.as_deref(),
                &call.name,
                call.input.clone(),
                &mut report_tool_progress,
            )
            .await;
            let (status, output) = match execution {
                Ok(output) if output.get("error").is_none() => ("成功", output),
                Ok(output) => ("失敗", output),
                Err(error) => ("失敗", json!({"error":js_error(&error)})),
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
    let current = state.borrow();
    let _ = super::render::chat(document, &current);
    sync_chat(&current);
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

fn chat_transport(provider: &str, model: &str, finish_reason: Option<&str>) -> ChatTransportMetadata {
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
                    t.starts_with("SWAP")
                        || t.starts_with("DEL")
                        || t.starts_with("INS")
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
            let id = obj
                .get("episodeId")
                .and_then(Value::as_str)
                .unwrap_or("?");
            vec![format!("episodeId: {id}")]
        }
        "saveEpisodeSummary" | "saveEpisodeOneLiner" | "saveEpisodeSummaryAndOneLiner" => {
            let id = obj
                .get("episodeId")
                .and_then(Value::as_str)
                .unwrap_or("?");
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
        chips.push(if success { "成功".into() } else { "失敗".into() });
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
                "save_episode_summary",
                &json!({"req":{"projectId":project_id,"episodeId":episode_id.clone(),"content":content}}),
            )
            .await?;
            invoke::invoke::<_, ()>(
                "save_episode_one_liner",
                &json!({"req":{"projectId":project_id,"episodeId":episode_id,"oneLiner":one_liner}}),
            )
            .await?;
            json!({"success":true})
        }
        "getEpisodeLines" => {
            let episode_id = resolve_episode_id(&input, current_episode)?;
            let start = input.get("startLine").and_then(Value::as_u64).map(|v| v as u32);
            let end = input.get("endLine").and_then(Value::as_u64).map(|v| v as u32);
            let episodes = state.borrow().episodes.clone();
            super::hashline_tools::ground_episode_lines(
                project_id, &episode_id, &episodes, start, end,
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
            let context = input.get("contextLines").and_then(Value::as_u64).map(|v| v as u32);
            let max = input.get("maxMatches").and_then(Value::as_u64).map(|v| v as usize);
            let case_sensitive = input.get("caseSensitive").and_then(Value::as_bool);
            let episodes = state.borrow().episodes.clone();
            super::hashline_tools::ground_find_episode_lines(
                project_id, &episode_id, &episodes, &query, context, max, case_sensitive,
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
            let result =
                super::hashline_tools::apply_hashline_edit(project_id, &episodes, &patch_input, &reason)
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
            let _: Value =
                invoke::invoke("rebuild_search_index", &json!({"projectId":project_id}))
                    .await
                    .unwrap_or(Value::Null);
            result
        }
        command => {
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
        state.borrow_mut().summaries = projects::read_document(project_id, "summaries")
            .await?
            .unwrap_or_else(|| json!({"summaries":{}}));
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
            object([
                ("episodeId", string()),
                ("contentType", enum_string(&["summary", "fullText"])),
            ]),
        ),
        tool(
            "searchEpisodes",
            "Searches project episodes and summaries.",
            object([("query", string()), ("limit", integer())]),
        ),
        tool(
            "rebuildSearchIndex",
            "Rebuilds the project search index when results are stale.",
            object([]),
        ),
        tool(
            "getEpisodeLines",
            "Reads episode text as hashline-numbered lines: a `[episodeId#TAG]` header plus `LINE:TEXT` rows. Copy the header (including #TAG) and line numbers verbatim to anchor an editEpisode.",
            object([
                ("episodeId", string()),
                ("startLine", integer()),
                ("endLine", integer()),
            ]),
        ),
        tool(
            "findEpisodeLines",
            "Searches an episode and returns matching lines with context as hashline-numbered output (`[episodeId#TAG]` header + `LINE:TEXT` rows).",
            object([
                ("episodeId", string()),
                ("query", string()),
                ("contextLines", integer()),
                ("maxMatches", integer()),
                ("caseSensitive", boolean()),
            ]),
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
            "getEditLog",
            "Reads recent manuscript edit history and reasons.",
            object([("episodeId", string()), ("limit", integer())]),
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
            "Searches the web for current factual information.",
            object([("query", string()), ("numResults", integer())]),
        ),
        tool(
            "webFetch",
            "Fetches readable content from a URL.",
            object([
                ("url", string()),
                ("format", enum_string(&["text", "markdown", "html"])),
            ]),
        ),
    ];
    definitions.extend(project::definitions());
    definitions.extend(genre::definitions());
    definitions.extend(writing::definitions());
    definitions
}

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({"name":name,"description":description,"inputSchema":input_schema})
}
fn object<const N: usize>(properties: [(&str, Value); N]) -> Value {
    let required = properties
        .iter()
        .map(|(key, _)| Value::String((*key).into()))
        .collect::<Vec<_>>();
    let properties = properties
        .into_iter()
        .map(|(key, value)| (key.into(), value))
        .collect::<Map<String, Value>>();
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
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
        || available.contains("editEpisode");
    if has_episode_tools {
        s.push_str(r#"

EPISODE TEXT EDITING (hashline) - follow in this order:
1. WHEN THE USER ASKS YOU TO WRITE FICTION: 「〜を書いて」「本文に追加して」「小説の続きを書いて」「物語を作って」「以下の内容を反映して」など、ユーザーが明示的に本文執筆・追記・編集を依頼した場合 → 相談だけで終わらず、必ずツールを使って実際に本文に書き込むこと。執筆依頼をチャットの相談にすり替えてツールを呼ばないことは禁止。
2. GROUND FIRST: Before editing, ALWAYS read the target with getEpisodeLines (a range) or findEpisodeLines (a search). They return a `[episodeId#TAG]` header plus `LINE:TEXT` rows. NEVER guess line numbers or content from memory.
3. EDIT WITH A PATCH: call editEpisode with `input` = one or more sections. Each section starts with the `[episodeId#TAG]` header you just read (copy it verbatim, including #TAG), followed by line ops:
   - `SWAP N.=M:` replace original lines N..M (inclusive) with the `+TEXT` body rows below.
   - `DEL N.=M` delete lines N..M (no body).
   - `INS.PRE N:` / `INS.POST N:` insert body before/after line N. `INS.HEAD:` / `INS.TAIL:` insert at file start/end.
   - Every body row is `+TEXT` (a literal line; `+` alone = blank line). A Markdown bullet is `+- item`. NEVER write `-old` or bare context lines — the range names what changes, the body is only the new content.
   - Single line: `SWAP N.=N:` / `DEL N`.
4. Line numbers refer to the ORIGINAL read output and never shift as hunks apply. Touch only lines the read literally displayed.
5. RANGES ARE TIGHT: cover ONLY lines whose content changes. Never widen a range over unchanged lines. Pure additions use `INS.*`, never a widened `SWAP`.
6. RE-GROUND AFTER EVERY EDIT: each successful editEpisode mints a fresh #TAG and renumbers. Take the next edit's header/numbers from the edit response (it returns updated `numberedText`) or a fresh getEpisodeLines. On a stale-tag rejection or any surprising result, STOP and re-read before further edits.
7. Multiple separate changes = multiple sections (or multiple hunks under one header) in a SINGLE editEpisode call — they apply all-or-nothing. Never chain editEpisode calls for changes that belong together.
8. Body text must be Japanese, unless the user explicitly asked for another language.
9. Do NOT ask for confirmation before a clearly requested edit. Ask first only when the target range, the intended change, or the canon impact is ambiguous or high-risk.
10. reason is required on every edit. State the concrete problem this change fixes or the goal it achieves, in Japanese. NEVER write filler like 「より自然にするため」. This text is saved permanently to a project edit log that other sessions and future consistency checks will read.
11. After a successful edit, report what changed once (the returned warnings/numberedText). Do not reprint the whole patch unless the user asks.
"#);
    }

    // NEW FICTION GENERATION (continuePassage)
    if available.contains("continuePassage") {
        s.push_str(r#"

NEW FICTION GENERATION (continuePassage):
- IF the user asks you to write a new continuation, scene, passage, dialogue sequence, or other manuscript prose → you MUST call continuePassage. Do NOT compose the prose in the chat model and do NOT place prose you invented directly into editEpisode.
- Put the complete author request into instruction: desired event, mood, length, viewpoint constraints, and anything that must or must not happen.
- The tool uses the dedicated writing settings and, when enabled, multiple candidates, judgment-model selection, review, and deterministic checks.
- The result is saved in the proposal cache and does NOT modify the manuscript by itself. If the user explicitly requested writing/application now, immediately call applyPassageProposal with the returned proposalId. Do not copy generatedText into editEpisode.
- IF the tool fails → report the failure honestly. Do not silently replace it with chat-model prose.
"#);
    }

    // DIRECT CREATIVE EDITING MODE
    if direct_creative_edit && available.contains("editEpisode") {
        s.push_str(r#"

DIRECT CREATIVE EDITING MODE - ACTIVE:
- This mode replaces the multi-stage continuePassage pipeline. For a request to write new fiction, you MUST write the final Japanese prose yourself and apply it with editEpisode (a hashline patch) in this same turn. Do not call continuePassage, rewritePassage, lineEditPassage, or any proposal-selection/review pipeline.
- Ground first with getEpisodeLines or findEpisodeLines, then issue a hashline patch. For a continuation at the end, use `INS.TAIL:` (or `INS.POST N:` after the final line) with the newly written prose as `+TEXT` body rows. Do not retype unchanged lines.
- Do not merely print or propose the prose in chat. The requested result is complete only after editEpisode returns success.
- Keep canon, viewpoint, tense, voice, and the user's requested length, but perform no separate planning, candidate generation, literary review, or regression comparison.
- If editEpisode rejects with a stale tag, re-read the affected range and retry once with the fresh `[episodeId#TAG]`. If it still fails, report the failure without claiming that the manuscript changed.
"#);
    }

    // CACHED PASSAGE PROPOSALS
    let has_proposal_tools = available.contains("listPassageProposals")
        || available.contains("getPassageProposal")
        || available.contains("applyPassageProposal");
    if has_proposal_tools {
        s.push_str(r#"

CACHED PASSAGE PROPOSALS:
- Previously generated continuation proposals persist outside chat history. Use listPassageProposals when the user asks what was generated earlier or no proposalId is available in the current context.
- Use getPassageProposal to quote or inspect the exact full cached text.
- Use applyPassageProposal when the user asks to write/apply a cached proposal. It inserts the cached text directly at the current editor cursor and saves the episode; do not reconstruct the text with editEpisode.
- Never apply an already-applied proposal again unless the user explicitly requests a duplicate, in which case generate a new proposal.
"#);
    }

    if available.contains("rewritePassage") {
        s.push_str(r#"

CREATIVE REWRITE (rewritePassage):
- IF the user asks for better phrasing, a rewrite, polish, or a stylistic variant of manuscript prose → you MUST call rewritePassage instead of rewriting the prose yourself in chat. It runs the dedicated writing model with the full Japanese-fiction ruleset.
- targetText MUST be a verbatim copy of the passage. Verify it with findEpisodeLines or getEpisodeLines when unsure. NEVER paraphrase it.
- Put the user's stylistic direction into instruction, in Japanese. Omit instruction when no specific direction was given.
- Present rewrittenText as a proposal. The tool does NOT modify the episode. Apply it with editEpisode only when explicitly asked.
- IF the tool fails or returns empty → say so honestly, then rewrite inline as a fallback.
"#);
    }
    if available.contains("lineEditPassage") {
        s.push_str(r#"

LINE EDITING (lineEditPassage):
- IF the user asks for professional editing WITH concrete revision proposals — ペン入れ, 推敲, 校閲, 添削 — you MUST call lineEditPassage.
- passageText MUST be a verbatim copy of ONE contiguous manuscript passage. For long text, propose working scene by scene (roughly 1000-3000 characters) and confirm that plan first.
- Put the user's editorial focus into instruction, in Japanese.
- Present the review's key findings, then each proposal numbered with the exact target and proposed replacement. The tool does NOT modify the episode.
- For critique-only requests where revision proposals are unnecessary, answer directly.
"#);
    }
    if available.contains("listEpisodes")
        || available.contains("retrieveEpisode")
        || available.contains("searchEpisodes")
    {
        s.push_str(r#"

PAST EPISODE RETRIEVAL:
- IF the target episode is unclear → find candidates with listEpisodes or searchEpisodes first.
- Use retrieveEpisode with summary when a synopsis is enough. Request fullText only to verify exact wording, a scene, or an action.
- Run rebuildSearchIndex only when search results are clearly missing or stale. Then search again.
"#);
    }
    if available.contains("getEditLog") {
        s.push_str(r#"

EDIT LOG:
- IF you need to know why a past change was made — including before continuing, rewriting, or judging previously edited text — call getEditLog. NEVER guess past intent.
- IF the user asks about editing history or intent → call getEditLog before answering.
- Call it once per need; do not re-fetch the same episode repeatedly in one turn.
"#);
    }
    if available.contains("saveEpisodeSummaryAndOneLiner") {
        s.push_str(
            r#"

SUMMARY SAVING:
- Apply only when the user asks to create, save, update, or regenerate an episode summary.
- Derive both summaries only from events explicitly present in the episode text.
- Call saveEpisodeSummaryAndOneLiner exactly once, saving content and oneLiner together.
- Do not print the summaries in chat before the tool call.
"#,
        );
    }
    if available.contains("createCharacter") || available.contains("updateCharacter") {
        s.push_str(r#"

CHARACTER SETTINGS:
1. Before createCharacter, ALWAYS call listCharacters. Compare names, readings, aliases, surnames, ranks/titles, forms of address, spacing, width, and spelling variants.
2. IF the same person exists → NEVER create a duplicate. Update the existing record when requested.
3. IF identity is uncertain → do NOT create; report the candidate in Japanese.
4. Call createCharacter at most once per person in one response.
5. Before updateCharacter, confirm characterId and current values. Update only requested fields.
6. Put よみがな into reading; nicknames, title forms, and alternate spellings into alias.
7. customFields MUST be an array of {label, value}.
"#);
    }
    if available.contains("createWorldEntry") || available.contains("updateWorldEntry") {
        s.push_str(
            r#"

WORLDBUILDING SETTINGS:
- Before updating, call listWorldEntries to confirm entryId and current values.
- Update only requested fields. Do not fill missing information by inference.
- customFields MUST be an array of {label, value}.
"#,
        );
    }
    if available.contains("createRelationship") || available.contains("updateRelationship") {
        s.push_str(r#"

RELATIONSHIPS:
- Call listCharacters and listRelationships before creating or updating a relationship.
- Use only returned character IDs. Do not infer identity from similar names without evidence.
- Avoid duplicate relationships. Update an existing relationship when it represents the same pair and scope.
- Keep direction as a-to-b, b-to-a, or mutual. Write description in Japanese.
"#);
    }
    if available.contains("createProjectMemo") || available.contains("updateProjectMemo") {
        s.push_str(r#"

MEMOS:
- Read existing memos before creating or updating one. Do not create duplicates for the same subject.
- Preserve unrelated content. Write stored title and prose in Japanese.
- Do not promote guesses or assistant suggestions into project canon without an explicit user request.
"#);
    }

    s
}
const BASE_TOOL_GUIDANCE: &str = r#"
TOOL USE — follow these steps in this exact order for every request:

STEP 1 — DECIDE:
- IF the request needs current application data or a data change (retrieve, search, verify, edit, save, update, create, delete, consistency check) AND a capable tool is listed below → you MUST actually call that tool.
- Writing a plan, a procedure, or tool arguments as plain text is NOT execution. A reply that only describes what should be done is an unfinished task.
- IF no tool is needed → answer directly and skip the remaining steps.

STEP 2 — READ BEFORE WRITE:
- Before changing data, first read the target's ID and current values with the matching list/get/search tool.
- NEVER invent or guess an ID. Use only IDs returned by a tool or given by the user.
- Do not repeat a read whose reliable result you already have in this run.

STEP 3 — WRITE EXACTLY ONCE:
- Change only what the user asked for. Nothing extra.
- Execute each change exactly once. After a write tool returns success, NEVER call the same write tool again with the same input.
- NEVER overwrite a value you do not know with a guess or an empty string.

STEP 4 — IF A CALL FAILS:
- NEVER report success for a failed call.
- State the cause briefly in Japanese. Then retry only the failed part. IF the same call fails twice with the same error → stop retrying and report the situation honestly in Japanese.

STEP 5 — REPORT AND STOP:
- When the tools that answer the request have succeeded, give exactly one short Japanese report. Then stop calling tools.
- In the report, summarize what changed (lines/sections edited). Do not reprint the full hashline patch or other raw tool arguments unless the user asks.

JAPANESE DATA CHECK — run before every create/update/save call:
1. Every natural-language field value MUST be Japanese. 保存する説明文・メモ・要約は必ず日本語で書くこと。IF a value is ordinary descriptive English → translate it into natural Japanese first.
2. Keep unchanged: IDs, field names, enum values, exact quotations, exact-match source text, code, URLs, filenames, and established foreign proper nouns.
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_schemas_reject_missing_or_unknown_arguments() {
        let tools = definitions();
        let edit = tools
            .iter()
            .find(|tool| tool["name"] == "editEpisode")
            .expect("editEpisode definition");
        let schema = &edit["inputSchema"];
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["required"].as_array().map(Vec::len), Some(6));
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
