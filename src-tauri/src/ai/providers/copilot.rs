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
    let initiator = request
        .messages
        .last()
        .map(|message| {
            if message.role == "user" {
                "user"
            } else {
                "agent"
            }
        })
        .unwrap_or("user");
    Ok(builder
        .header(
            header::AUTHORIZATION,
            format!("Bearer {}", credential.token),
        )
        .header(header::USER_AGENT, "litra/1.0")
        .header("X-GitHub-Api-Version", API_VERSION)
        .header("Openai-Intent", "conversation-edits")
        .header("x-initiator", initiator))
}
