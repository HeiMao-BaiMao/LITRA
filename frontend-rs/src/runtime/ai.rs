use std::{cell::RefCell, rc::Rc};

use js_sys::{Date, Function};
use serde::{Deserialize, Serialize};
use wasm_bindgen::{closure::Closure, prelude::*, JsCast};

use super::{invoke, tauri};

thread_local! { static ACTIVE_REQUEST: RefCell<Option<String>> = const { RefCell::new(None) }; }

const AI_GENERATION_CANCELLED: &str = "AI_GENERATION_CANCELLED";

fn log_ai_info(message: &str) {
    web_sys::console::log_1(&format!("[litra-ai] {message}").into());
}

fn log_ai_warn(message: &str) {
    web_sys::console::warn_1(&format!("[litra-ai] {message}").into());
}

fn log_ai_error(message: &str) {
    web_sys::console::error_1(&format!("[litra-ai] {message}").into());
}

fn js_error_message(error: &JsValue) -> String {
    error.as_string().unwrap_or_else(|| format!("{error:?}"))
}

fn log_request_start(
    kind: &str,
    request_id: &str,
    role: &str,
    provider: &str,
    model: &str,
    messages: usize,
    tools: usize,
) {
    log_ai_info(&format!(
        "request:start kind={kind} request={request_id} role={role} provider={provider} model={model} messages={messages} tools={tools}"
    ));
}

fn log_request_end(
    kind: &str,
    request_id: &str,
    started_at: f64,
    text_chars: usize,
    tool_calls: usize,
    finish_reason: Option<&str>,
) {
    let elapsed = (Date::now() - started_at).max(0.0).round() as u64;
    log_ai_info(&format!(
        "request:finish kind={kind} request={request_id} elapsedMs={elapsed} textChars={text_chars} toolCalls={tool_calls} finishReason={}",
        finish_reason.unwrap_or("<none>")
    ));
}

fn log_request_failure(kind: &str, request_id: &str, started_at: f64, message: &str) {
    let elapsed = (Date::now() - started_at).max(0.0).round() as u64;
    log_ai_error(&format!(
        "request:error kind={kind} request={request_id} elapsedMs={elapsed} message={message}"
    ));
}

pub fn is_cancelled_error(error: &JsValue) -> bool {
    error.as_string().as_deref() == Some(AI_GENERATION_CANCELLED)
}

fn clear_active_request(request_id: &str) {
    ACTIVE_REQUEST.with(|active| {
        if active.borrow().as_deref() == Some(request_id) {
            active.borrow_mut().take();
        }
    });
}

