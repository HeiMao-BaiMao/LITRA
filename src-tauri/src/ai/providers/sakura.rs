use std::{sync::LazyLock, time::Duration};

use serde_json::Value;
use tokio::{sync::Mutex, time::Instant};

const MIN_REQUEST_INTERVAL: Duration = Duration::from_millis(2_500);
const RETRY_DELAYS: [Duration; 4] = [
    Duration::from_millis(2_500),
    Duration::from_millis(5_000),
    Duration::from_millis(10_000),
    Duration::from_millis(20_000),
];

static NEXT_REQUEST_AT: LazyLock<Mutex<Option<Instant>>> = LazyLock::new(|| Mutex::new(None));

pub(super) async fn wait_for_request_slot() {
    let mut next_request_at = NEXT_REQUEST_AT.lock().await;
    if let Some(deadline) = *next_request_at {
        tokio::time::sleep_until(deadline).await;
    }
    *next_request_at = Some(Instant::now() + MIN_REQUEST_INTERVAL);
}

pub(super) fn retry_delay(status: u16, attempt: usize) -> Option<Duration> {
    if !matches!(status, 429 | 439) {
        return None;
    }
    RETRY_DELAYS.get(attempt).copied()
}

pub(super) fn normalize_body(mut body: Value) -> Value {
    let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) else {
        return body;
    };
    for tool in tools {
        let parameters = if tool.get("function").is_some() {
            tool.get_mut("function")
                .and_then(|function| function.get_mut("parameters"))
        } else {
            tool.get_mut("parameters")
        };
        if let Some(parameters) = parameters {
            normalize_schema(parameters);
        }
    }
    body
}

fn normalize_schema(value: &mut Value) {
    match value {
        Value::Object(object) => {
            object.remove("$schema");
            object.remove("propertyNames");
            for child in object.values_mut() {
                normalize_schema(child);
            }
        }
        Value::Array(array) => {
            for child in array {
                normalize_schema(child);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn strips_unsupported_schema_keywords_from_nested_tools() {
        let body = json!({
            "tools": [{
                "type": "function",
                "function": {
                    "name": "search",
                    "parameters": {
                        "$schema": "https://json-schema.org/draft/2020-12/schema",
                        "type": "object",
                        "propertyNames": { "pattern": "^[a-z]+$" },
                        "properties": { "query": { "type": "string" } }
                    }
                }
            }]
        });

        let normalized = normalize_body(body);
        let parameters = &normalized["tools"][0]["function"]["parameters"];
        assert!(parameters.get("$schema").is_none());
        assert!(parameters.get("propertyNames").is_none());
        assert_eq!(parameters["properties"]["query"]["type"], "string");
    }

    #[test]
    fn retries_only_sakura_rate_limit_statuses_with_a_bounded_schedule() {
        assert_eq!(retry_delay(429, 0), Some(Duration::from_millis(2_500)));
        assert_eq!(retry_delay(439, 3), Some(Duration::from_millis(20_000)));
        assert_eq!(retry_delay(429, 4), None);
        assert_eq!(retry_delay(400, 0), None);
    }
}
