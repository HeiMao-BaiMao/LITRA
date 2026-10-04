mod anthropic;
mod google;
mod openai;
mod state;

pub use state::StreamState;

use serde_json::Value;
use tauri::ipc::Channel;

use super::types::{AiStreamEvent, ProviderApiType};

pub fn take_events(buffer: &mut Vec<u8>) -> Vec<String> {
    let mut events = Vec::new();
    while let Some((index, delimiter_len)) = find_delimiter(buffer) {
        let bytes = buffer.drain(..index).collect::<Vec<_>>();
        buffer.drain(..delimiter_len);
        events.push(String::from_utf8_lossy(&bytes).into_owned());
    }
    events
}

fn find_delimiter(buffer: &[u8]) -> Option<(usize, usize)> {
    let crlf = buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| (index, 4));
    let lf = buffer
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|index| (index, 2));
    match (crlf, lf) {
        (Some(a), Some(b)) => Some(if a.0 <= b.0 { a } else { b }),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

pub fn process(
    api_type: ProviderApiType,
    raw: &str,
    channel: &Channel<AiStreamEvent>,
    state: &mut StreamState,
) -> Result<(), String> {
    let mut event_name = None;
    let mut data = Vec::new();
    for line in raw.lines() {
        if let Some(value) = line.strip_prefix("event:") {
            event_name = Some(value.trim());
        } else if let Some(value) = line.strip_prefix("data:") {
            data.push(value.trim_start());
        }
    }
    if data.is_empty() {
        return Ok(());
    }
    if data.as_slice() == ["[DONE]"] {
        return finish(channel, state, None);
    }
    let value: Value = serde_json::from_str(&data.join("\n"))
        .map_err(|e| format!("AI ストリーム JSON の解析に失敗しました: {e}"))?;
    if let Some(message) = stream_error(event_name, &value) {
        return fail(channel, message);
    }
    match api_type {
        ProviderApiType::OpenaiResponses => {
            openai::parse_responses(event_name, &value, channel, state)
        }
        ProviderApiType::OpenaiChat => openai::parse_chat(&value, channel, state),
        ProviderApiType::AnthropicMessages => anthropic::parse(event_name, &value, channel, state),
        ProviderApiType::GoogleGenerateContent => google::parse(&value, channel, state),
    }
}

pub(super) fn finish(
    channel: &Channel<AiStreamEvent>,
    state: &mut StreamState,
    finish_reason: Option<String>,
) -> Result<(), String> {
    if state.has_pending_tools() {
        return fail(
            channel,
            "AI ストリームが未完了のツール呼び出しを残して終了しました。".into(),
        );
    }
    if state.mark_finished() {
        send(channel, AiStreamEvent::Finished { finish_reason })?;
    }
    Ok(())
}

pub fn validate_completion(
    channel: &Channel<AiStreamEvent>,
    state: &StreamState,
) -> Result<(), String> {
    if state.is_finished() {
        Ok(())
    } else {
        fail(
            channel,
            "AI ストリームが完了通知前に切断されました。もう一度お試しください。".into(),
        )
    }
}

fn fail(channel: &Channel<AiStreamEvent>, message: String) -> Result<(), String> {
    let _ = send(
        channel,
        AiStreamEvent::Error {
            message: message.clone(),
            status: None,
        },
    );
    Err(message)
}

fn stream_error(event_name: Option<&str>, value: &Value) -> Option<String> {
    let kind = event_name.or_else(|| value.get("type").and_then(Value::as_str));
    let error = value.get("error").filter(|error| !error.is_null());
    if matches!(kind, Some("error" | "response.failed")) || error.is_some() {
        return Some(
            value
                .pointer("/response/error/message")
                .or_else(|| value.pointer("/error/message"))
                .or_else(|| value.get("message"))
                .and_then(Value::as_str)
                .or_else(|| error.and_then(Value::as_str))
                .unwrap_or("AI API stream error")
                .to_owned(),
        );
    }
    value
        .pointer("/promptFeedback/blockReason")
        .and_then(Value::as_str)
        .map(|reason| format!("AI API が入力をブロックしました: {reason}"))
}

pub(super) fn send(channel: &Channel<AiStreamEvent>, event: AiStreamEvent) -> Result<(), String> {
    channel
        .send(event)
        .map_err(|e| format!("AI イベントの送信に失敗しました: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_mixed_delimiters_and_preserves_tail() {
        let mut buffer = b"event: one\ndata: {\"a\":1}\n\ndata: {\"b\":2}\r\n\r\npartial".to_vec();
        let events = take_events(&mut buffer);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0], "event: one\ndata: {\"a\":1}");
        assert_eq!(events[1], "data: {\"b\":2}");
        assert_eq!(buffer, b"partial");
    }
    fn channel() -> (
        Channel<AiStreamEvent>,
        std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
    ) {
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = events.clone();
        (
            Channel::new(move |body| {
                captured
                    .lock()
                    .unwrap()
                    .push(body.deserialize::<Value>().unwrap());
                Ok(())
            }),
            events,
        )
    }

    #[test]
    fn responses_completion_preserves_call_id_for_tool_result_replay() {
        let (channel, events) = channel();
        let mut state = StreamState::default();
        for raw in [
            r#"data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_item","call_id":"call_real","name":"lookup"}}"#,
            r#"data: {"type":"response.function_call_arguments.done","item_id":"fc_item","arguments":"{\"query\":\"x\"}"}"#,
            r#"data: {"type":"response.completed","response":{}}"#,
        ] {
            process(ProviderApiType::OpenaiResponses, raw, &channel, &mut state).unwrap();
        }
        validate_completion(&channel, &state).unwrap();
        let events = events.lock().unwrap();
        let call = events
            .iter()
            .find(|event| event["type"] == "tool_call")
            .unwrap();
        assert_eq!(call["tool_call_id"], "call_real");
        assert_eq!(call["tool_name"], "lookup");
        assert_eq!(call["input"]["query"], "x");
    }

    #[test]
    fn provider_error_envelopes_fail_instead_of_becoming_success() {
        for (api, raw) in [
            (
                ProviderApiType::OpenaiChat,
                r#"data: {"error":{"message":"overloaded"}}"#,
            ),
            (
                ProviderApiType::OpenaiResponses,
                r#"data: {"type":"error","message":"denied"}"#,
            ),
            (
                ProviderApiType::OpenaiResponses,
                r#"data: {"type":"response.failed","response":{"error":{"message":"failed"}}}"#,
            ),
            (
                ProviderApiType::AnthropicMessages,
                r#"event: error
data: {"error":{"message":"busy"}}"#,
            ),
            (
                ProviderApiType::GoogleGenerateContent,
                r#"data: {"error":{"message":"unavailable"}}"#,
            ),
            (
                ProviderApiType::GoogleGenerateContent,
                r#"data: {"promptFeedback":{"blockReason":"SAFETY"}}"#,
            ),
        ] {
            let (channel, events) = channel();
            assert!(
                process(api, raw, &channel, &mut StreamState::default()).is_err(),
                "{raw}"
            );
            let events = events.lock().unwrap();
            assert_eq!(events.len(), 1);
            assert_eq!(events[0]["type"], "error");
        }
    }

    #[test]
    fn eof_without_protocol_completion_rejects_partial_output() {
        let (channel, events) = channel();
        let mut state = StreamState::default();
        process(
            ProviderApiType::OpenaiChat,
            r#"data: {"choices":[{"delta":{"content":"partial"}}]}"#,
            &channel,
            &mut state,
        )
        .unwrap();
        assert!(validate_completion(&channel, &state).is_err());
        assert!(!events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event["type"] == "finished"));
    }

    #[test]
    fn finish_reason_done_and_eof_emit_success_only_once_and_keep_usage() {
        let (channel, events) = channel();
        let mut state = StreamState::default();
        for raw in [
            r#"data: {"choices":[{"finish_reason":"stop"}]}"#,
            r#"data: {"choices":[],"usage":{"completion_tokens":9}}"#,
            "data: [DONE]",
        ] {
            process(ProviderApiType::OpenaiChat, raw, &channel, &mut state).unwrap();
        }
        validate_completion(&channel, &state).unwrap();
        let events = events.lock().unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| event["type"] == "finished")
                .count(),
            1
        );
        assert!(events
            .iter()
            .any(|event| event["type"] == "usage" && event["output_tokens"] == 9));
    }

    #[test]
    fn malformed_or_unfinished_tool_calls_never_emit_executable_calls() {
        for ending in [
            "data: [DONE]",
            r#"data: {"choices":[{"finish_reason":"tool_calls"}]}"#,
        ] {
            let (channel, events) = channel();
            let mut state = StreamState::default();
            process(ProviderApiType::OpenaiChat,
                r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call1","function":{"name":"write","arguments":"{"}}]}}]}"#,
                &channel, &mut state).unwrap();
            assert!(process(ProviderApiType::OpenaiChat, ending, &channel, &mut state).is_err());
            assert!(!events
                .lock()
                .unwrap()
                .iter()
                .any(|event| event["type"] == "tool_call"));
        }
    }

    #[test]
    fn fragmented_utf8_and_crlf_boundaries_preserve_payload() {
        let raw = "data: {\"text\":\"日本語\"}\r\n\r\n";
        let mut buffer = Vec::new();
        let mut events = Vec::new();
        for byte in raw.as_bytes() {
            buffer.push(*byte);
            events.extend(take_events(&mut buffer));
        }
        assert_eq!(events, vec!["data: {\"text\":\"日本語\"}"]);
        assert!(buffer.is_empty());
    }
}
