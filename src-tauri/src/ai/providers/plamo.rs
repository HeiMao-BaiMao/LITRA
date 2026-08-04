use serde_json::Value;

pub(super) fn normalize_body(mut body: Value) -> Value {
    let Some(object) = body.as_object_mut() else {
        return body;
    };
    object.remove("parallel_tool_calls");
    object.remove("top_k");
    if let Some(tools) = object.get_mut("tools").and_then(Value::as_array_mut) {
        for tool in tools {
            if let Some(parameters) = tool
                .get_mut("function")
                .and_then(|function| function.get_mut("parameters"))
            {
                normalize_schema(parameters);
            }
        }
    }
    body
}

pub(super) fn stream_error_message(text: &str) -> Option<String> {
    let normalized = text.replace("\r\n", "\n");
    for event in normalized.split("\n\n") {
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
            return Some("PLaMo stream error".into());
        }
        if let Ok(value) = serde_json::from_str::<Value>(&data) {
            if let Some(message) = value.get("message").and_then(Value::as_str).or_else(|| {
                value
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
            }) {
                return Some(message.into());
            }
        }
        return Some(data);
    }
    None
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
    fn strips_unsupported_request_and_schema_fields() {
        let body = json!({
            "parallel_tool_calls": true,
            "top_k": 40,
            "tools": [{"function": {"parameters": {
                "$schema": "draft", "type": "object",
                "properties": {"map": {"propertyNames": {"pattern": "x"}}}
            }}}]
        });
        let normalized = normalize_body(body);
        assert!(normalized.get("parallel_tool_calls").is_none());
        assert!(normalized.get("top_k").is_none());
        let schema = &normalized["tools"][0]["function"]["parameters"];
        assert!(schema.get("$schema").is_none());
        assert!(schema["properties"]["map"].get("propertyNames").is_none());
    }

    #[test]
    fn extracts_json_and_raw_sse_errors_with_crlf_support() {
        assert_eq!(
            stream_error_message(
                "event: error\r\ndata: {\"error\":{\"message\":\"busy\"}}\r\n\r\n"
            ),
            Some("busy".into())
        );
        assert_eq!(
            stream_error_message("event: error\ndata: unavailable\n\n"),
            Some("unavailable".into())
        );
        assert_eq!(stream_error_message("data: normal text\n\n"), None);
    }

    #[test]
    fn serde_keeps_float_parameter_types() {
        let encoded = serde_json::to_string(&json!({"temperature": 1.0, "top_p": 1.0})).unwrap();
        assert!(encoded.contains("\"temperature\":1.0"));
        assert!(encoded.contains("\"top_p\":1.0"));
    }
}
