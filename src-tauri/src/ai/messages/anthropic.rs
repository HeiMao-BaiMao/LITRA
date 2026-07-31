use serde_json::{json, Value};

use super::tool_result_value;
use crate::ai::types::AiInputMessage;

pub fn convert(messages: &[AiInputMessage]) -> Vec<Value> {
    let mut output = Vec::new();
    for message in messages {
        let role = if message.role == "tool" {
            "user"
        } else {
            message.role.as_str()
        };
        if !matches!(role, "user" | "assistant") {
            continue;
        }
        let content = convert_content(&message.content);
        if !content.is_empty() {
            output.push(json!({ "role": role, "content": content }));
        }
    }
    output
}

fn convert_content(value: &Value) -> Vec<Value> {
    match value {
        Value::String(text) => vec![json!({ "type": "text", "text": text })],
        Value::Array(parts) => parts.iter().filter_map(convert_part).collect(),
        _ => Vec::new(),
    }
}

fn convert_part(part: &Value) -> Option<Value> {
    match part.get("type").and_then(Value::as_str) {
        Some("text") => part
            .get("text")
            .and_then(Value::as_str)
            .map(|text| json!({ "type": "text", "text": text })),
        Some("anthropic-thinking-block") | Some("anthropic-server-block") => {
            part.get("block").cloned()
        }
        Some("tool-call") => Some(json!({
            "type": "tool_use",
            "id": part.get("toolCallId"),
            "name": part.get("toolName"),
            "input": part.get("input").cloned().unwrap_or_else(|| json!({})),
        })),
        Some("tool-result") => Some(json!({
            "type": "tool_result",
            "tool_use_id": part.get("toolCallId"),
            "content": tool_result_value(part),
        })),
        _ => None,
    }
}
