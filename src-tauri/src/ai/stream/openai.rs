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
        Some("response.output_item.done")
            if value.pointer("/item/type").and_then(Value::as_str) == Some("reasoning") =>
        {
            let Some(item) = value.get("item") else {
                return Ok(());
            };
            if item
                .get("encrypted_content")
                .and_then(Value::as_str)
                .is_some_and(|content| !content.is_empty())
            {
                send(
                    channel,
                    AiStreamEvent::ResponsesReasoning { item: item.clone() },
                )?;
            }
            Ok(())
        }
        Some("response.output_item.done")
            if value.pointer("/item/type").and_then(Value::as_str) == Some("web_search_call") =>
        {
            if let Some(item) = value.get("item") {
                send(
                    channel,
                    AiStreamEvent::ResponsesToolContext { item: item.clone() },
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
    if let Some(delta) = extract_chat_text_delta(value) {
        if !delta.is_empty() {
            send(
                channel,
                AiStreamEvent::TextDelta {
                    delta: delta.into(),
                },
            )?;
        }
    }
    if let Some(delta) = extract_chat_reasoning_delta(value) {
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

/// chat 補完ストリームの `choices[0].delta` から reasoning テキストを取り出す。
/// DeepSeek 系の `reasoning_content` に加え、エンドポイントが使う別名
/// (`deepseek_reasoning` / `reasoning`)と、オブジェクト形式
/// (`{"content": "…"}` など)も拾う。
/// このテキストは後続ターンの assistant メッセージへ `reasoning_content` として
/// リプレイされる(DeepSeek はツール呼び出し後の継続にリプレイを要求する)。
/// 捕捉漏れがあると、ツール結果後のターンが空応答になる。
fn extract_chat_reasoning_delta(value: &Value) -> Option<String> {
    let delta = value.pointer("/choices/0/delta")?;
    let reasoning = delta
        .get("reasoning_content")
        .or_else(|| delta.get("deepseek_reasoning"))
        .or_else(|| delta.get("reasoning"));
    match reasoning {
        Some(Value::String(text)) if !text.is_empty() => Some(text.clone()),
        Some(Value::Object(obj)) => {
            let text = obj
                .get("content")
                .or_else(|| obj.get("text"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            (!text.is_empty()).then(|| text.to_string())
        }
        _ => None,
    }
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

/// chat 補完ストリームの `choices[0].delta.content` からテキストを取り出す。
/// 文字列形式(`"…"`)と、一部の OpenAI 互換エンドポイントが使う
/// パーツ配列形式(`[{"type":"text","text":"…"}]`)の両方に対応する。
/// 配列形式を文字列専用のパースで読み落とすと、モデルが本文を出力しても
/// 空応答になるため、両対応が必須。
fn extract_chat_text_delta(value: &Value) -> Option<String> {
    let content = value.pointer("/choices/0/delta/content")?;
    match content {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Array(parts) => {
            let mut out = String::new();
            for part in parts {
                if part.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(text) = part.get("text").and_then(Value::as_str) {
                        out.push_str(text);
                    }
                }
            }
            (!out.is_empty()).then_some(out)
        }
        _ => None,
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extract_text_delta_handles_string_and_part_array() {
        assert_eq!(
            extract_chat_text_delta(&json!({
                "choices": [{"delta": {"content": "本文"}}]
            })),
            Some("本文".into())
        );
        // OpenAI 互換エンドポイントのパーツ配列形式。これを読み落とすと
        // モデルが本文を出しても空応答になる。
        assert_eq!(
            extract_chat_text_delta(&json!({
                "choices": [{"delta": {"content": [
                    {"type": "text", "text": "前"},
                    {"type": "text", "text": "後"}
                ]}}]
            })),
            Some("前後".into())
        );
        // 配列内にテキスト以外のパーツが混ざっていても無視する。
        assert_eq!(
            extract_chat_text_delta(&json!({
                "choices": [{"delta": {"content": [
                    {"type": "refusal", "text": "拒否"},
                    {"type": "text", "text": "本文"}
                ]}}]
            })),
            Some("本文".into())
        );
        assert_eq!(
            extract_chat_text_delta(&json!({"choices": [{"delta": {}}]})),
            None
        );
    }

    #[test]
    fn extract_reasoning_delta_handles_string_object_and_aliases() {
        // DeepSeek 標準の reasoning_content(文字列)
        assert_eq!(
            extract_chat_reasoning_delta(&json!({
                "choices": [{"delta": {"reasoning_content": "思考中"}}]
            })),
            Some("思考中".into())
        );
        // オブジェクト形式({content: "…"})
        assert_eq!(
            extract_chat_reasoning_delta(&json!({
                "choices": [{"delta": {"reasoning": {"content": "思考A", "effort": "high"}}}]
            })),
            Some("思考A".into())
        );
        // 別名 deepseek_reasoning
        assert_eq!(
            extract_chat_reasoning_delta(&json!({
                "choices": [{"delta": {"deepseek_reasoning": "思考B"}}]
            })),
            Some("思考B".into())
        );
        assert_eq!(
            extract_chat_reasoning_delta(&json!({"choices": [{"delta": {}}]})),
            None
        );
    }
}
