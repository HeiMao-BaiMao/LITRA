use reqwest::{header, Client, RequestBuilder};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ai::auth::store;

const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const EXPIRY_SKEW_MS: u64 = 30_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexCredential {
    access: String,
    refresh: String,
    expires: u64,
    account_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RefreshResponse {
    id_token: Option<String>,
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

pub async fn apply_request(
    builder: RequestBuilder,
    client: &Client,
) -> Result<RequestBuilder, String> {
    let mut credential = store::read_json::<CodexCredential>("codex")
        .await?
        .ok_or_else(|| {
            "Codex にログインしていません。設定画面からログインしてください。".to_string()
        })?;
    if credential.expires < now_ms().saturating_add(EXPIRY_SKEW_MS) {
        credential = refresh(client, credential).await?;
    }
    let mut builder = builder
        .header(
            header::AUTHORIZATION,
            format!("Bearer {}", credential.access),
        )
        .header("originator", "opencode")
        .header(header::USER_AGENT, "opencode/1.17.18")
        .header("session-id", format!("ses_{}", Uuid::new_v4().simple()));
    if let Some(account_id) = credential.account_id.filter(|value| !value.is_empty()) {
        builder = builder.header("ChatGPT-Account-Id", account_id);
    }
    Ok(builder)
}

async fn refresh(client: &Client, previous: CodexCredential) -> Result<CodexCredential, String> {
    let response = client
        .post(TOKEN_URL)
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", previous.refresh.as_str()),
            ("client_id", CLIENT_ID),
        ])
        .send()
        .await
        .map_err(|error| format!("Codex token refresh failed: {error}"))?;
    if !response.status().is_success() {
        return Err("Codex のトークン更新に失敗しました。再ログインしてください。".into());
    }
    let tokens: RefreshResponse = response
        .json()
        .await
        .map_err(|error| format!("Codex token response is invalid: {error}"))?;
    let credential = CodexCredential {
        access: tokens.access_token,
        refresh: tokens.refresh_token.unwrap_or(previous.refresh),
        expires: now_ms().saturating_add(tokens.expires_in.unwrap_or(3600) * 1000),
        account_id: tokens
            .id_token
            .as_deref()
            .and_then(crate::codex_oauth::extract_account_id_from_jwt)
            .or(previous.account_id),
    };
    store::write_json("codex", &credential).await?;
    Ok(credential)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
