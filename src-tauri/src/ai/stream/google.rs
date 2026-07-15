use serde_json::Value;
use tauri::ipc::Channel;

use super::send;
use crate::ai::types::AiStreamEvent;

pub fn parse(value: &Value, channel: &Channel<AiStreamEvent>) -> Result<(), String> {
    if let Some(parts) = value
        .pointer("/candidates/0/content/parts")
        .and_then(Value::as_array)
    {
        for part in parts {
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
