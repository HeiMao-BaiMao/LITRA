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
    if data.is_empty() || data.as_slice() == ["[DONE]"] {
        return Ok(());
    }
    let value: Value = serde_json::from_str(&data.join("\n"))
        .map_err(|e| format!("AI ストリーム JSON の解析に失敗しました: {e}"))?;
    match api_type {
        ProviderApiType::OpenaiResponses => {
            openai::parse_responses(event_name, &value, channel, state)
        }
        ProviderApiType::OpenaiChat => openai::parse_chat(&value, channel, state),
        ProviderApiType::AnthropicMessages => anthropic::parse(event_name, &value, channel, state),
        ProviderApiType::GoogleGenerateContent => google::parse(&value, channel, state),
    }
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
}
