use serde_json::{json, Value};

use super::{text_parts, tool_parts, tool_result_value};
use crate::ai::types::AiInputMessage;

pub fn convert(messages: &[AiInputMessage]) -> Vec<Value> {
    let mut output = Vec::new();
    for message in messages {
        if message.role == "system" {
            continue;
        }
        let role = if message.role == "assistant" {
            "model"
        } else {
            "user"
        };
        let mut parts = text_parts(&message.content)
            .into_iter()
            .map(|text| json!({ "text": text }))
            .collect::<Vec<_>>();
        for part in tool_parts(&message.content, "google-server-part") {
            if let Some(server_part) = part.get("part") {
                parts.push(server_part.clone());
            }
        }
        let has_raw_function_call = tool_parts(&message.content, "google-server-part")
            .filter_map(|part| part.get("part"))
            .any(|part| part.get("functionCall").is_some());
        if !has_raw_function_call {
            for part in tool_parts(&message.content, "tool-call") {
                parts.push(json!({
                    "functionCall": {
                        "id": part.get("toolCallId"),
                        "name": part.get("toolName"),
                        "args": part.get("input").cloned().unwrap_or_else(|| json!({})),
                    },
                }));
            }
        }
        for part in tool_parts(&message.content, "tool-result") {
            parts.push(json!({
                "functionResponse": {
                    "id": part.get("toolCallId"),
                    "name": part.get("toolName"),
                    "response": tool_result_value(part),
                },
            }));
        }
        if !parts.is_empty() {
            output.push(json!({ "role": role, "parts": parts }));
        }
    }
    output
}
