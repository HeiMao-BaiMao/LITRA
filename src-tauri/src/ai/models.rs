use std::{fs, path::Path, time::Duration};

use reqwest::{header, Client, RequestBuilder, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub(crate) id: String,
    pub(crate) model_picker_enabled: Option<bool>,
    pub(crate) endpoint: Option<String>,
    pub(crate) reasoning_effort: Option<Vec<String>>,
    pub(crate) adaptive_thinking: Option<bool>,
    pub(crate) min_thinking_budget: Option<u64>,
    pub(crate) max_thinking_budget: Option<u64>,
    pub(crate) max_output_tokens: Option<u64>,
    pub(crate) max_prompt_tokens: Option<u64>,
    pub(crate) supports_tool_calls: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
struct ModelCatalogCache {
    #[serde(default)]
    entries: Vec<ModelCatalogCacheEntry>,
}

#[derive(Debug, Deserialize, Serialize)]
struct ModelCatalogCacheEntry {
    provider: String,
    base_url: String,
    models: Vec<ModelInfo>,
}

#[derive(Debug)]
struct CopilotModelList {
    base_url: String,
    models: Vec<ModelInfo>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CopilotCredential {
    token: String,
    enterprise_url: Option<String>,
    api_endpoint: Option<String>,
}

#[tauri::command]
pub async fn ai_list_models(
    app: AppHandle,
    request: ModelListRequest,
) -> Result<Vec<ModelInfo>, String> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(MODEL_FETCH_TIMEOUT)
        .build()
        .map_err(|error| format!("モデル一覧クライアントの初期化に失敗しました: {error}"))?;
    let (models, cache_base_url) = match request.provider.as_str() {
        "codex" => return Err(
            "Codex は通常の OpenAI /models API に対応していないため、固定カタログを使用します。"
                .into(),
        ),
        "anthropic" => (list_anthropic(&client, &request).await?, None),
        "google" => (list_google(&client, &request).await?, None),
        "github-copilot" => {
            let list = list_copilot(&client).await?;
            (list.models, Some(list.base_url))
        }
        _ => (list_openai_compatible(&client, &request).await?, None),
    };
    if let Some(base_url) = cache_base_url {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("モデル一覧キャッシュの保存先を取得できません: {error}"))?;
        write_model_cache(&app_data_dir, &request.provider, &base_url, &models)?;
    }
    Ok(models)
}

