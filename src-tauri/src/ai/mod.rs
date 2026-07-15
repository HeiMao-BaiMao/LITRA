mod providers;
mod stream;
mod transport;
mod types;

use std::{collections::HashMap, sync::Arc};

use futures_util::StreamExt;
use tauri::ipc::Channel;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use types::{AiStreamEvent, AiTextRequest};

#[derive(Clone, Default)]
pub struct AiRequestRegistry {
    requests: Arc<Mutex<HashMap<String, CancellationToken>>>,
}

#[tauri::command]
pub async fn ai_cancel(
    request_id: String,
    state: tauri::State<'_, AiRequestRegistry>,
) -> Result<(), String> {
    if let Some(token) = state.requests.lock().await.get(&request_id) {
        token.cancel();
    }
    Ok(())
}

#[tauri::command]
pub async fn ai_stream_text(
    request: AiTextRequest,
    on_event: Channel<AiStreamEvent>,
    state: tauri::State<'_, AiRequestRegistry>,
) -> Result<(), String> {
    let token = CancellationToken::new();
    {
        let mut requests = state.requests.lock().await;
        if requests.contains_key(&request.request_id) {
            return Err(format!(
                "重複した AI request_id です: {}",
                request.request_id
            ));
        }
        requests.insert(request.request_id.clone(), token.clone());
    }
    let result = stream_request(&request, &on_event, &token).await;
    state.requests.lock().await.remove(&request.request_id);
    result
}

async fn stream_request(
    request: &AiTextRequest,
    channel: &Channel<AiStreamEvent>,
    token: &CancellationToken,
) -> Result<(), String> {
    send(
        channel,
        AiStreamEvent::Started {
            request_id: request.request_id.clone(),
        },
    )?;
    let client = transport::build_client()?;
    let response = tokio::select! {
        _ = token.cancelled() => {
            send(channel, AiStreamEvent::Cancelled)?;
            return Ok(());
        }
        response = transport::send_request(&client, request) => response?,
    };
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        let message = format!("AI API エラー ({status}): {}", truncate(&body, 1000));
        let _ = send(
            channel,
            AiStreamEvent::Error {
                message: message.clone(),
                status: Some(status),
            },
        );
        return Err(message);
    }

    let mut body = response.bytes_stream();
    let mut buffer = Vec::new();
    loop {
        tokio::select! {
            _ = token.cancelled() => {
                send(channel, AiStreamEvent::Cancelled)?;
                return Ok(());
            }
            next = body.next() => match next {
                Some(Ok(bytes)) => {
                    buffer.extend_from_slice(&bytes);
                    for event in stream::take_events(&mut buffer) {
                        stream::process(request.api_type, &event, channel)?;
                    }
                }
                Some(Err(error)) => {
                    let message = format!("AI ストリームの受信に失敗しました: {error}");
                    let _ = send(channel, AiStreamEvent::Error { message: message.clone(), status: None });
                    return Err(message);
                }
                None => break,
            }
        }
    }
    if !buffer.is_empty() {
        stream::process(request.api_type, &String::from_utf8_lossy(&buffer), channel)?;
    }
    send(
        channel,
        AiStreamEvent::Finished {
            finish_reason: None,
        },
    )
}

fn send(channel: &Channel<AiStreamEvent>, event: AiStreamEvent) -> Result<(), String> {
    channel
        .send(event)
        .map_err(|e| format!("AI イベントの送信に失敗しました: {e}"))
}

fn truncate(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::types::{AiTextRequest, ProviderApiType};

    #[test]
    fn endpoint_is_selected_by_configured_api_type() {
        let mut request = sample_request();
        request.api_type = ProviderApiType::AnthropicMessages;
        request.base_url = "https://gateway.example/v1".into();
        assert_eq!(request.endpoint(), "https://gateway.example/v1/messages");
        request.api_type = ProviderApiType::OpenaiResponses;
        assert_eq!(request.endpoint(), "https://gateway.example/v1/responses");
    }

    #[test]
    fn complete_endpoint_is_not_appended_twice() {
        let mut request = sample_request();
        request.api_type = ProviderApiType::OpenaiResponses;
        request.base_url = "https://gateway.example/v1/responses".into();
        assert_eq!(request.endpoint(), request.base_url);

        request.api_type = ProviderApiType::OpenaiChat;
        request.base_url = "https://gateway.example/v1/chat/completions".into();
        assert_eq!(request.endpoint(), request.base_url);

        request.api_type = ProviderApiType::AnthropicMessages;
        request.base_url = "https://gateway.example/v1/messages".into();
        assert_eq!(request.endpoint(), request.base_url);
    }

    #[test]
    fn anthropic_effort_uses_output_config() {
        let mut request = sample_request();
        request.api_type = ProviderApiType::AnthropicMessages;
        request.anthropic_thinking_type = Some("adaptive".into());
        request.anthropic_thinking_effort = Some("medium".into());
        let body = request.body();
        assert_eq!(body["thinking"]["type"], "adaptive");
        assert_eq!(body["output_config"]["effort"], "medium");
        assert!(body.get("effort").is_none());
    }

    fn sample_request() -> AiTextRequest {
        AiTextRequest {
            request_id: "test".into(),
            provider: "custom".into(),
            api_type: ProviderApiType::OpenaiChat,
            api_key: "key".into(),
            base_url: "https://gateway.example/v1".into(),
            model: "model".into(),
            system: String::new(),
            prompt: "hello".into(),
            max_output_tokens: 100,
            temperature: None,
            top_p: None,
            top_k: None,
            frequency_penalty: None,
            presence_penalty: None,
            reasoning_effort: None,
            thinking_enabled: None,
            thinking_budget: None,
            anthropic_thinking_type: None,
            anthropic_thinking_effort: None,
            thinking_level: None,
        }
    }
}