#[wasm_bindgen(inline_js = r#"
export async function streamTauriAi(request, callback) {
  const channel = new window.__TAURI__.core.Channel();
  channel.onmessage = callback;
  return window.__TAURI__.core.invoke("ai_stream_text", { request, onEvent: channel });
}
"#)]
extern "C" {
    #[wasm_bindgen(catch, js_name = streamTauriAi)]
    async fn stream_tauri_ai(request: JsValue, callback: &Function) -> Result<JsValue, JsValue>;
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeConfig {
    provider: String,
    api_type: String,
    api_key: String,
    base_url: String,
    model: String,
    max_output_tokens: u64,
    temperature: Option<f64>,
    top_p: Option<f64>,
    top_k: Option<u64>,
    frequency_penalty: Option<f64>,
    presence_penalty: Option<f64>,
    reasoning_effort: Option<String>,
    thinking_enabled: Option<bool>,
    thinking_budget: Option<u64>,
    anthropic_thinking_effort: Option<String>,
    thinking_level: Option<String>,
    #[serde(default)]
    prompt_scaffold: Option<String>,
    #[serde(default)]
    max_context_tokens: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigArgs<'a> {
    role: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_override: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_override: Option<&'a str>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    pub id: String,
    pub label: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogProvider {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub models: Vec<CatalogModel>,
    #[serde(default)]
    pub fixed_models: bool,
    #[serde(default)]
    pub default_base_url: String,
    #[serde(default)]
    pub default_model: String,
    #[serde(default = "default_requires_api_key")]
    pub requires_api_key: bool,
}

fn default_requires_api_key() -> bool {
    true
}

pub async fn catalog() -> Result<Vec<CatalogProvider>, JsValue> {
    log_ai_info("catalog:request");
    let result = invoke::invoke("ai_provider_catalog", &()).await;
    if let Err(error) = &result {
        log_ai_error(&format!(
            "catalog:error message={}",
            js_error_message(error)
        ));
    } else {
        log_ai_info("catalog:received");
    }
    result
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    request_id: String,
    provider: String,
    api_type: String,
    api_key: String,
    base_url: String,
    model: String,
    system: String,
    messages: Vec<serde_json::Value>,
    tools: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    search_priority: Vec<String>,
    prompt: String,
    max_output_tokens: u64,
    temperature: Option<f64>,
    top_p: Option<f64>,
    top_k: Option<u64>,
    frequency_penalty: Option<f64>,
    presence_penalty: Option<f64>,
    reasoning_effort: Option<String>,
    thinking_enabled: Option<bool>,
    thinking_budget: Option<u64>,
    anthropic_thinking_effort: Option<String>,
    thinking_level: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_choice: Option<String>,
}

pub struct GeneratedText {
    pub text: String,
    pub provider: String,
    pub model: String,
    pub finish_reason: Option<String>,
}

#[derive(Clone)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: serde_json::Value,
}

pub struct AgentTurn {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    /// Full provider-compatible reasoning text for OpenAI-compatible chat
    /// endpoints such as DeepSeek thinking mode.
    pub reasoning: String,
    /// Opaque Responses reasoning item required for stateless Codex replay.
    pub responses_reasoning: Option<serde_json::Value>,
    /// Opaque Responses hosted-tool items required for stateless replay.
    pub responses_tool_items: Vec<serde_json::Value>,
    /// Anthropic server-tool blocks required when a client-tool round follows.
    pub anthropic_tool_context: Vec<serde_json::Value>,
    /// Complete Anthropic thinking blocks, including signatures.
    pub anthropic_thinking: Vec<serde_json::Value>,
    /// Gemini server-side tool parts required for Google Search context replay.
    pub google_tool_context: Vec<serde_json::Value>,
    pub provider: String,
    pub model: String,
    pub thinking_enabled: Option<bool>,
    pub finish_reason: Option<String>,
}

pub enum AgentStreamUpdate {
    TextDelta(String),
    ReasoningDelta(String),
}

pub async fn selection(role: &str) -> Result<(String, String), JsValue> {
    log_ai_info(&format!("config:selection role={role}"));
    let config: RuntimeConfig = match invoke::invoke(
        "ai_runtime_config",
        &ConfigArgs {
            role,
            provider_override: None,
            model_override: None,
        },
    )
    .await
    {
        Ok(config) => config,
        Err(error) => {
            log_ai_error(&format!(
                "config:error kind=selection role={role} message={}",
                js_error_message(&error)
            ));
            return Err(error);
        }
    };
    log_ai_info(&format!(
        "config:selected role={role} provider={} model={}",
        config.provider, config.model
    ));
    Ok((config.provider, config.model))
}

/// Resolve a provider-compatible forced tool choice from the effective model
/// settings. Thinking-capable providers may need `auto` instead of a hard
/// `required` choice, while OpenCode may need the field omitted entirely.
pub async fn forced_tool_choice(
    role: &str,
    provider_override: Option<&str>,
    model_override: Option<&str>,
) -> Result<Option<String>, JsValue> {
    log_ai_info(&format!("config:resolve kind=tool_choice role={role}"));
    let config: RuntimeConfig = match invoke::invoke(
        "ai_runtime_config",
        &ConfigArgs {
            role,
            provider_override,
            model_override,
        },
    )
    .await
    {
        Ok(config) => config,
        Err(error) => {
            log_ai_error(&format!(
                "config:error kind=tool_choice role={role} message={}",
                js_error_message(&error)
            ));
            return Err(error);
        }
    };
    Ok(crate::ai::capability::resolve_forced_tool_choice(
        &config.provider,
        &config.model,
        config.thinking_enabled,
    ))
}

/// 指定ロール（"writing"/"judgment" 等）に実効解決されるモデルの既定値を返す。
/// プロンプト構築前に scaffold・コンテキスト上限を知る必要がある呼び出し元
/// （generation::seed_model_scaffold_defaults 等）から使う。
/// generate() 内部の ai_runtime_config 呼び出しと同じコマンドを叩くだけの軽量版。
pub struct RoleDefaults {
    pub prompt_scaffold: Option<String>,
    pub max_context_tokens: Option<u64>,
    pub max_output_tokens: u64,
}

pub async fn role_defaults(role: &str) -> Result<RoleDefaults, JsValue> {
    let config: RuntimeConfig = invoke::invoke(
        "ai_runtime_config",
        &ConfigArgs {
            role,
            provider_override: None,
            model_override: None,
        },
    )
    .await?;
    Ok(RoleDefaults {
        prompt_scaffold: config.prompt_scaffold,
        max_context_tokens: config.max_context_tokens,
        max_output_tokens: config.max_output_tokens,
    })
}

pub async fn generate(
    role: &str,
    system: String,
    prompt: String,
) -> Result<GeneratedText, JsValue> {
    generate_with(role, system, prompt, None, None).await
}

pub async fn generate_with(
    role: &str,
    system: String,
    prompt: String,
    provider_override: Option<&str>,
    model_override: Option<&str>,
) -> Result<GeneratedText, JsValue> {
    log_ai_info(&format!(
        "config:resolve kind=completion role={role} providerOverride={} modelOverride={}",
        provider_override.unwrap_or("<default>"),
        model_override.unwrap_or("<default>"),
    ));
    let config: RuntimeConfig = match invoke::invoke(
        "ai_runtime_config",
        &ConfigArgs {
            role,
            provider_override,
            model_override,
        },
    )
    .await
    {
        Ok(config) => config,
        Err(error) => {
            log_ai_error(&format!(
                "config:error kind=completion role={role} message={}",
                js_error_message(&error)
            ));
            return Err(error);
        }
    };
    let provider = config.provider.clone();
    let model = config.model.clone();
    let request_id = format!("ai_{}", tauri::random_uuid().replace('-', ""));
    let started_at = Date::now();
    log_request_start("completion", &request_id, role, &provider, &model, 0, 0);
    let request = Request {
        request_id: request_id.clone(),
        provider: config.provider,
        api_type: config.api_type,
        api_key: config.api_key,
        base_url: config.base_url,
        model: config.model,
        system,
        messages: Vec::new(),
        tools: Vec::new(),
        search_priority: Vec::new(),
        prompt,
        // 出力上限はプロバイダー/モデルが定める上限(config.max_output_tokens)のみを使う。
        // TS 由来の 32768 キャップは reasoning モデルで思考トークンが全予算を
        // 消費し、本文ゼロの length 応答(空応答)を起こすため撤去した。
        max_output_tokens: config.max_output_tokens,
        temperature: config.temperature,
        top_p: config.top_p,
        top_k: config.top_k,
        frequency_penalty: config.frequency_penalty,
        presence_penalty: config.presence_penalty,
        reasoning_effort: config.reasoning_effort,
        thinking_enabled: config.thinking_enabled,
        thinking_budget: config.thinking_budget,
        anthropic_thinking_effort: config.anthropic_thinking_effort,
        thinking_level: config.thinking_level,
        tool_choice: None,
    };
    let request = serde_wasm_bindgen::to_value(&request)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let output = Rc::new(RefCell::new(String::new()));
    let event_error = Rc::new(RefCell::new(None::<String>));
    let cancelled = Rc::new(RefCell::new(false));
    let finish_reason = Rc::new(RefCell::new(None::<String>));
    let callback_output = Rc::clone(&output);
    let callback_error = Rc::clone(&event_error);
    let callback_cancelled = Rc::clone(&cancelled);
    let callback_finish = Rc::clone(&finish_reason);
    let callback_request_id = request_id.clone();
    let callback_role = role.to_owned();
    let callback_provider = provider.clone();
    let callback_model = model.clone();
    let callback = Closure::wrap(Box::new(move |event: JsValue| {
        let Ok(value) = serde_wasm_bindgen::from_value::<serde_json::Value>(event) else {
            log_ai_warn(&format!(
                "event:decode_error kind=completion request={callback_request_id}"
            ));
            return;
        };
        match value.get("type").and_then(|kind| kind.as_str()) {
            Some("text_delta") => {
                if let Some(delta) = value.get("delta").and_then(|item| item.as_str()) {
                    callback_output.borrow_mut().push_str(delta);
                }
            }
            Some("error") => {
                let message = value
                    .get("message")
                    .and_then(|item| item.as_str())
                    .unwrap_or("AIストリームから不明なエラーが返されました")
                    .to_owned();
                log_ai_error(&format!(
                    "event:error kind=completion request={} role={} provider={} model={} message={message}",
                    callback_request_id, callback_role, callback_provider, callback_model
                ));
                *callback_error.borrow_mut() = Some(message);
            }
            Some("cancelled") => {
                log_ai_warn(&format!(
                    "event:cancelled kind=completion request={callback_request_id}"
                ));
                *callback_cancelled.borrow_mut() = true;
            }
            Some("finished") => {
                if let Some(reason) = value.get("finish_reason").and_then(|item| item.as_str()) {
                    log_ai_info(&format!(
                        "event:finished kind=completion request={} finishReason={reason}",
                        callback_request_id
                    ));
                    *callback_finish.borrow_mut() = Some(reason.to_owned());
                }
            }
            _ => {}
        }
    }) as Box<dyn FnMut(JsValue)>);
    ACTIVE_REQUEST.with(|active| *active.borrow_mut() = Some(request_id.clone()));
    let result = stream_tauri_ai(request, callback.as_ref().unchecked_ref()).await;
    clear_active_request(&request_id);
    if let Err(error) = result {
        log_request_failure(
            "completion",
            &request_id,
            started_at,
            &js_error_message(&error),
        );
        return Err(error);
    }
    if *cancelled.borrow() {
        log_request_failure(
            "completion",
            &request_id,
            started_at,
            AI_GENERATION_CANCELLED,
        );
        return Err(JsValue::from_str(AI_GENERATION_CANCELLED));
    }
    if let Some(message) = event_error.borrow_mut().take() {
        log_request_failure("completion", &request_id, started_at, &message);
        return Err(JsValue::from_str(&message));
    }
    let text = output.borrow().clone();
    if text.trim().is_empty() {
        log_request_failure(
            "completion",
            &request_id,
            started_at,
            "AIから空の応答が返されました。",
        );
        return Err(JsValue::from_str("AIから空の応答が返されました。"));
    }
    let finish_reason = finish_reason.borrow().clone();
    log_request_end(
        "completion",
        &request_id,
        started_at,
        text.chars().count(),
        0,
        finish_reason.as_deref(),
    );
    Ok(GeneratedText {
        text,
        provider,
        model,
        finish_reason,
    })
}

/// `generate_with` と同じだが、テキストデルタをリアルタイムでコールバックする。
/// エディタへのストリーミング表示に使用する。
pub async fn generate_streaming<F>(
    role: &str,
    system: String,
    prompt: String,
    provider_override: Option<&str>,
    model_override: Option<&str>,
    mut on_chunk: F,
) -> Result<GeneratedText, JsValue>
where
    F: FnMut(&str),
{
    log_ai_info(&format!(
        "config:resolve kind=streaming role={role} providerOverride={} modelOverride={}",
        provider_override.unwrap_or("<default>"),
        model_override.unwrap_or("<default>"),
    ));
    let config: RuntimeConfig = match invoke::invoke(
        "ai_runtime_config",
        &ConfigArgs {
            role,
            provider_override,
            model_override,
        },
    )
    .await
    {
        Ok(config) => config,
        Err(error) => {
            log_ai_error(&format!(
                "config:error kind=streaming role={role} message={}",
                js_error_message(&error)
            ));
            return Err(error);
        }
    };
    let provider = config.provider.clone();
    let model = config.model.clone();
    let request_id = format!("ai_{}", tauri::random_uuid().replace('-', ""));
    let started_at = Date::now();
    log_request_start("streaming", &request_id, role, &provider, &model, 0, 0);
    let request = Request {
        request_id: request_id.clone(),
        provider: config.provider,
        api_type: config.api_type,
        api_key: config.api_key,
        base_url: config.base_url,
        model: config.model,
        system,
        messages: Vec::new(),
        tools: Vec::new(),
        search_priority: Vec::new(),
        prompt,
        // generate_with と同じ: 出力上限はモデルが定める上限のみを使う。
        max_output_tokens: config.max_output_tokens,
        temperature: config.temperature,
        top_p: config.top_p,
        top_k: config.top_k,
        frequency_penalty: config.frequency_penalty,
        presence_penalty: config.presence_penalty,
        reasoning_effort: config.reasoning_effort,
        thinking_enabled: config.thinking_enabled,
        thinking_budget: config.thinking_budget,
        anthropic_thinking_effort: config.anthropic_thinking_effort,
        thinking_level: config.thinking_level,
        tool_choice: None,
    };
    let request = serde_wasm_bindgen::to_value(&request)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;

    let output = Rc::new(RefCell::new(String::new()));
    let event_error = Rc::new(RefCell::new(None::<String>));
    let cancelled = Rc::new(RefCell::new(false));
    let finish_reason = Rc::new(RefCell::new(None::<String>));
    let on_chunk_rc = Rc::new(RefCell::new(&mut on_chunk));
    let callback_output = Rc::clone(&output);
    let callback_error = Rc::clone(&event_error);
    let callback_cancelled = Rc::clone(&cancelled);
    let callback_finish = Rc::clone(&finish_reason);
    let callback_chunk = Rc::clone(&on_chunk_rc);
    let callback_request_id = request_id.clone();
    let callback_role = role.to_owned();
    let callback_provider = provider.clone();
    let callback_model = model.clone();
    let callback = Closure::wrap(Box::new(move |event: JsValue| {
        let Ok(value) = serde_wasm_bindgen::from_value::<serde_json::Value>(event) else {
            log_ai_warn(&format!(
                "event:decode_error kind=streaming request={callback_request_id}"
            ));
            return;
        };
        match value.get("type").and_then(|kind| kind.as_str()) {
            Some("text_delta") => {
                if let Some(delta) = value.get("delta").and_then(|item| item.as_str()) {
                    callback_output.borrow_mut().push_str(delta);
                    (callback_chunk.borrow_mut())(delta);
                }
            }
            Some("error") => {
                let message = value
                    .get("message")
                    .and_then(|item| item.as_str())
                    .unwrap_or("AIストリームから不明なエラーが返されました")
                    .to_owned();
                log_ai_error(&format!(
                    "event:error kind=streaming request={} role={} provider={} model={} message={message}",
                    callback_request_id, callback_role, callback_provider, callback_model
                ));
                *callback_error.borrow_mut() = Some(message);
            }
            Some("cancelled") => {
                log_ai_warn(&format!(
                    "event:cancelled kind=streaming request={callback_request_id}"
                ));
                *callback_cancelled.borrow_mut() = true;
            }
            Some("finished") => {
                if let Some(reason) = value.get("finish_reason").and_then(|item| item.as_str()) {
                    log_ai_info(&format!(
                        "event:finished kind=streaming request={} finishReason={reason}",
                        callback_request_id
                    ));
                    *callback_finish.borrow_mut() = Some(reason.to_owned());
                }
            }
            _ => {}
        }
    }) as Box<dyn FnMut(JsValue)>);
    ACTIVE_REQUEST.with(|active| *active.borrow_mut() = Some(request_id.clone()));
    let result = stream_tauri_ai(request, callback.as_ref().unchecked_ref()).await;
    clear_active_request(&request_id);
    if let Err(error) = result {
        log_request_failure(
            "streaming",
            &request_id,
            started_at,
            &js_error_message(&error),
        );
        return Err(error);
    }
    if *cancelled.borrow() {
        log_request_failure(
            "streaming",
            &request_id,
            started_at,
            AI_GENERATION_CANCELLED,
        );
        return Err(JsValue::from_str(AI_GENERATION_CANCELLED));
    }
    if let Some(message) = event_error.borrow_mut().take() {
        log_request_failure("streaming", &request_id, started_at, &message);
        return Err(JsValue::from_str(&message));
    }
    let text = output.borrow().clone();
    if text.trim().is_empty() {
        log_request_failure(
            "streaming",
            &request_id,
            started_at,
            "AIから空の応答が返されました。",
        );
        return Err(JsValue::from_str("AIから空の応答が返されました。"));
    }
    let finish_reason = finish_reason.borrow().clone();
    log_request_end(
        "streaming",
        &request_id,
        started_at,
        text.chars().count(),
        0,
        finish_reason.as_deref(),
    );
    Ok(GeneratedText {
        text,
        provider,
        model,
        finish_reason,
    })
}

pub async fn agent_turn(
    role: &str,
    system: String,
    messages: Vec<serde_json::Value>,
    tools: Vec<serde_json::Value>,
    provider_override: Option<&str>,
    model_override: Option<&str>,
) -> Result<AgentTurn, JsValue> {
    let tool_choice = if tools.iter().any(|tool| {
        tool.get("name").and_then(serde_json::Value::as_str) == Some("submit_structured_output")
    }) {
        forced_tool_choice(role, provider_override, model_override).await?
    } else {
        None
    };
    agent_turn_observed(
        role,
        system,
        messages,
        tools,
        provider_override,
        model_override,
        Vec::new(),
        tool_choice,
        |_| {},
    )
    .await
}

pub async fn agent_turn_observed<F>(
    role: &str,
    system: String,
    messages: Vec<serde_json::Value>,
    tools: Vec<serde_json::Value>,
    provider_override: Option<&str>,
    model_override: Option<&str>,
    search_priority: Vec<String>,
    tool_choice: Option<String>,
    on_update: F,
) -> Result<AgentTurn, JsValue>
where
    F: FnMut(AgentStreamUpdate) + 'static,
{
    log_ai_info(&format!(
        "config:resolve kind=agent role={role} providerOverride={} modelOverride={}",
        provider_override.unwrap_or("<default>"),
        model_override.unwrap_or("<default>"),
    ));
    let config: RuntimeConfig = match invoke::invoke(
        "ai_runtime_config",
        &ConfigArgs {
            role,
            provider_override,
            model_override,
        },
    )
    .await
    {
        Ok(config) => config,
        Err(error) => {
            log_ai_error(&format!(
                "config:error kind=agent role={role} message={}",
                js_error_message(&error)
            ));
            return Err(error);
        }
    };
    let provider = config.provider.clone();
    let model = config.model.clone();
    let request_id = format!("ai_{}", tauri::random_uuid().replace('-', ""));
    let started_at = Date::now();
    log_request_start(
        "agent",
        &request_id,
        role,
        &provider,
        &model,
        messages.len(),
        tools.len(),
    );
    let request = Request {
        request_id: request_id.clone(),
        provider: config.provider,
        api_type: config.api_type,
        api_key: config.api_key,
        base_url: config.base_url,
        model: config.model,
        system,
        messages,
        tools,
        search_priority,
        prompt: String::new(),
        // チャット/ツール実行は TS の streamChat と同様に設定値を尊重する。
        max_output_tokens: config.max_output_tokens,
        temperature: config.temperature,
        top_p: config.top_p,
        top_k: config.top_k,
        frequency_penalty: config.frequency_penalty,
        presence_penalty: config.presence_penalty,
        reasoning_effort: config.reasoning_effort,
        thinking_enabled: config.thinking_enabled,
        thinking_budget: config.thinking_budget,
        anthropic_thinking_effort: config.anthropic_thinking_effort,
        thinking_level: config.thinking_level,
        tool_choice,
    };
    let request = serde_wasm_bindgen::to_value(&request)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let output = Rc::new(RefCell::new(String::new()));
    let calls = Rc::new(RefCell::new(Vec::<ToolCall>::new()));
    let reasoning_text = Rc::new(RefCell::new(String::new()));
    let reasoning_item = Rc::new(RefCell::new(None::<serde_json::Value>));
    let responses_tool_items = Rc::new(RefCell::new(Vec::<serde_json::Value>::new()));
    let anthropic_tool_context = Rc::new(RefCell::new(Vec::<serde_json::Value>::new()));
    let anthropic_thinking = Rc::new(RefCell::new(Vec::<serde_json::Value>::new()));
    let google_tool_context = Rc::new(RefCell::new(Vec::<serde_json::Value>::new()));
    let event_error = Rc::new(RefCell::new(None::<String>));
    let cancelled = Rc::new(RefCell::new(false));
    let finish_reason = Rc::new(RefCell::new(None::<String>));
    let callback_output = Rc::clone(&output);
    let callback_calls = Rc::clone(&calls);
    let callback_reasoning_text = Rc::clone(&reasoning_text);
    let callback_reasoning = Rc::clone(&reasoning_item);
    let callback_responses_tools = Rc::clone(&responses_tool_items);
    let callback_anthropic_context = Rc::clone(&anthropic_tool_context);
    let callback_anthropic_thinking = Rc::clone(&anthropic_thinking);
    let callback_google_context = Rc::clone(&google_tool_context);
    let callback_error = Rc::clone(&event_error);
    let callback_cancelled = Rc::clone(&cancelled);
    let callback_finish = Rc::clone(&finish_reason);
    let on_update = Rc::new(RefCell::new(on_update));
    let callback_update = Rc::clone(&on_update);
    let callback_request_id = request_id.clone();
    let callback_role = role.to_owned();
    let callback_provider = provider.clone();
    let callback_model = model.clone();
    let callback = Closure::wrap(Box::new(move |event: JsValue| {
        let Ok(value) = serde_wasm_bindgen::from_value::<serde_json::Value>(event) else {
            log_ai_warn(&format!(
                "event:decode_error kind=agent request={callback_request_id}"
            ));
            return;
        };
        match value.get("type").and_then(|kind| kind.as_str()) {
            Some("text_delta") => {
                if let Some(delta) = value.get("delta").and_then(|item| item.as_str()) {
                    callback_output.borrow_mut().push_str(delta);
                    callback_update.borrow_mut()(AgentStreamUpdate::TextDelta(delta.to_owned()));
                }
            }
            Some("reasoning_delta") => {
                if let Some(delta) = value.get("delta").and_then(|item| item.as_str()) {
                    callback_reasoning_text.borrow_mut().push_str(delta);
                    callback_update.borrow_mut()(AgentStreamUpdate::ReasoningDelta(
                        delta.to_owned(),
                    ));
                }
            }
            Some("tool_call") => {
                if let (Some(id), Some(name), Some(input)) = (
                    value
                        .get("tool_call_id")
                        .and_then(|item| item.as_str())
                        .map(str::to_owned),
                    value
                        .get("tool_name")
                        .and_then(|item| item.as_str())
                        .map(str::to_owned),
                    value.get("input").cloned(),
                ) {
                    log_ai_info(&format!(
                        "event:tool_call kind=agent request={} tool={} toolCallId={id}",
                        callback_request_id, name
                    ));
                    callback_calls
                        .borrow_mut()
                        .push(ToolCall { id, name, input });
                }
            }
            Some("responses_reasoning") => {
                if let Some(item) = value.get("item").cloned() {
                    *callback_reasoning.borrow_mut() = Some(item);
                }
            }
            Some("responses_tool_context") => {
                if let Some(item) = value.get("item").cloned() {
                    log_ai_info(&format!(
                        "event:native_tool kind=agent request={} protocol=openai-responses phase=completed",
                        callback_request_id
                    ));
                    callback_responses_tools.borrow_mut().push(item);
                }
            }
            Some("anthropic_tool_context") => {
                if let Some(block) = value.get("block").cloned() {
                    log_ai_info(&format!(
                        "event:native_tool kind=agent request={} protocol=anthropic phase=completed",
                        callback_request_id
                    ));
                    callback_anthropic_context.borrow_mut().push(block);
                }
            }
            Some("anthropic_thinking") => {
                if let Some(block) = value.get("block").cloned() {
                    callback_anthropic_thinking.borrow_mut().push(block);
                }
            }
            Some("google_tool_context") => {
                if let Some(part) = value.get("part").cloned() {
                    log_ai_info(&format!(
                        "event:native_tool kind=agent request={} protocol=google phase=completed",
                        callback_request_id
                    ));
                    callback_google_context.borrow_mut().push(part);
                }
            }
            Some("error") => {
                let message = value
                    .get("message")
                    .and_then(|item| item.as_str())
                    .unwrap_or("AIストリームから不明なエラーが返されました")
                    .to_owned();
                log_ai_error(&format!(
                    "event:error kind=agent request={} role={} provider={} model={} message={message}",
                    callback_request_id, callback_role, callback_provider, callback_model
                ));
                *callback_error.borrow_mut() = Some(message);
            }
            Some("cancelled") => {
                log_ai_warn(&format!(
                    "event:cancelled kind=agent request={callback_request_id}"
                ));
                *callback_cancelled.borrow_mut() = true;
            }
            Some("finished") => {
                if let Some(reason) = value.get("finish_reason").and_then(|item| item.as_str()) {
                    log_ai_info(&format!(
                        "event:finished kind=agent request={} finishReason={reason}",
                        callback_request_id
                    ));
                    *callback_finish.borrow_mut() = Some(reason.to_owned());
                }
            }
            _ => {}
        }
    }) as Box<dyn FnMut(JsValue)>);
    ACTIVE_REQUEST.with(|active| *active.borrow_mut() = Some(request_id.clone()));
    let result = stream_tauri_ai(request, callback.as_ref().unchecked_ref()).await;
    clear_active_request(&request_id);
    if let Err(error) = result {
        log_request_failure("agent", &request_id, started_at, &js_error_message(&error));
        return Err(error);
    }
    if *cancelled.borrow() {
        log_request_failure("agent", &request_id, started_at, AI_GENERATION_CANCELLED);
        return Err(JsValue::from_str(AI_GENERATION_CANCELLED));
    }
    if let Some(message) = event_error.borrow_mut().take() {
        log_request_failure("agent", &request_id, started_at, &message);
        return Err(JsValue::from_str(&message));
    }
    let text = output.borrow().clone();
    let tool_calls = calls.borrow().clone();
    let reasoning = reasoning_text.borrow().clone();
    let responses_reasoning = reasoning_item.borrow().clone();
    let responses_tool_items = responses_tool_items.borrow().clone();
    let anthropic_tool_context = anthropic_tool_context.borrow().clone();
    let anthropic_thinking = anthropic_thinking.borrow().clone();
    let google_tool_context = google_tool_context.borrow().clone();
    let finish_reason = finish_reason.borrow().clone();
    log_request_end(
        "agent",
        &request_id,
        started_at,
        text.chars().count(),
        tool_calls.len(),
        finish_reason.as_deref(),
    );
    Ok(AgentTurn {
        text,
        tool_calls,
        reasoning,
        responses_reasoning,
        responses_tool_items,
        anthropic_tool_context,
        anthropic_thinking,
        google_tool_context,
        provider,
        model,
        thinking_enabled: config.thinking_enabled,
        finish_reason,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CancelArgs {
    request_id: String,
}

pub fn cancel_active() {
    let request_id = ACTIVE_REQUEST.with(|active| active.borrow().clone());
    if let Some(request_id) = request_id {
        wasm_bindgen_futures::spawn_local(async move {
            let _ = invoke::invoke::<_, ()>("ai_cancel", &CancelArgs { request_id }).await;
        });
    }
}
