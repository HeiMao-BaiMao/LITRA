use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use reqwest::{header, Client};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::ai::auth::store;

const CLIENT_ID: &str = "Ov23li8tweQw6odWQebz";
const FLOW_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Default)]
pub struct CopilotOAuthCancelFlag(Arc<AtomicBool>);

impl CopilotOAuthCancelFlag {
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotOAuthEvent {
    user_code: String,
    verification_uri: String,
}

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    interval: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CopilotCredential {
    token: String,
    enterprise_url: Option<String>,
}

#[tauri::command]
pub async fn start_copilot_device_auth(
    enterprise_url: Option<String>,
    on_event: Channel<CopilotOAuthEvent>,
    cancel: tauri::State<'_, CopilotOAuthCancelFlag>,
) -> Result<(), String> {
    cancel.0.store(false, Ordering::SeqCst);
    let domain = enterprise_url
        .as_deref()
        .map(normalize_domain)
        .unwrap_or_else(|| "github.com".into());
    let client = Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("Copilot OAuth client の初期化に失敗しました: {error}"))?;
    let device: DeviceCodeResponse = client
        .post(format!("https://{domain}/login/device/code"))
        .header(header::ACCEPT, "application/json")
        .header(header::USER_AGENT, "litra/1.0")
        .form(&[("client_id", CLIENT_ID), ("scope", "read:user")])
        .send()
        .await
        .map_err(|error| format!("Copilot device code の取得に失敗しました: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Copilot device code の取得に失敗しました: {error}"))?
        .json()
        .await
        .map_err(|error| format!("Copilot device code の解析に失敗しました: {error}"))?;
    on_event
        .send(CopilotOAuthEvent {
            user_code: device.user_code.clone(),
            verification_uri: device.verification_uri.clone(),
        })
        .map_err(|error| format!("Copilot user code の通知に失敗しました: {error}"))?;

    let started = Instant::now();
    let mut interval = device.interval.unwrap_or(5);
    loop {
        if cancel.0.load(Ordering::SeqCst) {
            return Err("ログインがキャンセルされました。".into());
        }
        if started.elapsed() >= FLOW_TIMEOUT {
            return Err("Copilot 認証がタイムアウトしました。".into());
        }
        tokio::time::sleep(Duration::from_secs(interval + 3)).await;
        let token: TokenResponse = client
            .post(format!("https://{domain}/login/oauth/access_token"))
            .header(header::ACCEPT, "application/json")
            .header(header::USER_AGENT, "litra/1.0")
            .form(&[
                ("client_id", CLIENT_ID),
                ("device_code", device.device_code.as_str()),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send()
            .await
            .map_err(|error| format!("Copilot token の取得に失敗しました: {error}"))?
            .json()
            .await
            .map_err(|error| format!("Copilot token の解析に失敗しました: {error}"))?;
        if let Some(access_token) = token.access_token {
            store::write_json(
                "github-copilot",
                &CopilotCredential {
                    token: access_token,
                    enterprise_url,
                },
            )
            .await?;
            return Ok(());
        }
        match token.error.as_deref() {
            Some("authorization_pending") => {}
            Some("slow_down") => interval = (interval + 5).min(30),
            Some("access_denied") => return Err("認証が拒否されました。".into()),
            Some("expired_token") => return Err("認証コードの有効期限が切れました。".into()),
            Some(error) => {
                return Err(token
                    .error_description
                    .unwrap_or_else(|| format!("Copilot OAuth error: {error}")))
            }
            None => return Err("Copilot OAuth から token が返されませんでした。".into()),
        }
    }
}

#[tauri::command]
pub async fn cancel_copilot_device_auth(
    cancel: tauri::State<'_, CopilotOAuthCancelFlag>,
) -> Result<(), String> {
    cancel.0.store(true, Ordering::SeqCst);
    Ok(())
}

fn normalize_domain(value: &str) -> String {
    value
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalizes_enterprise_domains() {
        assert_eq!(
            normalize_domain("https://github.example/"),
            "github.example"
        );
    }
}
