use std::time::Duration;

use reqwest::{header, Client, Response};

use super::{
    providers,
    types::{AiTextRequest, ProviderApiType},
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const ANTHROPIC_VERSION: &str = "2023-06-01";
const STREAM_HEAD_LIMIT: usize = 2_048;

pub struct AiHttpResponse {
    pub response: Response,
    pub prefix: Vec<u8>,
}

pub fn build_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("AI HTTP クライアントの初期化に失敗しました: {e}"))
}

pub async fn send_request(
    client: &Client,
    request: &AiTextRequest,
) -> Result<AiHttpResponse, String> {
    for attempt in 0.. {
        providers::wait_for_request_slot(request).await;
        let body = providers::normalize_body(request, request.body());
        let mut builder = client
            .post(request.endpoint())
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ACCEPT, "text/event-stream")
            .json(&body);

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
        let mut response = providers::apply_request(builder, request, client)
            .await?
            .send()
            .await
            .map_err(|e| format!("AI API への接続に失敗しました: {e}"))?;

        if let Some(delay) = providers::retry_delay(request, response.status().as_u16(), attempt) {
            tokio::time::sleep(retry_after(&response).unwrap_or(delay)).await;
            continue;
        }

        let mut prefix = Vec::new();
        if is_event_stream(&response) && providers::requires_stream_head_inspection(request) {
            read_stream_head(&mut response, &mut prefix).await?;
            if let Some(message) =
                providers::stream_head_error(request, &String::from_utf8_lossy(&prefix))
            {
                if let Some(delay) = providers::retry_delay(request, 503, attempt) {
                    tokio::time::sleep(delay).await;
                    continue;
                }
                return Err(format!("OpenCode upstream error: {message}"));
            }
        }
        return Ok(AiHttpResponse { response, prefix });
    }
    unreachable!("retry loop always returns or continues")
}

fn is_event_stream(response: &Response) -> bool {
    response.status().is_success()
        && response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.to_ascii_lowercase().contains("text/event-stream"))
}

async fn read_stream_head(response: &mut Response, prefix: &mut Vec<u8>) -> Result<(), String> {
    while prefix.len() < STREAM_HEAD_LIMIT && !prefix.windows(2).any(|window| window == b"\n\n") {
        let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| format!("AI ストリームの先読み中に失敗しました: {e}"))?
        else {
            break;
        };
        prefix.extend_from_slice(&chunk);
    }
    Ok(())
}

fn retry_after(response: &Response) -> Option<Duration> {
    let seconds = response
        .headers()
        .get(header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .parse::<f64>()
        .ok()?;
    seconds
        .is_finite()
        .then(|| Duration::from_secs_f64(seconds.max(0.0)))
}
