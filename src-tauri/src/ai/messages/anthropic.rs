use serde_json::{json, Value};

use super::{text_parts, tool_parts, tool_result_value};
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
        let mut content = text_parts(&message.content)
            .into_iter()
            .map(|text| json!({ "type": "text", "text": text }))
            .collect::<Vec<_>>();
        for part in tool_parts(&message.content, "tool-call") {
            content.push(json!({
                "type": "tool_use",
                "id": part.get("toolCallId"),
                "name": part.get("toolName"),
                "input": part.get("input").cloned().unwrap_or_else(|| json!({})),
            }));
        }
        for part in tool_parts(&message.content, "tool-result") {
            content.push(json!({
                "type": "tool_result",
                "tool_use_id": part.get("toolCallId"),
                "content": tool_result_value(part),
            }));
        }
        if !content.is_empty() {
            output.push(json!({ "role": role, "content": content }));
        }
    }
    output
}
