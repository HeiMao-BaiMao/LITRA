use serde_json::Value;
use tauri::ipc::Channel;

use super::{send, StreamState};
use crate::ai::types::AiStreamEvent;

pub fn parse_responses(
    event_name: Option<&str>,
    value: &Value,
    channel: &Channel<AiStreamEvent>,
    state: &mut StreamState,
) -> Result<(), String> {
    let kind = event_name.or_else(|| value.get("type").and_then(Value::as_str));
    match kind {
        Some("response.output_text.delta") => emit_delta(value, false, channel),
        Some("response.reasoning_summary_text.delta") => emit_delta(value, true, channel),
        Some("response.output_item.added")
            if value.pointer("/item/type").and_then(Value::as_str) == Some("function_call") =>
        {
            let key = value
                .pointer("/item/id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let id = value
                .pointer("/item/call_id")
                .and_then(Value::as_str)
                .unwrap_or(key);
            let name = value
                .pointer("/item/name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if state.start(key.into(), id.into(), name.into()) {
                send(
                    channel,
                    AiStreamEvent::ToolInputStart {
                        tool_call_id: id.into(),
                        tool_name: name.into(),
                    },
                )?;
            }
            Ok(())
        }
        Some("response.function_call_arguments.delta") => {
            let key = value
                .get("item_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let delta = value
                .get("delta")
                .and_then(Value::as_str)
                .unwrap_or_default();
            state.append(key, delta);
            if let Some((id, _)) = state.identity(key) {
                send(
                    channel,
                    AiStreamEvent::ToolInputDelta {
                        tool_call_id: id.into(),
                        delta: delta.into(),
                    },
                )?;
            }
            Ok(())
        }
        Some("response.function_call_arguments.done") => {
            let key = value
                .get("item_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let name = value
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let id = value.get("call_id").and_then(Value::as_str).unwrap_or(key);
            state.start(key.into(), id.into(), name.into());
            emit_tool_call(
                state.finish(key, value.get("arguments").and_then(Value::as_str)),
                channel,
            )
        }
        Some("response.completed") | Some("response.incomplete") => {
            if let Some(usage) = value.pointer("/response/usage") {
                emit_usage(usage, channel)?;
            }
            let reason = value
                .pointer("/response/incomplete_details/reason")
                .and_then(Value::as_str)
                .map(str::to_string);
            send(
                channel,
                AiStreamEvent::Finished {
                    finish_reason: reason,
                },
            )
        }
        Some("response.failed") | Some("error") => {
            let message = value
                .pointer("/response/error/message")
                .or_else(|| value.pointer("/error/message"))
                .and_then(Value::as_str)
                .unwrap_or("OpenAI Responses API error")
                .to_string();
            send(
                channel,
                AiStreamEvent::Error {
                    message,
                    status: None,
                },
            )
        }
        _ => Ok(()),
    }
}

pub fn parse_chat(
    value: &Value,
    channel: &Channel<AiStreamEvent>,
    state: &mut StreamState,
) -> Result<(), String> {
    if let Some(delta) = value
        .pointer("/choices/0/delta/content")
        .and_then(Value::as_str)
    {
        if !delta.is_empty() {
            send(
                channel,
                AiStreamEvent::TextDelta {
                    delta: delta.into(),
                },
            )?;
        }
    }
    if let Some(delta) = value
        .pointer("/choices/0/delta/reasoning_content")
        .or_else(|| value.pointer("/choices/0/delta/reasoning"))
        .and_then(Value::as_str)
    {
        if !delta.is_empty() {
            send(
                channel,
                AiStreamEvent::ReasoningDelta {
                    delta: delta.into(),
                },
            )?;
        }
    }
    if let Some(usage) = value.get("usage") {
        emit_usage(usage, channel)?;
    }
    if let Some(tool_calls) = value
        .pointer("/choices/0/delta/tool_calls")
        .and_then(Value::as_array)
    {
        for tool_call in tool_calls {
            let key = tool_call
                .get("index")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .to_string();
            let id = tool_call
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let name = tool_call
                .pointer("/function/name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if state.start(key.clone(), id.into(), name.into()) && !id.is_empty() {
                send(
                    channel,
                    AiStreamEvent::ToolInputStart {
                        tool_call_id: id.into(),
                        tool_name: name.into(),
                    },
                )?;
            }
            if let Some(delta) = tool_call
                .pointer("/function/arguments")
                .and_then(Value::as_str)
            {
                state.append(&key, delta);
                if let Some((call_id, _)) = state.identity(&key) {
                    send(
                        channel,
                        AiStreamEvent::ToolInputDelta {
                            tool_call_id: call_id.into(),
                            delta: delta.into(),
                        },
                    )?;
                }
            }
        }
    }
    if let Some(reason) = value
        .pointer("/choices/0/finish_reason")
        .and_then(Value::as_str)
    {
        if reason == "tool_calls" {
            for call in state.finish_all() {
                emit_tool_call(Some(call), channel)?;
            }
        }
        send(
            channel,
            AiStreamEvent::Finished {
                finish_reason: Some(reason.into()),
            },
        )?;
    }
    Ok(())
}

fn emit_tool_call(
    call: Option<super::state::CompletedToolCall>,
    channel: &Channel<AiStreamEvent>,
) -> Result<(), String> {
    let Some(call) = call else {
        return Ok(());
    };
    send(
        channel,
        AiStreamEvent::ToolCall {
            tool_call_id: call.id,
            tool_name: call.name,
            input: call.input,
        },
    )
}

fn emit_delta(
    value: &Value,
    reasoning: bool,
    channel: &Channel<AiStreamEvent>,
) -> Result<(), String> {
    let Some(delta) = value
        .get("delta")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return Ok(());
    };
    let event = if reasoning {
        AiStreamEvent::ReasoningDelta {
            delta: delta.into(),
        }
    } else {
        AiStreamEvent::TextDelta {
            delta: delta.into(),
        }
    };
    send(channel, event)
}

fn emit_usage(usage: &Value, channel: &Channel<AiStreamEvent>) -> Result<(), String> {
    send(
        channel,
        AiStreamEvent::Usage {
            input_tokens: u64_field(usage, "input_tokens")
                .or_else(|| u64_field(usage, "prompt_tokens")),
            output_tokens: u64_field(usage, "output_tokens")
                .or_else(|| u64_field(usage, "completion_tokens")),
            cached_input_tokens: usage
                .pointer("/input_tokens_details/cached_tokens")
                .or_else(|| usage.pointer("/prompt_tokens_details/cached_tokens"))
                .and_then(Value::as_u64),
        },
    )
}

fn u64_field(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(Value::as_u64)
}
