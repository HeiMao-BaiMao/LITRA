use std::fs;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

const DEFAULT_PROVIDERS: &str = include_str!("../../../config/default-providers.json");

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Connection {
    id: String,
    api_type: String,
    base_url: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
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
    #[serde(default)]
    name: String,
    sdk_type: String,
    default_base_url: String,
    default_model: String,
    default_connection: Option<String>,
    #[serde(default)]
    connections: Vec<Connection>,
    /// Whether this provider requires an API key (defaults to true).
    #[serde(default = "default_requires_api_key")]
    requires_api_key: bool,
    #[serde(default)]
    models: Vec<Model>,
    #[serde(default)]
    model_selection: String,
}

fn default_requires_api_key() -> bool {
    true
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
pub fn ai_runtime_config(
    app: AppHandle,
    role: Option<String>,
    provider_override: Option<String>,
    model_override: Option<String>,
) -> Result<RuntimeAiConfig, String> {
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
    let chat_provider = string(&settings, "chatProvider").unwrap_or(main_provider);
    let background_provider = string(&settings, "backgroundProvider").unwrap_or(chat_provider);
    let (configured_provider_id, configured_role_model, role_overrides) = match role {
        "chat" => (
            chat_provider,
            string(&settings, "chatModel").map(str::to_owned),
            None,
        ),
        "background" => (
            background_provider,
            string(&settings, "backgroundModel")
                .or_else(|| string(&settings, "chatModel"))
                .map(str::to_owned),
            None,
        ),
        "writing" => match string(&settings, "writingModelSource").unwrap_or("main") {
            "background" => (
                background_provider,
                string(&settings, "backgroundModel")
                    .or_else(|| string(&settings, "chatModel"))
                    .map(str::to_owned),
                settings.get("writingOverrides"),
            ),
            "custom" => (
                string(&settings, "writingProvider").unwrap_or(main_provider),
                string(&settings, "writingModel").map(str::to_owned),
                settings.get("writingOverrides"),
            ),
            _ => (main_provider, None, settings.get("writingOverrides")),
        },
        "judgment" => match string(&settings, "judgmentModelSource").unwrap_or_else(|| {
            if settings
                .get("continuationUseBackgroundModel")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                "background"
            } else {
                "main"
            }
        }) {
            "background" => (
                background_provider,
                string(&settings, "backgroundModel")
                    .or_else(|| string(&settings, "chatModel"))
                    .map(str::to_owned),
                settings.get("judgmentOverrides"),
            ),
            "custom" => (
                string(&settings, "judgmentProvider").unwrap_or(main_provider),
                string(&settings, "judgmentModel").map(str::to_owned),
                settings.get("judgmentOverrides"),
            ),
            _ => (main_provider, None, settings.get("judgmentOverrides")),
        },
        _ => (main_provider, None, None),
    };
    let provider_id = provider_override
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(configured_provider_id);
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
    let provider_default_model = if provider.default_model.trim().is_empty() {
        fallback
            .map(|item| item.default_model.clone())
            .unwrap_or_default()
    } else {
        provider.default_model.clone()
    };
    let model_id = model_override
        .filter(|value| !value.trim().is_empty())
        .or(configured_role_model)
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
    let raw_base_url = configured_base.unwrap_or_else(|| {
        connection
            .map(|item| item.base_url.clone())
            .unwrap_or_else(|| {
                if provider.default_base_url.trim().is_empty() {
                    fallback
                        .map(|item| item.default_base_url.clone())
                        .unwrap_or_default()
                } else {
                    provider.default_base_url.clone()
                }
            })
    });
    // Connection safety: replace stale cross-provider official URLs.
    let base_url = resolve_provider_base_url(provider_id, &raw_base_url);
    let api_key = crate::secrets::get_secret(&format!("apikey:{provider_id}"))?.unwrap_or_default();
    let setting_number = |key: &str| settings.get(key).and_then(Value::as_f64);
    let role_number = |key: &str| role_overrides.and_then(|value| value.get(key)?.as_f64());

    // Provider capacity cap (ported from TS applyProviderCapacityCap):
    // OpenCode Go has strict usage limits – clamp max_output_tokens to the
    // model's declared maxTokens so we never exceed the provider's quota.
    let mut max_output_tokens = settings
        .get("maxTokens")
        .and_then(Value::as_u64)
        .or_else(|| model.and_then(|item| item.max_tokens))
        .unwrap_or(8192);
    if provider_id == "opencode" {
        if let Some(cap) = model.and_then(|item| item.max_tokens) {
            max_output_tokens = max_output_tokens.min(cap);
        }
    }

    Ok(RuntimeAiConfig {
        provider: provider_id.into(),
        api_type: connection
            .map(|item| item.api_type.clone())
            .unwrap_or_else(|| legacy_api_type.into()),
        api_key,
        base_url,
        model: model_id,
        max_output_tokens,
        temperature: role_number("temperature")
            .or_else(|| setting_number("temperature"))
            .or_else(|| model.and_then(|item| item.temperature)),
        top_p: role_number("topP")
            .or_else(|| setting_number("topP"))
            .or_else(|| model.and_then(|item| item.top_p)),
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
        thinking_enabled: role_overrides
            .and_then(|value| value.get("deepseekThinkingEnabled"))
            .and_then(Value::as_bool)
            .or_else(|| {
                if provider_id == "deepseek" {
                    settings
                        .get("deepseekThinkingEnabled")
                        .and_then(Value::as_bool)
                        .or(Some(true))
                } else {
                    settings
                        .get("anthropicThinkingEnabled")
                        .and_then(Value::as_bool)
                }
            })
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCatalogEntry {
    id: String,
    name: String,
    models: Vec<Model>,
    fixed_models: bool,
    requires_api_key: bool,
    default_base_url: String,
    default_model: String,
}

#[tauri::command]
pub fn ai_provider_catalog(app: AppHandle) -> Result<Vec<ProviderCatalogEntry>, String> {
    let defaults: ProviderDocument =
        serde_json::from_str(DEFAULT_PROVIDERS).map_err(|error| error.to_string())?;
    let configured = read_json(
        app.path()
            .app_config_dir()
            .map_err(|error| error.to_string())?
            .join("providers.json"),
    )
    .and_then(|value| serde_json::from_value::<ProviderDocument>(value).ok())
    .unwrap_or_default();
    let mut result = Vec::new();
    for default in &defaults.providers {
        let custom = configured
            .providers
            .iter()
            .find(|item| item.id == default.id);
        let mut models = default.models.clone();
        if let Some(custom) = custom {
            for model in &custom.models {
                if let Some(position) = models.iter().position(|item| item.id == model.id) {
                    models[position] = model.clone();
                } else {
                    models.push(model.clone());
                }
            }
        }
        result.push(ProviderCatalogEntry {
            id: default.id.clone(),
            name: custom
                .filter(|item| !item.name.is_empty())
                .map(|item| item.name.clone())
                .unwrap_or_else(|| default.name.clone()),
            models,
            fixed_models: custom
                .filter(|item| !item.model_selection.is_empty())
                .map(|item| item.model_selection.as_str())
                .unwrap_or(&default.model_selection)
                == "fixed",
            requires_api_key: custom
                .map(|item| item.requires_api_key)
                .unwrap_or(default.requires_api_key),
            default_base_url: custom
                .and_then(|item| {
                    (!item.default_base_url.is_empty()).then_some(item.default_base_url.clone())
                })
                .unwrap_or_else(|| default.default_base_url.clone()),
            default_model: custom
                .and_then(|item| {
                    (!item.default_model.is_empty()).then_some(item.default_model.clone())
                })
                .unwrap_or_else(|| default.default_model.clone()),
        });
    }
    for custom in configured.providers.iter().filter(|item| {
        !defaults
            .providers
            .iter()
            .any(|default| default.id == item.id)
    }) {
        result.push(ProviderCatalogEntry {
            id: custom.id.clone(),
            name: custom.name.clone(),
            models: custom.models.clone(),
            fixed_models: custom.model_selection == "fixed",
            requires_api_key: custom.requires_api_key,
            default_base_url: custom.default_base_url.clone(),
            default_model: custom.default_model.clone(),
        });
    }
    Ok(result)
}

#[tauri::command]
pub fn ai_settings_snapshot(app: AppHandle) -> Result<Value, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("litra-settings.json");
    let mut settings = read_json(path).unwrap_or_else(|| serde_json::json!({}));
    let provider = string(&settings, "provider").unwrap_or("openai").to_owned();
    let key = crate::secrets::get_secret(&format!("apikey:{provider}"))?.unwrap_or_default();
    let object = settings
        .as_object_mut()
        .ok_or_else(|| "Settings root must be an object".to_string())?;
    object.insert("apiKey".into(), Value::String(key));
    Ok(settings)
}

#[tauri::command]
pub fn ai_settings_save(app: AppHandle, mut settings: Value) -> Result<(), String> {
    let provider = string(&settings, "provider").unwrap_or("openai").to_owned();
    let api_key = string(&settings, "apiKey").unwrap_or_default().to_owned();
    crate::secrets::set_or_delete_secret(&format!("apikey:{provider}"), Some(&api_key))?;
    let object = settings
        .as_object_mut()
        .ok_or_else(|| "Settings root must be an object".to_string())?;
    let base_url = object
        .get("baseUrl")
        .cloned()
        .unwrap_or_else(|| Value::String(String::new()));
    let model = object
        .get("model")
        .cloned()
        .unwrap_or_else(|| Value::String(String::new()));
    object.insert("apiKey".into(), Value::String(String::new()));
    let configs = object
        .entry("providerConfigs")
        .or_insert_with(|| serde_json::json!({}));
    let configs = configs
        .as_object_mut()
        .ok_or_else(|| "providerConfigs must be an object".to_string())?;
    let specific = configs
        .entry(provider)
        .or_insert_with(|| serde_json::json!({}));
    let specific = specific
        .as_object_mut()
        .ok_or_else(|| "provider config must be an object".to_string())?;
    specific.insert("apiKey".into(), Value::String(String::new()));
    specific.insert("baseUrl".into(), base_url);
    specific.insert("model".into(), model);
    for (provider_id, config) in configs.iter_mut() {
        let Some(config) = config.as_object_mut() else {
            continue;
        };
        let key = config
            .get("apiKey")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let key_changed = config
            .remove("apiKeyChanged")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        if key_changed || !key.is_empty() {
            crate::secrets::set_or_delete_secret(&format!("apikey:{provider_id}"), Some(&key))?;
        }
        config.insert("apiKey".into(), Value::String(String::new()));
    }
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("litra-settings.json");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let text = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, text).map_err(|error| error.to_string())?;
    fs::rename(&temporary, &path).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn ai_settings_reset(app: AppHandle) -> Result<(), String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let app_config = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    for path in [
        app_data.join("litra-settings.json"),
        app_config.join("providers.json"),
    ] {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Failed to remove {}: {error}", path.display())),
        }
    }
    let defaults: ProviderDocument = serde_json::from_str(DEFAULT_PROVIDERS)
        .map_err(|error| format!("Default provider config is invalid: {error}"))?;
    for provider in defaults.providers {
        crate::secrets::delete_secret(&format!("apikey:{}", provider.id))?;
    }
    for key in ["webdav:password", "websearch:exaApiKey"] {
        crate::secrets::delete_secret(key)?;
    }
    super::auth::store::oauth_credential_delete("codex".into()).await?;
    super::auth::store::oauth_credential_delete("github-copilot".into()).await?;
    crate::webdav_sync::save_webdav_sync_config(Default::default())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Connection safety – ported from legacy-ts-archive/src/providers/connection-safety.ts
// ---------------------------------------------------------------------------

/// Official API hosts used for cross-provider stale-URL detection.
const OFFICIAL_HOST_DEEPSEEK: &str = "api.deepseek.com";
const OFFICIAL_HOST_OPENCODE: &str = "opencode.ai";
const OFFICIAL_HOST_SAKURA: &str = "api.ai.sakura.ad.jp";

/// Check whether `value` points at `host`.
/// Tries to extract the hostname from a URL; falls back to a substring check
/// (mirrors the TS `hasHost` helper).
fn has_host(value: &str, host: &str) -> bool {
    // Attempt a lightweight hostname extraction: strip scheme, take up to
    // the first path / port / query / fragment delimiter.
    let after_scheme = value
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(value);
    let hostname = after_scheme
        .split(['/', ':', '?', '#'])
        .next()
        .unwrap_or("");
    if !hostname.is_empty() {
        return hostname == host;
    }
    // Fallback for non-URL strings.
    value.contains(host)
}

/// Detect and auto-correct stale cross-provider base URLs.
///
/// If a provider's configured base URL still points at a *different*
/// provider's official host (e.g. the user switched from DeepSeek to Sakura
/// but the old DeepSeek URL lingered in settings), replace it with the
/// correct default for the active provider.  Custom / proxy URLs are kept
/// as-is.
fn resolve_provider_base_url(provider_id: &str, configured_base_url: &str) -> String {
    let base_url = configured_base_url.trim();
    match provider_id {
        "sakura" if has_host(base_url, OFFICIAL_HOST_DEEPSEEK) => {
            format!("https://{OFFICIAL_HOST_SAKURA}/v1")
        }
        "deepseek" if has_host(base_url, OFFICIAL_HOST_OPENCODE) => {
            format!("https://{OFFICIAL_HOST_DEEPSEEK}")
        }
        "opencode" if has_host(base_url, OFFICIAL_HOST_DEEPSEEK) => {
            format!("https://{OFFICIAL_HOST_OPENCODE}/zen/go/v1")
        }
        _ => base_url.to_owned(),
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

#[cfg(test)]
mod tests {
    use super::*;

    // Ported from legacy-ts-archive/src/ai/__tests__/tools.test.ts

    #[test]
    fn sakura_with_stale_deepseek_url_is_corrected() {
        assert_eq!(
            resolve_provider_base_url("sakura", "https://api.deepseek.com"),
            "https://api.ai.sakura.ad.jp/v1"
        );
    }

    #[test]
    fn deepseek_with_stale_opencode_url_is_corrected() {
        assert_eq!(
            resolve_provider_base_url("deepseek", "https://opencode.ai/zen/go/v1"),
            "https://api.deepseek.com"
        );
    }

    #[test]
    fn opencode_with_stale_deepseek_url_is_corrected() {
        assert_eq!(
            resolve_provider_base_url("opencode", "https://api.deepseek.com"),
            "https://opencode.ai/zen/go/v1"
        );
    }

    #[test]
    fn custom_proxy_urls_are_preserved() {
        assert_eq!(
            resolve_provider_base_url("deepseek", "https://proxy.example/v1"),
            "https://proxy.example/v1"
        );
        assert_eq!(
            resolve_provider_base_url("sakura", "https://proxy.example/v1"),
            "https://proxy.example/v1"
        );
    }

    #[test]
    fn unrelated_provider_is_untouched() {
        assert_eq!(
            resolve_provider_base_url("openai", "https://api.deepseek.com"),
            "https://api.deepseek.com"
        );
    }

    #[test]
    fn whitespace_is_trimmed() {
        assert_eq!(
            resolve_provider_base_url("openai", "  https://api.openai.com/v1  "),
            "https://api.openai.com/v1"
        );
    }

    #[test]
    fn has_host_extracts_hostname() {
        assert!(has_host("https://api.deepseek.com/v1", "api.deepseek.com"));
        assert!(!has_host("https://api.deepseek.com/v1", "opencode.ai"));
        assert!(has_host("https://opencode.ai:443/zen", "opencode.ai"));
    }
}
