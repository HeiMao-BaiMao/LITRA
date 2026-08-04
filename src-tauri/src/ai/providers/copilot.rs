use reqwest::{header, RequestBuilder};
use serde::Deserialize;

use crate::ai::{auth::store, types::AiTextRequest};

const API_VERSION: &str = "2026-06-01";

#[derive(Debug, Deserialize)]
struct CopilotCredential {
    token: String,
}

pub async fn apply_request(
    builder: RequestBuilder,
    request: &AiTextRequest,
) -> Result<RequestBuilder, String> {
    let credential = store::read_json::<CopilotCredential>("github-copilot")
        .await?
        .ok_or_else(|| {
            "GitHub Copilot にログインしていません。設定画面からログインしてください。".to_string()
        })?;
    if credential.token.trim().is_empty() {
        return Err("GitHub Copilot の資格情報が無効です。再ログインしてください。".into());
    }
    let initiator = copilot_initiator(request);
    let builder = builder
        .header(
            header::AUTHORIZATION,
            format!("Bearer {}", credential.token),
        )
        .header(header::USER_AGENT, "litra/1.0")
        .header("X-GitHub-Api-Version", API_VERSION)
        .header("Openai-Intent", "conversation-edits")
        .header("x-initiator", initiator);
    Ok(
        if request
            .messages
            .iter()
            .any(|message| contains_image(&message.content))
        {
            builder.header("Copilot-Vision-Request", "true")
        } else {
            builder
        },
    )
}

fn contains_image(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(object) => {
            object
                .get("type")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|kind| matches!(kind, "image" | "image_url" | "input_image"))
                || object.values().any(contains_image)
        }
        serde_json::Value::Array(values) => values.iter().any(contains_image),
        _ => false,
    }
}

fn copilot_initiator(request: &AiTextRequest) -> &'static str {
    let Some(message) = request.messages.last() else {
        return "user";
    };
    if let Some(attribution) = message.attribution.as_deref() {
        match attribution.trim().to_ascii_lowercase().as_str() {
            "agent" => return "agent",
            "user" => return "user",
            _ => {}
        }
    }
    if message.role != "user" {
        return "agent";
    }
    if contains_image(&message.content) || content_is_only_tool_results(&message.content) {
        return "agent";
    }
    "user"
}

fn content_is_only_tool_results(value: &serde_json::Value) -> bool {
    value.as_array().is_some_and(|items| {
        !items.is_empty()
            && items.iter().all(|item| {
                item.get("type").and_then(serde_json::Value::as_str) == Some("tool_result")
            })
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn request(message: serde_json::Value) -> AiTextRequest {
        serde_json::from_value(json!({
            "requestId": "test",
            "provider": "github-copilot",
            "apiType": "openai-chat",
            "baseUrl": "https://api.githubcopilot.com",
            "model": "gpt-5.5",
            "maxOutputTokens": 128,
            "messages": [message]
        }))
        .expect("valid Copilot request")
    }

    #[test]
    fn initiator_follows_attribution_and_tool_results() {
        assert_eq!(
            copilot_initiator(&request(json!({
                "role": "user",
                "content": "hello",
                "attribution": "agent"
            }))),
            "agent"
        );
        assert_eq!(
            copilot_initiator(&request(json!({
                "role": "user",
                "content": [{"type": "tool_result", "content": "done"}]
            }))),
            "agent"
        );
        assert_eq!(
            copilot_initiator(&request(json!({
                "role": "user",
                "content": "hello"
            }))),
            "user"
        );
        assert_eq!(
            copilot_initiator(&request(json!({
                "role": "user",
                "content": [
                    {"type": "text", "text": "context"},
                    {"type": "tool_result", "content": "done"}
                ]
            }))),
            "user"
        );
        assert_eq!(
            copilot_initiator(&request(json!({
                "role": "user",
                "content": [{"type": "input_image", "image_url": "data:image/png;base64,..."}]
            }))),
            "agent"
        );
    }

    #[test]
    fn vision_detection_handles_nested_content() {
        assert!(contains_image(&json!({
            "type": "tool_result",
            "content": [{"type": "input_image", "image_url": "data:image/png;base64,..."}]
        })));
        assert!(!contains_image(&json!({"type": "text", "text": "plain"})));
    }
}
