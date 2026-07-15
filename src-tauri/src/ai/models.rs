use std::time::Duration;

use reqwest::{header, Client, RequestBuilder};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::auth::store;

const MODEL_FETCH_TIMEOUT: Duration = Duration::from_secs(15);
const ANTHROPIC_VERSION: &str = "2023-06-01";
const COPILOT_API_VERSION: &str = "2026-06-01";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelListRequest {
    provider: String,
    #[serde(default)]
    api_key: String,
    base_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    id: String,
    endpoint: Option<String>,
    reasoning_effort: Option<Vec<String>>,
    adaptive_thinking: Option<bool>,
    min_thinking_budget: Option<u64>,
    max_thinking_budget: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CopilotCredential {
    token: String,
    enterprise_url: Option<String>,
}

#[tauri::command]
pub async fn ai_list_models(request: ModelListRequest) -> Result<Vec<ModelInfo>, String> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(MODEL_FETCH_TIMEOUT)
        .build()
        .map_err(|error| format!("モデル一覧クライアントの初期化に失敗しました: {error}"))?;
    match request.provider.as_str() {
        "anthropic" => list_anthropic(&client, &request).await,
        "google" => list_google(&client, &request).await,
        "github-copilot" => list_copilot(&client).await,
        _ => list_openai_compatible(&client, &request).await,
    }
}

async fn list_openai_compatible(
    client: &Client,
    request: &ModelListRequest,
) -> Result<Vec<ModelInfo>, String> {
    let endpoint = append_endpoint(&request.base_url, "/models");
    let mut builder = client.get(&endpoint);
    if !request.api_key.trim().is_empty() {
        builder = builder.bearer_auth(&request.api_key);
    }
    let value = send_json(builder, &endpoint).await?;
    Ok(model_ids(&value).into_iter().map(basic_model).collect())
}

async fn list_anthropic(
    client: &Client,
    request: &ModelListRequest,
) -> Result<Vec<ModelInfo>, String> {
    let suffix = if request.base_url.trim_end_matches('/').ends_with("/v1") {
        "/models"
    } else {
        "/v1/models"
    };
    let endpoint = append_endpoint(&request.base_url, suffix);
    let value = send_json(
        client
            .get(&endpoint)
            .header("x-api-key", &request.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION),
        &endpoint,
    )
    .await?;
    Ok(model_ids(&value).into_iter().map(basic_model).collect())
}

async fn list_google(
    client: &Client,
    request: &ModelListRequest,
) -> Result<Vec<ModelInfo>, String> {
    let endpoint = append_endpoint(&request.base_url, "/models");
    let mut page_token: Option<String> = None;
    let mut result = Vec::new();
    for _ in 0..10 {
        let mut builder = client
            .get(&endpoint)
            .header("x-goog-api-key", &request.api_key)
            .query(&[("pageSize", "1000")]);
        if let Some(token) = page_token.as_deref() {
            builder = builder.query(&[("pageToken", token)]);
        }
        let value = send_json(builder, &endpoint).await?;
        for model in value
            .get("models")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let supports_generate = model
                .get("supportedGenerationMethods")
                .and_then(Value::as_array)
                .is_none_or(|methods| methods.iter().any(|method| method == "generateContent"));
            if supports_generate {
                if let Some(id) = model.get("name").and_then(Value::as_str) {
                    result.push(basic_model(id.trim_start_matches("models/").to_owned()));
                }
            }
        }
        page_token = value
            .get("nextPageToken")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if page_token.is_none() {
            break;
        }
    }
    Ok(result)
}

async fn list_copilot(client: &Client) -> Result<Vec<ModelInfo>, String> {
    let credential = store::read_json::<CopilotCredential>("github-copilot")
        .await?
        .ok_or_else(|| "GitHub Copilot にログインしていません。".to_string())?;
    let base = credential.enterprise_url.as_deref().map_or_else(
        || "https://api.githubcopilot.com".to_owned(),
        |url| {
            format!(
                "https://copilot-api.{}",
                url.trim_end_matches('/')
                    .trim_start_matches("https://")
                    .trim_start_matches("http://")
            )
        },
    );
    let endpoint = format!("{base}/models");
    let value = send_json(
        client
            .get(&endpoint)
            .bearer_auth(&credential.token)
            .header(header::USER_AGENT, "litra/1.0")
            .header("X-GitHub-Api-Version", COPILOT_API_VERSION),
        &endpoint,
    )
    .await?;
    let mut result = Vec::new();
    for item in value
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        if item.pointer("/policy/state").and_then(Value::as_str) == Some("disabled")
            || item.get("model_picker_enabled").and_then(Value::as_bool) != Some(true)
        {
            continue;
        }
        let endpoints = item.get("supported_endpoints").and_then(Value::as_array);
        let endpoint = if contains_string(endpoints, "/v1/messages") {
            "messages"
        } else if contains_string(endpoints, "/responses") {
            "responses"
        } else {
            "chat"
        };
        result.push(ModelInfo {
            id: id.into(),
            endpoint: Some(endpoint.into()),
            reasoning_effort: strings_at(item, "/capabilities/supports/reasoning_effort"),
            adaptive_thinking: item
                .pointer("/capabilities/supports/adaptive_thinking")
                .and_then(Value::as_bool),
            min_thinking_budget: item
                .pointer("/capabilities/supports/min_thinking_budget")
                .and_then(Value::as_u64),
            max_thinking_budget: item
                .pointer("/capabilities/supports/max_thinking_budget")
                .and_then(Value::as_u64),
        });
    }
    Ok(result)
}

async fn send_json(builder: RequestBuilder, endpoint: &str) -> Result<Value, String> {
    let response = builder
        .send()
        .await
        .map_err(|error| format!("モデル一覧の取得に失敗しました: {error}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "モデル一覧の取得に失敗しました ({status}): {}",
            text.chars().take(500).collect::<String>()
        ));
    }
    serde_json::from_str(&text)
        .map_err(|error| format!("モデル一覧の解析に失敗しました ({endpoint}): {error}"))
}

fn append_endpoint(base: &str, suffix: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    if base.ends_with(suffix) {
        base.into()
    } else {
        format!("{base}{suffix}")
    }
}

fn model_ids(value: &Value) -> Vec<String> {
    value
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| model.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect()
}

fn basic_model(id: String) -> ModelInfo {
    ModelInfo {
        id,
        endpoint: None,
        reasoning_effort: None,
        adaptive_thinking: None,
        min_thinking_budget: None,
        max_thinking_budget: None,
    }
}

fn contains_string(values: Option<&Vec<Value>>, expected: &str) -> bool {
    values.is_some_and(|values| values.iter().any(|value| value == expected))
}

fn strings_at(value: &Value, pointer: &str) -> Option<Vec<String>> {
    Some(
        value
            .pointer(pointer)?
            .as_array()?
            .iter()
            .filter_map(|item| item.as_str().map(str::to_owned))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_models_without_duplicating_it() {
        assert_eq!(
            append_endpoint("https://example.test/v1", "/models"),
            "https://example.test/v1/models"
        );
        assert_eq!(
            append_endpoint("https://example.test/v1/models", "/models"),
            "https://example.test/v1/models"
        );
    }
}
