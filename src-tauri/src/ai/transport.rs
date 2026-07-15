use std::time::Duration;

use reqwest::{header, Client, Response};

use super::{
    providers,
    types::{AiTextRequest, ProviderApiType},
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const ANTHROPIC_VERSION: &str = "2023-06-01";

pub fn build_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("AI HTTP クライアントの初期化に失敗しました: {e}"))
}

pub async fn send_request(client: &Client, request: &AiTextRequest) -> Result<Response, String> {
    let mut builder = client
        .post(request.endpoint())
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "text/event-stream")
        .json(&request.body());

    builder = match request.api_type {
        ProviderApiType::AnthropicMessages => builder
            .header("x-api-key", &request.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION),
        ProviderApiType::GoogleGenerateContent => {
            builder.header("x-goog-api-key", &request.api_key)
        }
        _ if request.api_key.trim().is_empty() => builder,
        _ => builder.bearer_auth(&request.api_key),
    };
    providers::apply_request(builder, request, client)
        .await?
        .send()
        .await
        .map_err(|e| format!("AI API への接続に失敗しました: {e}"))
}