async fn list_openai_compatible(
    client: &Client,
    request: &ModelListRequest,
) -> Result<Vec<ModelInfo>, String> {
    let endpoint = append_endpoint(&request.base_url, "/models");
    let mut result = Vec::new();
    let mut after: Option<String> = None;
    for _ in 0..10 {
        let mut builder = client.get(&endpoint).query(&[("limit", "1000")]);
        if let Some(after) = after.as_deref() {
            builder = builder.query(&[("after", after)]);
        }
        if !request.api_key.trim().is_empty() {
            builder = builder.bearer_auth(&request.api_key);
        }
        let value = send_json(builder, &endpoint).await?;
        result.extend(
            value
                .get("data")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|model| is_usable_openai_compatible_model(model))
                .filter_map(|model| model.get("id").and_then(Value::as_str))
                .map(str::to_owned),
        );
        let has_more = value.get("has_more").and_then(Value::as_bool) == Some(true);
        let next = value
            .get("last_id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_owned);
        if !has_more || next.is_none() || next == after {
            break;
        }
        after = next;
    }
    result.sort();
    result.dedup();
    Ok(result.into_iter().map(basic_model).collect())
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
    let mut ids = Vec::new();
    let mut after_id: Option<String> = None;
    for _ in 0..10 {
        let mut builder = client
            .get(&endpoint)
            .query(&[("limit", "1000")])
            .header("x-api-key", &request.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION);
        if let Some(after_id) = after_id.as_deref() {
            builder = builder.query(&[("after_id", after_id)]);
        }
        let value = send_json(builder, &endpoint).await?;
        ids.extend(model_ids(&value));
        let has_more = value.get("has_more").and_then(Value::as_bool) == Some(true);
        let next = value
            .get("last_id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_owned);
        if !has_more || next.is_none() || next == after_id {
            break;
        }
        after_id = next;
    }
    ids.sort();
    ids.dedup();
    Ok(ids.into_iter().map(basic_model).collect())
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
            if supports_google_generate_content(model) {
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

async fn list_copilot(client: &Client) -> Result<CopilotModelList, String> {
    let credential = store::read_json::<CopilotCredential>("github-copilot")
        .await?
        .ok_or_else(|| "GitHub Copilot にログインしていません。".to_string())?;
    if credential.token.trim().is_empty() {
        return Err("GitHub Copilot の資格情報が無効です。再ログインしてください。".into());
    }
    let base = credential
        .api_endpoint
        .as_deref()
        .and_then(normalize_copilot_api_endpoint)
        .unwrap_or_else(|| copilot_base_url(credential.enterprise_url.as_deref()));
    let endpoint = format!("{base}/models");
    let value = send_json(
        client
            .get(&endpoint)
            .bearer_auth(&credential.token)
            .header(header::USER_AGENT, "litra/1.0")
            .header("X-GitHub-Api-Version", COPILOT_API_VERSION)
            .header("Openai-Intent", "conversation-edits")
            .header("x-initiator", "user"),
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
        if let Some(model) = parse_copilot_model(item) {
            result.push(model);
        }
    }
    Ok(CopilotModelList {
        base_url: base,
        models: result,
    })
}

fn parse_copilot_model(item: &Value) -> Option<ModelInfo> {
    let id = item.get("id").and_then(Value::as_str)?;
    let model_picker_enabled = item.get("model_picker_enabled").and_then(Value::as_bool)?;
    if item.pointer("/policy/state").and_then(Value::as_str) == Some("disabled") {
        return None;
    }
    let endpoints = item.get("supported_endpoints").and_then(Value::as_array);
    let endpoint = if contains_string(endpoints, "/v1/messages") {
        Some("messages")
    } else if contains_string(endpoints, "/responses") {
        Some("responses")
    } else if contains_string(endpoints, "/chat/completions") {
        Some("chat")
    } else {
        None
    };
    let limits = item.pointer("/capabilities/limits")?;
    let max_output_tokens = limits.get("max_output_tokens").and_then(Value::as_u64)?;
    let max_prompt_tokens = limits.get("max_prompt_tokens").and_then(Value::as_u64)?;
    let supports_tool_calls = item
        .pointer("/capabilities/supports/tool_calls")
        .and_then(Value::as_bool)?;
    Some(ModelInfo {
        id: id.into(),
        model_picker_enabled: Some(model_picker_enabled),
        endpoint: endpoint.map(str::to_owned),
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
        max_output_tokens: Some(max_output_tokens),
        max_prompt_tokens: Some(max_prompt_tokens),
        supports_tool_calls: Some(supports_tool_calls),
    })
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
        model_picker_enabled: None,
        endpoint: None,
        reasoning_effort: None,
        adaptive_thinking: None,
        min_thinking_budget: None,
        max_thinking_budget: None,
        max_output_tokens: None,
        max_prompt_tokens: None,
        supports_tool_calls: None,
    }
}

fn is_usable_openai_compatible_model(model: &Value) -> bool {
    if model
        .get("capabilities")
        .and_then(|capabilities| capabilities.get("chat_completion"))
        .and_then(Value::as_bool)
        == Some(false)
    {
        return false;
    }
    let Some(id) = model.get("id").and_then(Value::as_str) else {
        return false;
    };
    let id = id.to_ascii_lowercase();
    ![
        "embedding",
        "moderation",
        "whisper",
        "tts",
        "dall-e",
        "transcription",
        "babbage",
        "davinci",
    ]
    .iter()
    .any(|marker| id.contains(marker))
}

fn supports_google_generate_content(model: &Value) -> bool {
    model
        .get("supportedGenerationMethods")
        .and_then(Value::as_array)
        .is_some_and(|methods| methods.iter().any(|method| method == "generateContent"))
}

fn cache_key(provider: &str, base_url: &str) -> String {
    format!("{provider}|{}", normalize_catalog_base(base_url))
}

pub(crate) fn copilot_base_url(enterprise_url: Option<&str>) -> String {
    let Some(host) = enterprise_url.and_then(normalize_copilot_domain) else {
        return "https://api.githubcopilot.com".to_owned();
    };
    if matches!(
        host.as_str(),
        "github.com" | "www.github.com" | "api.github.com"
    ) {
        return "https://api.githubcopilot.com".to_owned();
    }
    if host.starts_with("copilot-api.") {
        format!("https://{host}")
    } else {
        format!("https://copilot-api.{host}")
    }
}

pub(crate) fn normalize_copilot_api_endpoint(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let url = Url::parse(trimmed).ok()?;
    if url.scheme() != "https" || url.host_str().is_none() {
        return None;
    }
    Some(trimmed.trim_end_matches('/').to_owned())
}

fn normalize_copilot_domain(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_owned()
    } else {
        format!("https://{trimmed}")
    };
    Url::parse(&candidate)
        .ok()?
        .host_str()
        .map(|host| host.to_ascii_lowercase())
}

fn normalize_catalog_base(base_url: &str) -> String {
    let mut base = base_url.trim().trim_end_matches('/').to_owned();
    for suffix in ["/v1/messages", "/chat/completions", "/responses", "/v1"] {
        if base.ends_with(suffix) {
            base.truncate(base.len() - suffix.len());
            break;
        }
    }
    base.trim_end_matches('/').to_owned()
}

fn write_model_cache(
    app_data_dir: &Path,
    provider: &str,
    base_url: &str,
    models: &[ModelInfo],
) -> Result<(), String> {
    fs::create_dir_all(app_data_dir)
        .map_err(|error| format!("モデル一覧キャッシュの保存に失敗しました: {error}"))?;
    let path = app_data_dir.join("ai-model-catalog.json");
    let mut cache = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<ModelCatalogCache>(&text).ok())
        .unwrap_or(ModelCatalogCache {
            entries: Vec::new(),
        });
    let key = cache_key(provider, base_url);
    cache
        .entries
        .retain(|entry| cache_key(&entry.provider, &entry.base_url) != key);
    cache.entries.push(ModelCatalogCacheEntry {
        provider: provider.to_owned(),
        base_url: normalize_catalog_base(base_url),
        models: models.to_vec(),
    });
    let text = serde_json::to_string_pretty(&cache)
        .map_err(|error| format!("モデル一覧キャッシュのシリアライズに失敗しました: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, text)
        .map_err(|error| format!("モデル一覧キャッシュの保存に失敗しました: {error}"))?;
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|error| format!("古いモデル一覧キャッシュを置換できません: {error}"))?;
    }
    fs::rename(&temporary, &path)
        .map_err(|error| format!("モデル一覧キャッシュの保存に失敗しました: {error}"))
}

