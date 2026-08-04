//! 実行時のモデル設定解決（チャット/執筆系/判断系/バックグラウンド）。
//! モデル既定値・役割プロファイル・ユーザーオーバーライドを順に重ねる。
//!
//! TypeScript `role-settings.ts` の Rust 移植。

#![allow(dead_code)]
use serde_json::{Map, Value};

use super::capability::{self, ReasoningCapability};

/// DeepSeek V4 モデルの場合、thinking を強制有効化した設定を返す。
pub fn enforce_required_thinking(mut settings: Value) -> Value {
    let model = settings
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("");
    if capability::is_deepseek_v4_model(model) {
        if let Some(obj) = settings.as_object_mut() {
            obj.insert(
                "deepseekThinkingEnabled".into(),
                Value::Bool(true),
            );
        }
    }
    settings
}

/// モデル既定値を実行時設定に適用する。
///
/// `defaults` はモデルの ProviderModelDefaults（JSON object）。
/// `apply_token_defaults` が true の場合のみ maxTokens/maxContextTokens も上書きする。
pub fn apply_runtime_model_defaults(
    settings: Value,
    defaults: Option<&Value>,
    apply_token_defaults: bool,
) -> Value {
    let Some(defaults) = defaults else {
        return settings;
    };

    let provider = settings
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("");
    let model_id = settings
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("");

    let capability = defaults
        .get("reasoningCapability")
        .and_then(|v| serde_json::from_value::<ReasoningCapability>(v.clone()).ok())
        .or_else(|| capability::get_model_capability(provider, model_id, None));

    let mut next = settings;
    let obj = next.as_object_mut().expect("settings must be an object");

    // サンプリング系パラメータをマージ
    merge_optional_number(obj, defaults, "temperature");
    if apply_token_defaults {
        merge_optional_number(obj, defaults, "maxTokens");
        merge_optional_number(obj, defaults, "maxContextTokens");
    }
    merge_optional_number(obj, defaults, "topP");
    merge_optional_number(obj, defaults, "topK");
    merge_optional_number(obj, defaults, "frequencyPenalty");
    merge_optional_number(obj, defaults, "presencePenalty");

    // reasoningCapability を設定
    if let Some(ref cap) = capability {
        obj.insert(
            "reasoningCapability".into(),
            serde_json::to_value(cap).unwrap_or_default(),
        );
    }

    // プロバイダ種別に応じた reasoning/thinking パラメータを適用
    if let Some(cap) = &capability {
        match cap.kind.as_str() {
            "openai" => {
                merge_optional_string(obj, defaults, "openaiReasoningEffort");
            }
            "deepseek" => {
                merge_optional_string(obj, defaults, "deepseekReasoningEffort");
            }
            "anthropic-adaptive" => {
                obj.insert("anthropicThinkingEnabled".into(), Value::Bool(true));
                obj.insert("anthropicThinkingBudget".into(), Value::Null);
                let default_effort = cap
                    .default_effort
                    .as_deref()
                    .filter(|e| {
                        matches!(*e, "low" | "medium" | "high" | "xhigh" | "max")
                    });
                if let Some(effort) = default_effort {
                    if !obj.contains_key("anthropicThinkingEffort") {
                        obj.insert(
                            "anthropicThinkingEffort".into(),
                            Value::String(effort.into()),
                        );
                    }
                }
                merge_optional_string(obj, defaults, "anthropicThinkingEffort");
            }
            "anthropic-budget" => {
                merge_optional_bool(obj, defaults, "anthropicThinkingEnabled");
                merge_optional_number(obj, defaults, "anthropicThinkingBudget");
                obj.insert("anthropicThinkingEffort".into(), Value::Null);
            }
            "google" => {
                merge_optional_string(obj, defaults, "googleThinkingLevel");
            }
            _ => {}
        }
    }

    next
}

/// providers.json の役割プロファイルとユーザーの役割別オーバーライドを
/// 順に重ねる（後勝ち）。layer が先、overrides が後。
pub fn apply_role_profile(
    mut settings: Value,
    layer: Option<&Value>,
    overrides: Option<&Value>,
) -> Value {
    if let Some(layer) = layer {
        settings = apply_role_profile_layer(settings, layer);
    }
    if let Some(overrides) = overrides {
        settings = apply_role_profile_layer(settings, overrides);
    }
    settings
}

