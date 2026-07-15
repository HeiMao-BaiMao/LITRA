use serde_json::Value;
use tauri::ipc::Channel;

use super::{send, StreamState};
use crate::ai::types::AiStreamEvent;

pub fn parse(
    value: &Value,
    channel: &Channel<AiStreamEvent>,
    state: &mut StreamState,
) -> Result<(), String> {
    if let Some(parts) = value
        .pointer("/candidates/0/content/parts")
        .and_then(Value::as_array)
    {
        for part in parts {
            if let Some(function_call) = part.get("functionCall") {
                let name = function_call
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let id = function_call
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| state.generated_id("google-tool"));
                send(
                    channel,
                    AiStreamEvent::ToolInputStart {
                        tool_call_id: id.clone(),
                        tool_name: name.into(),
                    },
                )?;
                send(
                    channel,
                    AiStreamEvent::ToolCall {
                        tool_call_id: id,
                        tool_name: name.into(),
                        input: function_call
                            .get("args")
                            .cloned()
                            .unwrap_or(Value::Object(Default::default())),
                    },
                )?;
            }
            if let Some(text) = part
                .get("text")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                let event = if part.get("thought").and_then(Value::as_bool) == Some(true) {
                    AiStreamEvent::ReasoningDelta { delta: text.into() }
                } else {
                    AiStreamEvent::TextDelta { delta: text.into() }
                };
                send(channel, event)?;
            }
        }
    }
    if let Some(usage) = value.get("usageMetadata") {
        send(
            channel,
            AiStreamEvent::Usage {
                input_tokens: usage.get("promptTokenCount").and_then(Value::as_u64),
                output_tokens: usage.get("candidatesTokenCount").and_then(Value::as_u64),
                cached_input_tokens: usage.get("cachedContentTokenCount").and_then(Value::as_u64),
            },
        )?;
    }
    if let Some(reason) = value
        .pointer("/candidates/0/finishReason")
        .and_then(Value::as_str)
    {
        send(
            channel,
            AiStreamEvent::Finished {
                finish_reason: Some(reason.into()),
            },
        )?;
    }
    Ok(())
}
