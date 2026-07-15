mod anthropic;
mod google;
mod openai;

use serde_json::Value;

use super::types::AiInputMessage;

pub fn openai_responses(messages: &[AiInputMessage]) -> Vec<Value> {
    openai::responses(messages)
}

pub fn openai_chat(messages: &[AiInputMessage]) -> Vec<Value> {
    openai::chat(messages)
}

pub fn anthropic(messages: &[AiInputMessage]) -> Vec<Value> {
    anthropic::convert(messages)
}

pub fn google(messages: &[AiInputMessage]) -> Vec<Value> {
    google::convert(messages)
}

pub(super) fn text_parts(content: &Value) -> Vec<String> {
    match content {
        Value::String(text) => vec![text.clone()],
        Value::Array(parts) => parts
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str).map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}

pub(super) fn tool_parts<'a>(content: &'a Value, kind: &'a str) -> impl Iterator<Item = &'a Value> {
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter(move |part| part.get("type").and_then(Value::as_str) == Some(kind))
}

pub(super) fn tool_result_value(part: &Value) -> Value {
    part.get("output")
        .and_then(|output| output.get("value"))
        .cloned()
        .or_else(|| part.get("output").cloned())
        .unwrap_or(Value::Null)
}

pub(super) fn value_as_output(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string())
}
