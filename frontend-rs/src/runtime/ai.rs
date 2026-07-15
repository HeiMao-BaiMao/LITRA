use std::{cell::RefCell, rc::Rc};

use js_sys::Function;
use serde::{Deserialize, Serialize};
use wasm_bindgen::{closure::Closure, prelude::*, JsCast};

use super::{invoke, tauri};

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
}

#[derive(Serialize)]
struct ConfigArgs<'a> {
    role: &'a str,
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
}

pub struct GeneratedText {
    pub text: String,
    pub provider: String,
    pub model: String,
}

pub async fn generate(
    role: &str,
    system: String,
    prompt: String,
) -> Result<GeneratedText, JsValue> {
    let config: RuntimeConfig = invoke::invoke("ai_runtime_config", &ConfigArgs { role }).await?;
    let provider = config.provider.clone();
    let model = config.model.clone();
    let request = Request {
        request_id: format!("ai_{}", tauri::random_uuid().replace('-', "")),
        provider: config.provider,
        api_type: config.api_type,
        api_key: config.api_key,
        base_url: config.base_url,
        model: config.model,
        system,
        messages: Vec::new(),
        tools: Vec::new(),
        prompt,
        max_output_tokens: config.max_output_tokens.min(16384),
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
    };
    let request = serde_wasm_bindgen::to_value(&request)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let output = Rc::new(RefCell::new(String::new()));
    let event_error = Rc::new(RefCell::new(None::<String>));
    let callback_output = Rc::clone(&output);
    let callback_error = Rc::clone(&event_error);
    let callback = Closure::wrap(Box::new(move |event: JsValue| {
        let Ok(value) = serde_wasm_bindgen::from_value::<serde_json::Value>(event) else {
            return;
        };
        match value.get("type").and_then(|kind| kind.as_str()) {
            Some("text_delta") => {
                if let Some(delta) = value.get("delta").and_then(|item| item.as_str()) {
                    callback_output.borrow_mut().push_str(delta);
                }
            }
            Some("error") => {
                *callback_error.borrow_mut() = value
                    .get("message")
                    .and_then(|item| item.as_str())
                    .map(str::to_owned)
            }
            _ => {}
        }
    }) as Box<dyn FnMut(JsValue)>);
    stream_tauri_ai(request, callback.as_ref().unchecked_ref()).await?;
    if let Some(message) = event_error.borrow_mut().take() {
        return Err(JsValue::from_str(&message));
    }
    let text = output.borrow().clone();
    if text.trim().is_empty() {
        return Err(JsValue::from_str("AIから空の応答が返されました。"));
    }
    Ok(GeneratedText {
        text,
        provider,
        model,
    })
}