fn apply_role_profile_layer(mut settings: Value, layer: &Value) -> Value {
    let obj = settings.as_object_mut().expect("settings must be an object");
    let layer = layer.as_object();
    let Some(layer) = layer else { return settings };

    // サンプリング系は無条件で上書き
    copy_if_present(obj, layer, "temperature");
    copy_if_present(obj, layer, "topP");
    copy_if_present(obj, layer, "topK");
    copy_if_present(obj, layer, "frequencyPenalty");
    copy_if_present(obj, layer, "presencePenalty");
    copy_if_present(obj, layer, "promptScaffold");

    // reasoning/thinking 系は現在のプロバイダ種別に一致するものだけ適用
    let kind = obj
        .get("reasoningCapability")
        .and_then(|v| v.get("kind"))
        .and_then(Value::as_str)
        .map(|s| s.to_string());

    match kind.as_deref() {
        Some("openai") => {
            copy_if_present(obj, layer, "openaiReasoningEffort");
        }
        Some("deepseek") => {
            copy_if_present(obj, layer, "deepseekReasoningEffort");
            copy_if_present(obj, layer, "deepseekThinkingEnabled");
        }
        Some("anthropic-adaptive") => {
            copy_if_present(obj, layer, "anthropicThinkingEffort");
            obj.insert("anthropicThinkingEnabled".into(), Value::Bool(true));
            obj.insert("anthropicThinkingBudget".into(), Value::Null);
        }
        Some("anthropic-budget") => {
            copy_if_present(obj, layer, "anthropicThinkingEnabled");
            copy_if_present(obj, layer, "anthropicThinkingBudget");
        }
        Some("google") => {
            copy_if_present(obj, layer, "googleThinkingLevel");
        }
        _ => {}
    }

    settings
}

// ---------------------------------------------------------------------------
// 内部ヘルパー
// ---------------------------------------------------------------------------

fn merge_optional_number(obj: &mut Map<String, Value>, defaults: &Value, key: &str) {
    if let Some(v) = defaults.get(key) {
        if !v.is_null() && !obj.contains_key(key) {
            obj.insert(key.into(), v.clone());
        }
    }
}

fn merge_optional_string(obj: &mut Map<String, Value>, defaults: &Value, key: &str) {
    if let Some(v) = defaults.get(key) {
        if v.is_string() && !obj.contains_key(key) {
            obj.insert(key.into(), v.clone());
        }
    }
}

fn merge_optional_bool(obj: &mut Map<String, Value>, defaults: &Value, key: &str) {
    if let Some(v) = defaults.get(key) {
        if v.is_boolean() && !obj.contains_key(key) {
            obj.insert(key.into(), v.clone());
        }
    }
}

fn copy_if_present(
    obj: &mut Map<String, Value>,
    source: &Map<String, Value>,
    key: &str,
) {
    if let Some(v) = source.get(key) {
        obj.insert(key.into(), v.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn enforces_thinking_for_deepseek_v4() {
        let settings = json!({
            "provider": "deepseek",
            "model": "deepseek-v4-0324",
            "deepseekThinkingEnabled": false
        });
        let result = enforce_required_thinking(settings);
        assert_eq!(
            result["deepseekThinkingEnabled"].as_bool().unwrap(),
            true
        );
    }

    #[test]
    fn does_not_enforce_for_non_v4() {
        let settings = json!({
            "provider": "deepseek",
            "model": "deepseek-v3",
            "deepseekThinkingEnabled": false
        });
        let result = enforce_required_thinking(settings);
        assert_eq!(
            result["deepseekThinkingEnabled"].as_bool().unwrap(),
            false
        );
    }

    #[test]
    fn applies_token_defaults_when_requested() {
        let settings = json!({"provider":"openai","model":"gpt-5.1"});
        let defaults = json!({"maxTokens":4096,"maxContextTokens":128000});
        let result =
            apply_runtime_model_defaults(settings, Some(&defaults), true);
        assert_eq!(result["maxTokens"].as_u64().unwrap(), 4096);
        assert_eq!(result["maxContextTokens"].as_u64().unwrap(), 128000);
    }

    #[test]
    fn skips_token_defaults_when_not_requested() {
        let settings = json!({"provider":"openai","model":"gpt-5.1","maxTokens":2048});
        let defaults = json!({"maxTokens":4096});
        let result =
            apply_runtime_model_defaults(settings, Some(&defaults), false);
        assert_eq!(result["maxTokens"].as_u64().unwrap(), 2048);
    }

    #[test]
    fn role_profile_layer_overrides() {
        let settings = json!({
            "provider":"openai",
            "model":"gpt-5.1",
            "temperature":0.7,
            "reasoningCapability":{"kind":"openai"}
        });
        let layer = json!({"temperature":0.3,"openaiReasoningEffort":"high"});
        let result = apply_role_profile_layer(settings, &layer);
        assert_eq!(result["temperature"].as_f64().unwrap(), 0.3);
        assert_eq!(
            result["openaiReasoningEffort"].as_str().unwrap(),
            "high"
        );
    }
}
