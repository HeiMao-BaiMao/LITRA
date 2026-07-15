pub(crate) mod auth;
pub(crate) mod config;
mod messages;
pub(crate) mod models;
pub(crate) mod oauth;
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
    let prepared = tokio::select! {
        _ = token.cancelled() => {
            send(channel, AiStreamEvent::Cancelled)?;
            return Ok(());
        }
        response = transport::send_request(&client, request) => response?,
    };
    let transport::AiHttpResponse {
        response,
        mut prefix,
    } = prepared;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let mut body = String::from_utf8_lossy(&prefix).into_owned();
        body.push_str(&response.text().await.unwrap_or_default());
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
    let mut buffer = std::mem::take(&mut prefix);
    let mut stream_state = stream::StreamState::default();
    for event in stream::take_events(&mut buffer) {
        stream::process(request.api_type, &event, channel, &mut stream_state)?;
    }
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
                        stream::process(request.api_type, &event, channel, &mut stream_state)?;
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
        stream::process(
            request.api_type,
            &String::from_utf8_lossy(&buffer),
            channel,
            &mut stream_state,
        )?;
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
    use serde_json::json;

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
            messages: Vec::new(),
            tools: Vec::new(),
            tool_choice: None,
            tool_choice_name: None,
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

    #[test]
    fn message_history_is_converted_for_each_protocol() {
        use super::types::AiInputMessage;

        let mut request = sample_request();
        request.messages = vec![
            AiInputMessage {
                role: "user".into(),
                content: json!("first"),
            },
            AiInputMessage {
                role: "assistant".into(),
                content: json!("second"),
            },
            AiInputMessage {
                role: "user".into(),
                content: json!("third"),
            },
        ];

        request.api_type = ProviderApiType::OpenaiResponses;
        assert_eq!(request.body()["input"][1]["role"], "assistant");
        request.api_type = ProviderApiType::AnthropicMessages;
        assert_eq!(request.body()["messages"][2]["content"][0]["text"], "third");
        request.api_type = ProviderApiType::GoogleGenerateContent;
        assert_eq!(request.body()["contents"][1]["role"], "model");
    }

    #[test]
    fn tools_are_converted_for_each_protocol() {
        use super::types::AiToolDefinition;

        let mut request = sample_request();
        request.tools = vec![AiToolDefinition {
            name: "lookup".into(),
            description: "Look up a value".into(),
            input_schema: json!({ "type": "object", "properties": { "id": { "type": "string" } } }),
        }];
        request.tool_choice = Some("required".into());

        request.api_type = ProviderApiType::OpenaiResponses;
        assert_eq!(request.body()["tools"][0]["name"], "lookup");
        assert_eq!(request.body()["tool_choice"], "required");
        request.api_type = ProviderApiType::OpenaiChat;
        assert_eq!(request.body()["tools"][0]["function"]["name"], "lookup");
        request.api_type = ProviderApiType::AnthropicMessages;
        assert_eq!(request.body()["tools"][0]["input_schema"]["type"], "object");
        assert_eq!(request.body()["tool_choice"]["type"], "any");
        request.api_type = ProviderApiType::GoogleGenerateContent;
        assert_eq!(
            request.body()["tools"][0]["functionDeclarations"][0]["name"],
            "lookup"
        );
        assert_eq!(
            request.body()["toolConfig"]["functionCallingConfig"]["mode"],
            "ANY"
        );
    }

    #[test]
    fn named_tool_choice_is_converted_for_each_protocol() {
        use super::types::AiToolDefinition;

        let mut request = sample_request();
        request.tools = vec![AiToolDefinition {
            name: "submit".into(),
            description: String::new(),
            input_schema: json!({ "type": "object" }),
        }];
        request.tool_choice_name = Some("submit".into());

        request.api_type = ProviderApiType::OpenaiResponses;
        assert_eq!(request.body()["tool_choice"]["name"], "submit");
        request.api_type = ProviderApiType::OpenaiChat;
        assert_eq!(request.body()["tool_choice"]["function"]["name"], "submit");
        request.api_type = ProviderApiType::AnthropicMessages;
        assert_eq!(request.body()["tool_choice"]["name"], "submit");
        request.api_type = ProviderApiType::GoogleGenerateContent;
        assert_eq!(
            request.body()["toolConfig"]["functionCallingConfig"]["allowedFunctionNames"][0],
            "submit"
        );
    }

    #[test]
    fn tool_history_is_converted_for_each_protocol() {
        use super::types::AiInputMessage;

        let mut request = sample_request();
        request.messages = vec![
            AiInputMessage {
                role: "assistant".into(),
                content: json!([{ "type": "tool-call", "toolCallId": "call-1", "toolName": "lookup", "input": { "id": "42" } }]),
            },
            AiInputMessage {
                role: "tool".into(),
                content: json!([{ "type": "tool-result", "toolCallId": "call-1", "toolName": "lookup", "output": { "type": "json", "value": { "name": "answer" } } }]),
            },
        ];

        request.api_type = ProviderApiType::OpenaiResponses;
        assert_eq!(request.body()["input"][0]["type"], "function_call");
        assert_eq!(request.body()["input"][1]["type"], "function_call_output");
        request.api_type = ProviderApiType::OpenaiChat;
        assert_eq!(
            request.body()["messages"][0]["tool_calls"][0]["function"]["name"],
            "lookup"
        );
        assert_eq!(request.body()["messages"][1]["role"], "tool");
        request.api_type = ProviderApiType::AnthropicMessages;
        assert_eq!(
            request.body()["messages"][0]["content"][0]["type"],
            "tool_use"
        );
        assert_eq!(
            request.body()["messages"][1]["content"][0]["type"],
            "tool_result"
        );
        request.api_type = ProviderApiType::GoogleGenerateContent;
        assert_eq!(
            request.body()["contents"][0]["parts"][0]["functionCall"]["name"],
            "lookup"
        );
        assert_eq!(
            request.body()["contents"][1]["parts"][0]["functionResponse"]["name"],
            "lookup"
        );
    }
}
