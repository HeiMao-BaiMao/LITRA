use serde_json::{json, Value};

use super::{text_parts, tool_parts, tool_result_value, value_as_output};
use crate::ai::types::AiInputMessage;

pub fn responses(messages: &[AiInputMessage]) -> Vec<Value> {
    let mut output = Vec::new();
    for message in messages {
        let text = text_parts(&message.content).join("");
        if !text.is_empty() {
            output.push(json!({ "role": message.role, "content": text }));
        }
        for part in tool_parts(&message.content, "tool-call") {
            output.push(json!({
                "type": "function_call",
                "call_id": part.get("toolCallId"),
                "name": part.get("toolName"),
                "arguments": part.get("input").map(Value::to_string).unwrap_or_else(|| "{}".into()),
            }));
        }
        for part in tool_parts(&message.content, "tool-result") {
            output.push(json!({
                "type": "function_call_output",
                "call_id": part.get("toolCallId"),
                "output": value_as_output(&tool_result_value(part)),
            }));
        }
    }
    output
}

pub fn chat(messages: &[AiInputMessage]) -> Vec<Value> {
    let mut output = Vec::new();
    for message in messages {
        let tool_calls = tool_parts(&message.content, "tool-call")
            .map(|part| json!({
                "id": part.get("toolCallId"),
                "type": "function",
                "function": {
                    "name": part.get("toolName"),
                    "arguments": part.get("input").map(Value::to_string).unwrap_or_else(|| "{}".into()),
                },
            }))
            .collect::<Vec<_>>();
        let text = text_parts(&message.content).join("");
        if message.role == "tool" {
            for part in tool_parts(&message.content, "tool-result") {
                output.push(json!({
                    "role": "tool",
                    "tool_call_id": part.get("toolCallId"),
                    "content": value_as_output(&tool_result_value(part)),
                }));
            }
        } else if !text.is_empty() || !tool_calls.is_empty() {
            let mut value = json!({ "role": message.role, "content": text });
            if !tool_calls.is_empty() {
                value["tool_calls"] = Value::Array(tool_calls);
            }
            output.push(value);
        }
    }
    output
}