pub(crate) fn cached_copilot_model(
    app_data_dir: &Path,
    base_url: &str,
    model_id: &str,
) -> Option<ModelInfo> {
    cached_copilot_models(app_data_dir, base_url)
        .into_iter()
        .find(|model| model.id == model_id)
}

pub(crate) fn cached_copilot_models(app_data_dir: &Path, base_url: &str) -> Vec<ModelInfo> {
    cached_copilot_entry(app_data_dir, base_url)
        .map(|entry| entry.models)
        .unwrap_or_default()
}

pub(crate) fn has_cached_copilot_models(app_data_dir: &Path, base_url: &str) -> bool {
    cached_copilot_entry(app_data_dir, base_url).is_some()
}

fn cached_copilot_entry(app_data_dir: &Path, base_url: &str) -> Option<ModelCatalogCacheEntry> {
    let path = app_data_dir.join("ai-model-catalog.json");
    let cache = fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<ModelCatalogCache>(&text).ok())?;
    cache.entries.into_iter().find(|entry| {
        entry.provider == "github-copilot"
            && cache_key(&entry.provider, &entry.base_url) == cache_key("github-copilot", base_url)
    })
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

    #[test]
    fn openai_compatible_listing_excludes_non_chat_models() {
        assert!(is_usable_openai_compatible_model(&serde_json::json!({
            "id": "gpt-5"
        })));
        assert!(!is_usable_openai_compatible_model(&serde_json::json!({
            "id": "text-embedding-3-small"
        })));
        assert!(!is_usable_openai_compatible_model(&serde_json::json!({
            "id": "custom", "capabilities": {"chat_completion": false}
        })));
    }

    #[test]
    fn copilot_listing_requires_usable_capabilities_and_preserves_protocol() {
        let model = serde_json::json!({
            "id": "claude-sonnet",
            "model_picker_enabled": true,
            "supported_endpoints": ["/v1/messages", "/responses"],
            "capabilities": {
                "limits": {"max_output_tokens": 64000, "max_prompt_tokens": 200000},
                "supports": {"tool_calls": true, "adaptive_thinking": true}
            }
        });
        let parsed = parse_copilot_model(&model).expect("usable Copilot model");
        assert_eq!(parsed.model_picker_enabled, Some(true));
        assert_eq!(parsed.endpoint.as_deref(), Some("messages"));
        assert_eq!(parsed.max_output_tokens, Some(64000));
        assert_eq!(parsed.max_prompt_tokens, Some(200000));

        let unusable = serde_json::json!({
            "id": "no-tools",
            "model_picker_enabled": true,
            "supported_endpoints": ["/responses"],
            "capabilities": {
                "limits": {"max_output_tokens": 64000},
                "supports": {"tool_calls": true}
            }
        });
        assert!(parse_copilot_model(&unusable).is_none());

        let default_endpoint = serde_json::json!({
            "id": "default-endpoint",
            "model_picker_enabled": false,
            "capabilities": {
                "limits": {"max_output_tokens": 64000, "max_prompt_tokens": 200000},
                "supports": {"tool_calls": false}
            }
        });
        let parsed = parse_copilot_model(&default_endpoint).expect("usable default-endpoint model");
        assert_eq!(parsed.model_picker_enabled, Some(false));
        assert_eq!(parsed.endpoint, None);

        let missing_picker_flag = serde_json::json!({
            "id": "missing-picker-flag",
            "capabilities": {
                "limits": {"max_output_tokens": 64000, "max_prompt_tokens": 200000},
                "supports": {"tool_calls": true}
            }
        });
        assert!(parse_copilot_model(&missing_picker_flag).is_none());
    }

    #[test]
    fn google_listing_requires_generate_content_capability() {
        assert!(supports_google_generate_content(&serde_json::json!({
            "supportedGenerationMethods": ["generateContent"]
        })));
        assert!(!supports_google_generate_content(&serde_json::json!({
            "name": "models/unknown"
        })));
    }

    #[test]
    fn copilot_base_url_supports_enterprise_hosts() {
        assert_eq!(
            copilot_base_url(Some("https://github.example/")),
            "https://copilot-api.github.example"
        );
        assert_eq!(
            copilot_base_url(Some("copilot-api.github.example")),
            "https://copilot-api.github.example"
        );
        assert_eq!(
            copilot_base_url(Some("https://github.com")),
            "https://api.githubcopilot.com"
        );
        assert_eq!(copilot_base_url(None), "https://api.githubcopilot.com");
        assert_eq!(
            normalize_copilot_api_endpoint("https://api.business.githubcopilot.com/"),
            Some("https://api.business.githubcopilot.com".into())
        );
        assert_eq!(
            normalize_copilot_api_endpoint("http://insecure.example"),
            None
        );
    }
}
