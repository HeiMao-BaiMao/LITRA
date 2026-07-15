use std::fs;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

const DEFAULT_PROVIDERS: &str = include_str!("../../../src/providers/default-providers.json");

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Connection {
    id: String,
    api_type: String,
    base_url: String,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Model {
    id: String,
    connection: Option<String>,
    temperature: Option<f64>,
    max_tokens: Option<u64>,
    top_p: Option<f64>,
    top_k: Option<u64>,
    frequency_penalty: Option<f64>,
    presence_penalty: Option<f64>,
    openai_reasoning_effort: Option<String>,
    deepseek_reasoning_effort: Option<String>,
    anthropic_thinking_enabled: Option<bool>,
    anthropic_thinking_budget: Option<u64>,
    anthropic_thinking_effort: Option<String>,
    google_thinking_level: Option<String>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Provider {
    id: String,
    sdk_type: String,
    default_base_url: String,
    default_model: String,
    default_connection: Option<String>,
    #[serde(default)]
    connections: Vec<Connection>,
    #[serde(default)]
    models: Vec<Model>,
}

#[derive(Default, Deserialize)]
struct ProviderDocument {
    #[serde(default)]
    providers: Vec<Provider>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeAiConfig {
    provider: String,
    api_type: String,
    api_key: String,
    base_url: String,
    model: String,
    max_output_tokens: u64,
    temperature: Option<f64>,
    top_p: Option<f64>,
    top_k: Option<u64>,
    frequency_penalty: Option<f64>,
    presence_penalty: Option<f64>,
    reasoning_effort: Option<String>,
    thinking_enabled: Option<bool>,
    thinking_budget: Option<u64>,
    anthropic_thinking_effort: Option<String>,
    thinking_level: Option<String>,
}

#[tauri::command]
pub fn ai_runtime_config(app: AppHandle, role: Option<String>) -> Result<RuntimeAiConfig, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let app_config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    let settings = read_json(app_data_dir.join("litra-settings.json"))
        .unwrap_or_else(|| Value::Object(Default::default()));
    let defaults: ProviderDocument = serde_json::from_str(DEFAULT_PROVIDERS)
        .map_err(|error| format!("Default provider config is invalid: {error}"))?;
    let configured = read_json(app_config_dir.join("providers.json"))
        .and_then(|value| serde_json::from_value::<ProviderDocument>(value).ok())
        .unwrap_or_default();

    let role = role.as_deref().unwrap_or("main");
    let main_provider = string(&settings, "provider").unwrap_or("openai");
    let provider_id = match role {
        "chat" => string(&settings, "chatProvider").unwrap_or(main_provider),
        "background" => string(&settings, "backgroundProvider")
            .or_else(|| string(&settings, "chatProvider"))
            .unwrap_or(main_provider),
        _ => main_provider,
    };
    let fallback = defaults
        .providers
        .iter()
        .find(|item| item.id == provider_id);
    let provider = configured
        .providers
        .iter()
        .find(|item| item.id == provider_id)
        .or(fallback)
        .ok_or_else(|| format!("AI provider is not configured: {provider_id}"))?;
    let specific = settings
        .get("providerConfigs")
        .and_then(|value| value.get(provider_id));
    let specific_model = specific
        .and_then(|value| string(value, "model"))
        .map(str::to_owned);
    let role_model = match role {
        "chat" => string(&settings, "chatModel").map(str::to_owned),
        "background" => string(&settings, "backgroundModel")
            .or_else(|| string(&settings, "chatModel"))
            .map(str::to_owned),
        _ => None,
    };
    let provider_default_model = if provider.default_model.trim().is_empty() {
        fallback.map(|item| item.default_model.clone()).unwrap_or_default()
    } else {
        provider.default_model.clone()
    };
    let model_id = role_model
        .or(specific_model)
        .filter(|value| !value.is_empty())
        .unwrap_or(provider_default_model);
    let model = provider
        .models
        .iter()
        .find(|item| item.id == model_id)
        .or_else(|| {
            fallback.and_then(|item| item.models.iter().find(|model| model.id == model_id))
        });
    let connection_id = model
        .and_then(|item| item.connection.as_deref())
        .or(provider.default_connection.as_deref());
    let connection = connection_id
        .and_then(|id| provider.connections.iter().find(|item| item.id == id))
        .or_else(|| {
            connection_id.and_then(|id| {
                fallback.and_then(|item| {
                    item.connections
                        .iter()
                        .find(|connection| connection.id == id)
                })
            })
        })
        .or_else(|| provider.connections.first())
        .or_else(|| fallback.and_then(|item| item.connections.first()));
    let legacy_api_type = match provider.sdk_type.as_str() {
        "anthropic" => "anthropic-messages",
        "google" => "google-generate-content",
        _ => "openai-chat",
    };
    let configured_base = specific
        .and_then(|value| string(value, "baseUrl"))
        .filter(|value| !value.is_empty())
        .filter(|value| *value != provider.default_base_url.as_str())
        .map(str::to_owned);
    let base_url = configured_base.unwrap_or_else(|| {
        connection
            .map(|item| item.base_url.clone())
            .unwrap_or_else(|| {
                if provider.default_base_url.trim().is_empty() {
                    fallback.map(|item| item.default_base_url.clone()).unwrap_or_default()
                } else {
                    provider.default_base_url.clone()
                }
            })
    });
    let api_key = crate::secrets::get_secret(&format!("apikey:{provider_id}"))?.unwrap_or_default();
    let setting_number = |key: &str| settings.get(key).and_then(Value::as_f64);

    Ok(RuntimeAiConfig {
        provider: provider_id.into(),
        api_type: connection
            .map(|item| item.api_type.clone())
            .unwrap_or_else(|| legacy_api_type.into()),
        api_key,
        base_url,
        model: model_id,
        max_output_tokens: settings
            .get("maxTokens")
            .and_then(Value::as_u64)
            .or_else(|| model.and_then(|item| item.max_tokens))
            .unwrap_or(8192),
        temperature: setting_number("temperature")
            .or_else(|| model.and_then(|item| item.temperature)),
        top_p: setting_number("topP").or_else(|| model.and_then(|item| item.top_p)),
        top_k: settings
            .get("topK")
            .and_then(Value::as_u64)
            .or_else(|| model.and_then(|item| item.top_k)),
        frequency_penalty: setting_number("frequencyPenalty")
            .or_else(|| model.and_then(|item| item.frequency_penalty)),
        presence_penalty: setting_number("presencePenalty")
            .or_else(|| model.and_then(|item| item.presence_penalty)),
        reasoning_effort: string(&settings, "openaiReasoningEffort")
            .map(str::to_owned)
            .or_else(|| string(&settings, "deepseekReasoningEffort").map(str::to_owned))
            .or_else(|| {
                model.and_then(|item| {
                    item.openai_reasoning_effort
                        .clone()
                        .or(item.deepseek_reasoning_effort.clone())
                })
            }),
        thinking_enabled: settings
            .get("anthropicThinkingEnabled")
            .and_then(Value::as_bool)
            .or_else(|| model.and_then(|item| item.anthropic_thinking_enabled)),
        thinking_budget: settings
            .get("anthropicThinkingBudget")
            .and_then(Value::as_u64)
            .or_else(|| model.and_then(|item| item.anthropic_thinking_budget)),
        anthropic_thinking_effort: string(&settings, "anthropicThinkingEffort")
            .map(str::to_owned)
            .or_else(|| model.and_then(|item| item.anthropic_thinking_effort.clone())),
        thinking_level: string(&settings, "googleThinkingLevel")
            .map(str::to_owned)
            .or_else(|| model.and_then(|item| item.google_thinking_level.clone())),
    })
}

fn read_json(path: std::path::PathBuf) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
}

fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}
