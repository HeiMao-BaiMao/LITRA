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
        Some("content_block_start") => {
            let key = value
                .get("index")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .to_string();
            let content_block = value.get("content_block").cloned().unwrap_or(Value::Null);
            let block_type = content_block.get("type").and_then(Value::as_str);
            if block_type == Some("thinking") {
                state.start_thinking(key, &content_block);
                return Ok(());
            }
            if matches!(
                block_type,
                Some("server_tool_use" | "web_search_tool_result")
            ) {
                state.start_server_block(key, content_block);
                return Ok(());
            }
            if block_type != Some("tool_use") {
                return Ok(());
            }
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
            let key = value
                .get("index")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .to_string();
            if kind == Some("thinking_delta") {
                let delta = value
                    .pointer("/delta/thinking")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                state.append_thinking(&key, delta);
                if !delta.is_empty() {
                    send(
                        channel,
                        AiStreamEvent::ReasoningDelta {
                            delta: delta.into(),
                        },
                    )?;
                }
                return Ok(());
            }
            if kind == Some("signature_delta") {
                if let Some(signature) = value.pointer("/delta/signature").and_then(Value::as_str) {
                    state.set_thinking_signature(&key, signature);
                }
                return Ok(());
            }
            if kind == Some("input_json_delta") {
                if state.is_server_block(&key) {
                    let delta = value
                        .pointer("/delta/partial_json")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    state.append_server_input(&key, delta);
                    return Ok(());
                }
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
            if let Some(block) = state.finish_thinking(&key) {
                send(channel, AiStreamEvent::AnthropicThinking { block })?;
                return Ok(());
            }
            if let Some(block) = state.finish_server_block(&key) {
                send(channel, AiStreamEvent::AnthropicToolContext { block })?;
                return Ok(());
            }
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
