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
    if !prepared.response.status().is_success() {
        let status = prepared.response.status().as_u16();
        if request.native_search_enabled() && matches!(status, 400 | 404 | 405 | 415 | 422 | 501) {
            // Hosted tools are entitlement/model dependent. Retry once with
            // the always-available Exa function tool instead of failing the
            // entire agent turn when a gateway rejects the native tool.
            let mut fallback = request.clone();
            fallback.search_priority = vec!["exa".into()];
            return stream_request_with_request(&fallback, channel, token, client).await;
        }
    }
    stream_prepared(request, channel, token, prepared).await
}

async fn stream_request_with_request(
    request: &AiTextRequest,
    channel: &Channel<AiStreamEvent>,
    token: &CancellationToken,
    client: reqwest::Client,
) -> Result<(), String> {
    let prepared = tokio::select! {
        _ = token.cancelled() => {
            send(channel, AiStreamEvent::Cancelled)?;
            return Ok(());
        }
        response = transport::send_request(&client, request) => response?,
    };
    stream_prepared(request, channel, token, prepared).await
}

async fn stream_prepared(
    request: &AiTextRequest,
    channel: &Channel<AiStreamEvent>,
    token: &CancellationToken,
    prepared: transport::AiHttpResponse,
) -> Result<(), String> {
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
    use super::types::{AiInputMessage, AiTextRequest, AiToolDefinition, ProviderApiType};
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

    #[test]
    fn codex_responses_omit_unsupported_sampling_and_output_cap() {
        let mut request = sample_request();
        request.provider = "codex".into();
        request.api_type = ProviderApiType::OpenaiResponses;
        request.temperature = Some(1.0);
        request.top_p = Some(1.0);

        let body = request.body();
        assert!(body.get("max_output_tokens").is_none());
        assert!(body.get("temperature").is_none());
        assert!(body.get("top_p").is_none());
    }

    #[test]
    fn stateless_responses_disable_storage_and_include_encrypted_reasoning() {
        for provider in ["openai", "codex", "github-copilot"] {
            let mut request = sample_request();
            request.provider = provider.into();
            request.api_type = ProviderApiType::OpenaiResponses;
            request.reasoning_effort = Some("medium".into());

            let body = request.body();
            assert_eq!(body["store"], false, "provider={provider}");
            assert_eq!(
                body["include"][0], "reasoning.encrypted_content",
                "provider={provider}"
            );
        }
    }

    #[test]
    fn codex_reasoning_context_is_gated_by_model_generation() {
        let mut request = sample_request();
        request.provider = "codex".into();
        request.api_type = ProviderApiType::OpenaiResponses;
        request.reasoning_effort = Some("medium".into());

        request.model = "gpt-5.4".into();
        assert_eq!(request.body()["reasoning"]["context"], "all_turns");

        request.model = "gpt-5.3-codex-spark".into();
        assert!(request.body()["reasoning"].get("context").is_none());
        assert!(request.body()["reasoning"].get("summary").is_none());
    }

    #[test]
    fn latest_anthropic_models_use_adaptive_thinking() {
        for model in ["claude-opus-5", "claude-sonnet-5"] {
            let mut request = sample_request();
            request.provider = "anthropic".into();
            request.api_type = ProviderApiType::AnthropicMessages;
            request.model = model.into();
            request.thinking_enabled = Some(true);
            request.anthropic_thinking_effort = Some("medium".into());

            assert_eq!(request.body()["thinking"]["type"], "adaptive");
        }

        let mut request = sample_request();
        request.provider = "anthropic".into();
        request.api_type = ProviderApiType::AnthropicMessages;
        request.model = "claude-mythos-5".into();
        request.thinking_enabled = Some(false);
        assert_eq!(request.body()["thinking"]["type"], "adaptive");
    }

    #[test]
    fn opencode_deepseek_v4_uses_native_thinking_wire_format() {
        let mut request = sample_request();
        request.provider = "opencode".into();
        request.api_type = ProviderApiType::OpenaiChat;
        request.model = "deepseek-v4-flash".into();
        request.reasoning_effort = Some("high".into());

        let body = request.body();
        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["reasoning_effort"], "high");
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
            search_priority: Vec::new(),
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
        let mut request = sample_request();
        request.messages = vec![
            AiInputMessage {
                role: "user".into(),
                content: json!("first"),
                attribution: None,
                responses_items: Vec::new(),
            },
            AiInputMessage {
                role: "assistant".into(),
                content: json!("second"),
                attribution: None,
                responses_items: Vec::new(),
            },
            AiInputMessage {
                role: "user".into(),
                content: json!("third"),
                attribution: None,
                responses_items: Vec::new(),
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
    fn native_search_is_selected_by_provider_and_priority() {
        let mut request = sample_request();
        request.provider = "openai".into();
        request.api_type = ProviderApiType::OpenaiResponses;
        assert_eq!(request.body()["tools"][0]["type"], "web_search");

        request.provider = "anthropic".into();
        request.api_type = ProviderApiType::AnthropicMessages;
        assert_eq!(request.body()["tools"][0]["type"], "web_search_20250305");

        request.provider = "google".into();
        request.api_type = ProviderApiType::GoogleGenerateContent;
        request.model = "gemini-3.6-flash".into();
        assert!(request.body()["tools"][0].get("google_search").is_some());
        assert!(request.body().get("toolConfig").is_none());
        request.tools.push(AiToolDefinition {
            name: "lookup".into(),
            description: "A custom tool".into(),
            input_schema: json!({ "type": "object" }),
        });
        assert_eq!(
            request.body()["toolConfig"]["includeServerSideToolInvocations"],
            true
        );

        request.model = "gemini-2.5-flash".into();
        request.tools.clear();
        assert!(request.native_search_tool().is_some());
        assert!(request.body().get("toolConfig").is_none());
        request.tools.push(AiToolDefinition {
            name: "lookup".into(),
            description: "A custom tool".into(),
            input_schema: json!({ "type": "object" }),
        });
        assert!(request.native_search_tool().is_none());
    }

    #[test]
    fn native_search_hides_the_exa_function_from_provider_tools() {
        let mut request = sample_request();
        request.tools = vec![
            AiToolDefinition {
                name: "webSearch".into(),
                description: "Exa fallback".into(),
                input_schema: json!({ "type": "object" }),
            },
            AiToolDefinition {
                name: "lookup".into(),
                description: "A custom tool".into(),
                input_schema: json!({ "type": "object" }),
            },
        ];

        request.provider = "openai".into();
        request.api_type = ProviderApiType::OpenaiResponses;
        let body = request.body();
        assert_eq!(body["tools"].as_array().unwrap().len(), 2);
        assert_eq!(body["tools"][0]["name"], "lookup");
        assert_eq!(body["tools"][1]["type"], "web_search");

        request.provider = "anthropic".into();
        request.api_type = ProviderApiType::AnthropicMessages;
        let body = request.body();
        assert_eq!(body["tools"].as_array().unwrap().len(), 2);
        assert_eq!(body["tools"][0]["type"], "web_search_20250305");
        assert_eq!(body["tools"][1]["name"], "lookup");

        request.provider = "google".into();
        request.api_type = ProviderApiType::GoogleGenerateContent;
        request.model = "gemini-3.6-flash".into();
        let body = request.body();
        assert_eq!(body["tools"].as_array().unwrap().len(), 2);
        assert!(body["tools"][0].get("google_search").is_some());
        assert_eq!(
            body["tools"][1]["functionDeclarations"][0]["name"],
            "lookup"
        );
    }

    #[test]
    fn openai_chat_search_model_uses_native_search_options() {
        let mut request = sample_request();
        request.provider = "openai".into();
        request.api_type = ProviderApiType::OpenaiChat;
        request.model = "gpt-5-search-api".into();

        let body = request.body();
        assert_eq!(body["web_search_options"], json!({}));
        assert!(body.get("tools").is_none());
        assert!(request.native_search_enabled());

        request.tools.push(AiToolDefinition {
            name: "lookup".into(),
            description: "A custom tool".into(),
            input_schema: json!({ "type": "object" }),
        });
        let body = request.body();
        assert!(body.get("web_search_options").is_none());
        assert_eq!(body["tools"][0]["function"]["name"], "lookup");
        assert!(!request.native_search_enabled());
    }

    #[test]
    fn explicit_exa_tool_choice_keeps_the_fallback_function() {
        let mut request = sample_request();
        request.provider = "openai".into();
        request.api_type = ProviderApiType::OpenaiResponses;
        request.tools = vec![AiToolDefinition {
            name: "webSearch".into(),
            description: "Exa fallback".into(),
            input_schema: json!({ "type": "object" }),
        }];
        request.tool_choice_name = Some("webSearch".into());

        let body = request.body();
        assert_eq!(body["tools"][0]["name"], "webSearch");
        assert_eq!(body["tool_choice"]["name"], "webSearch");
        assert!(request.native_search_tool().is_none());
    }

    #[test]
    fn search_priority_can_disable_native_search_and_codex_is_not_assumed_compatible() {
        let mut request = sample_request();
        request.provider = "openai".into();
        request.api_type = ProviderApiType::OpenaiResponses;
        request.search_priority = vec!["exa".into(), "openai-web-search".into()];
        assert!(request.body().get("tools").is_none());

        request.provider = "codex".into();
        request.search_priority = vec!["openai-web-search".into(), "exa".into()];
        assert!(request.native_search_tool().is_none());
    }

    #[test]
    fn google_server_tool_parts_are_replayed_in_history() {
        let mut request = sample_request();
        request.provider = "google".into();
        request.api_type = ProviderApiType::GoogleGenerateContent;
        request.model = "gemini-3.6-flash".into();
        request.messages = vec![AiInputMessage {
            role: "assistant".into(),
            content: json!([{
                "type": "google-server-part",
                "part": {
                    "toolResponse": {
                        "toolType": "GOOGLE_SEARCH_WEB",
                        "id": "search-1"
                    },
                    "thoughtSignature": "opaque"
                }
            }]),
            attribution: None,
            responses_items: Vec::new(),
        }];

        let parts = &request.body()["contents"][0]["parts"];
        assert_eq!(parts[0]["toolResponse"]["toolType"], "GOOGLE_SEARCH_WEB");
        assert_eq!(parts[0]["thoughtSignature"], "opaque");
    }

    #[test]
    fn hosted_search_context_is_replayed_for_stateless_and_anthropic_turns() {
        let mut request = sample_request();
        request.messages = vec![AiInputMessage {
            role: "assistant".into(),
            content: json!([
                {
                    "type": "anthropic-server-block",
                    "block": {
                        "type": "server_tool_use",
                        "id": "srv-1",
                        "name": "web_search",
                        "input": { "query": "latest" }
                    }
                }
            ]),
            attribution: None,
            responses_items: vec![json!({
                "type": "web_search_call",
                "id": "ws-1",
                "status": "completed"
            })],
        }];

        request.api_type = ProviderApiType::OpenaiResponses;
        let body = request.body();
        assert_eq!(body["input"][0]["type"], "web_search_call");
        assert_eq!(body["input"][0]["id"], "ws-1");

        request.provider = "anthropic".into();
        request.api_type = ProviderApiType::AnthropicMessages;
        let body = request.body();
        assert_eq!(body["messages"][0]["content"][0]["type"], "server_tool_use");
        assert_eq!(body["messages"][0]["content"][0]["id"], "srv-1");
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
        let mut request = sample_request();
        request.messages = vec![
            AiInputMessage {
                role: "assistant".into(),
                content: json!([{ "type": "tool-call", "toolCallId": "call-1", "toolName": "lookup", "input": { "id": "42" } }]),
                attribution: None,
                responses_items: Vec::new(),
            },
            AiInputMessage {
                role: "tool".into(),
                content: json!([{ "type": "tool-result", "toolCallId": "call-1", "toolName": "lookup", "output": { "type": "json", "value": { "name": "answer" } } }]),
                attribution: None,
                responses_items: Vec::new(),
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

    #[test]
    fn openai_chat_replays_reasoning_content_with_tool_calls() {
        let mut request = sample_request();
        request.provider = "deepseek".into();
        request.api_type = ProviderApiType::OpenaiChat;
        request.messages = vec![AiInputMessage {
            role: "assistant".into(),
            content: json!([
                { "type": "reasoning", "text": "first think, then call" },
                { "type": "tool-call", "toolCallId": "call-1", "toolName": "lookup", "input": { "id": "42" } }
            ]),
            attribution: None,
            responses_items: Vec::new(),
        }];

        let assistant = &request.body()["messages"][0];
        assert_eq!(assistant["reasoning_content"], "first think, then call");
        assert_eq!(assistant["tool_calls"][0]["id"], "call-1");
    }

    #[test]
    fn anthropic_thinking_block_is_replayed_with_its_signature() {
        let mut request = sample_request();
        request.provider = "anthropic".into();
        request.api_type = ProviderApiType::AnthropicMessages;
        request.messages = vec![AiInputMessage {
            role: "assistant".into(),
            content: json!([
                {
                    "type": "anthropic-thinking-block",
                    "block": {
                        "type": "thinking",
                        "thinking": "private reasoning",
                        "signature": "opaque-signature"
                    }
                },
                { "type": "text", "text": "answer" }
            ]),
            attribution: None,
            responses_items: Vec::new(),
        }];

        let content = &request.body()["messages"][0]["content"];
        assert_eq!(content[0]["type"], "thinking");
        assert_eq!(content[0]["signature"], "opaque-signature");
        assert_eq!(content[1]["text"], "answer");
    }

    #[test]
    fn google_function_part_replays_thought_signature_without_duplicate_call() {
        let mut request = sample_request();
        request.provider = "google".into();
        request.api_type = ProviderApiType::GoogleGenerateContent;
        request.model = "gemini-3.6-flash".into();
        request.messages = vec![AiInputMessage {
            role: "assistant".into(),
            content: json!([
                {
                    "type": "google-server-part",
                    "part": {
                        "functionCall": {
                            "name": "lookup",
                            "args": { "id": "42" }
                        },
                        "thoughtSignature": "opaque-signature"
                    }
                },
                { "type": "tool-call", "toolCallId": "call-1", "toolName": "lookup", "input": { "id": "42" } }
            ]),
            attribution: None,
            responses_items: Vec::new(),
        }];

        let parts = &request.body()["contents"][0]["parts"];
        assert_eq!(parts.as_array().unwrap().len(), 1);
        assert_eq!(parts[0]["functionCall"]["name"], "lookup");
        assert_eq!(parts[0]["thoughtSignature"], "opaque-signature");
    }

    #[test]
    fn responses_replay_opaque_reasoning_before_assistant_content() {
        let mut request = sample_request();
        request.api_type = ProviderApiType::OpenaiResponses;
        request.provider = "codex".into();
        request.messages = vec![AiInputMessage {
            role: "assistant".into(),
            content: json!("answer"),
            attribution: None,
            responses_items: vec![json!({
                "type": "reasoning",
                "id": "rs_response_local",
                "encrypted_content": "opaque-reasoning"
            })],
        }];

        let input = &request.body()["input"];
        assert_eq!(input[0]["type"], "reasoning");
        assert_eq!(input[0]["encrypted_content"], "opaque-reasoning");
        assert!(input[0].get("id").is_none());
        assert_eq!(input[1]["role"], "assistant");
    }
}
