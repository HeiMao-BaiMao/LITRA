use serde_json::Value;
use tauri::ipc::Channel;

use super::{send, StreamState};
use crate::ai::types::AiStreamEvent;

pub fn parse(
    event_name: Option<&str>,
    value: &Value,
    channel: &Channel<AiStreamEvent>,
    state: &mut StreamState,
) -> Result<(), String> {
    match event_name.or_else(|| value.get("type").and_then(Value::as_str)) {
        Some("content_block_start")
            if value.pointer("/content_block/type").and_then(Value::as_str) == Some("tool_use") =>
        {
            let key = value
                .get("index")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .to_string();
            let id = value
                .pointer("/content_block/id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let name = value
                .pointer("/content_block/name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            state.start(key.clone(), id.into(), name.into());
            if let Some(input) = value
                .pointer("/content_block/input")
                .filter(|input| input.as_object().is_some_and(|object| !object.is_empty()))
            {
                state.append(&key, &input.to_string());
            }
            send(
                channel,
                AiStreamEvent::ToolInputStart {
                    tool_call_id: id.into(),
                    tool_name: name.into(),
                },
            )?;
        }
        Some("content_block_delta") => {
            let kind = value.pointer("/delta/type").and_then(Value::as_str);
            if kind == Some("input_json_delta") {
                let key = value
                    .get("index")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    .to_string();
                let delta = value
                    .pointer("/delta/partial_json")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                state.append(&key, delta);
                if let Some((id, _)) = state.identity(&key) {
                    send(
                        channel,
                        AiStreamEvent::ToolInputDelta {
                            tool_call_id: id.into(),
                            delta: delta.into(),
                        },
                    )?;
                }
                return Ok(());
            }
            let delta = value
                .pointer("/delta/text")
                .or_else(|| value.pointer("/delta/thinking"))
                .and_then(Value::as_str);
            if let Some(delta) = delta.filter(|delta| !delta.is_empty()) {
                let event = if kind == Some("thinking_delta") {
                    AiStreamEvent::ReasoningDelta {
                        delta: delta.into(),
                    }
                } else {
                    AiStreamEvent::TextDelta {
                        delta: delta.into(),
                    }
                };
                send(channel, event)?;
            }
        }
        Some("content_block_stop") => {
            let key = value
                .get("index")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .to_string();
            if let Some(call) = state.finish(&key, None) {
                send(
                    channel,
                    AiStreamEvent::ToolCall {
                        tool_call_id: call.id,
                        tool_name: call.name,
                        input: call.input,
                    },
                )?;
            }
        }
        Some("message_start") => {
            if let Some(usage) = value.pointer("/message/usage") {
                emit_usage(usage, channel)?;
            }
        }
        Some("message_delta") => {
            if let Some(usage) = value.get("usage") {
                emit_usage(usage, channel)?;
            }
            let reason = value
                .pointer("/delta/stop_reason")
                .and_then(Value::as_str)
                .map(str::to_string);
            if reason.is_some() {
                send(
                    channel,
                    AiStreamEvent::Finished {
                        finish_reason: reason,
                    },
                )?;
            }
        }
        Some("error") => {
            let message = value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("Anthropic Messages API error")
                .to_string();
            send(
                channel,
                AiStreamEvent::Error {
                    message,
                    status: None,
                },
            )?;
        }
        _ => {}
    }
    Ok(())
}

fn emit_usage(usage: &Value, channel: &Channel<AiStreamEvent>) -> Result<(), String> {
    send(
        channel,
        AiStreamEvent::Usage {
            input_tokens: usage.get("input_tokens").and_then(Value::as_u64),
            output_tokens: usage.get("output_tokens").and_then(Value::as_u64),
            cached_input_tokens: usage.get("cache_read_input_tokens").and_then(Value::as_u64),
        },
    )
}
