use std::{sync::LazyLock, time::Duration};

use reqwest::{header, RequestBuilder};
use serde_json::Value;
use tokio::{sync::Mutex, time::Instant};

const MIN_REQUEST_INTERVAL: Duration = Duration::from_millis(1_500);
const RETRY_DELAYS: [Duration; 4] = [
    Duration::from_millis(2_000),
    Duration::from_millis(4_000),
    Duration::from_millis(8_000),
    Duration::from_millis(16_000),
];
static NEXT_REQUEST_AT: LazyLock<Mutex<Option<Instant>>> = LazyLock::new(|| Mutex::new(None));

pub(super) fn apply_request(builder: RequestBuilder) -> RequestBuilder {
    builder
        .header("x-opencode-client", "litra")
        .header(header::USER_AGENT, "litra/1.0")
}

pub(super) async fn wait_for_request_slot() {
    let mut next_request_at = NEXT_REQUEST_AT.lock().await;
    if let Some(deadline) = *next_request_at {
        tokio::time::sleep_until(deadline).await;
    }
    *next_request_at = Some(Instant::now() + MIN_REQUEST_INTERVAL);
}

pub(super) fn retry_delay(status: u16, attempt: usize) -> Option<Duration> {
    matches!(status, 429 | 500 | 502 | 503 | 529)
        .then(|| RETRY_DELAYS.get(attempt).copied())
        .flatten()
}

pub(super) fn normalize_body(mut body: Value) -> Value {
    if let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) {
        for message in messages {
            let has_tool_calls = message
                .get("tool_calls")
                .and_then(Value::as_array)
                .is_some_and(|calls| !calls.is_empty());
            if message.get("role").and_then(Value::as_str) == Some("assistant")
                && has_tool_calls
                && message.get("content").and_then(Value::as_str) == Some("")
            {
                message["content"] = Value::Null;
            }
        }
    }
    body
}

pub(super) fn transient_error_message(text: &str) -> Option<String> {
    let message = structured_error_message(text)?;
    let lower = message.to_ascii_lowercase();
    if [
        "validation error",
        "input should be",
        "unprocessable entity",
        "invalid",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
    {
        return None;
    }
    [
        "upstream request failed",
        "upstream error",
        "upstream unavailable",
        "overloaded",
        "temporarily unavailable",
        "service unavailable",
        "rate-limit",
        "rate limit",
        "too many requests",
        "throttl",
        "bad gateway",
        "gateway timeout",
        "connection reset",
        "connection refused",
        "econnreset",
        "etimedout",
        "socket hang up",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
    .then_some(message)
}

fn structured_error_message(text: &str) -> Option<String> {
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        if let Some(message) = json_error_message(&value) {
            return Some(message.into());
        }
    }
    for event in text.split("\n\n") {
        if !event.lines().any(|line| line.trim() == "event: error") {
            continue;
        }
        let data = event
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim_start)
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() {
            return Some("OpenCode stream error".into());
        }
        if let Ok(value) = serde_json::from_str::<Value>(&data) {
            if let Some(message) = json_error_message(&value) {
                return Some(message.into());
            }
        }
        return Some(data);
    }
    None
}

fn json_error_message(value: &Value) -> Option<&str> {
    value.get("message").and_then(Value::as_str).or_else(|| {
        value
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn detects_only_structured_transient_errors() {
        assert_eq!(
            transient_error_message(r#"{"error":{"message":"upstream request failed"}}"#),
            Some("upstream request failed".into())
        );
        assert_eq!(
            transient_error_message(
                "event: error\ndata: {\"message\":\"service unavailable\"}\n\n"
            ),
            Some("service unavailable".into())
        );
        assert_eq!(
            transient_error_message("data: service unavailable\n\n"),
            None
        );
        assert_eq!(
            transient_error_message(r#"{"error":{"message":"invalid input"}}"#),
            None
        );
    }

    #[test]
    fn normalizes_empty_tool_call_assistant_content() {
        let body = json!({"messages": [{"role": "assistant", "content": "", "tool_calls": [{}]}]});
        assert!(normalize_body(body)["messages"][0]["content"].is_null());
    }
}
