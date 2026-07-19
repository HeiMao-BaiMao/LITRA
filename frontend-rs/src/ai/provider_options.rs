//! モデルの capability を考慮してプロバイダーオプションを構築する。
//! 選択されたモデルの reasoningCapability メタデータを参照し、
//! サポートされているオプションのみをプロトコルに送出する。
//!
//! TypeScript `provider-options.ts` の Rust 移植。

use serde_json::{Map, Value};

use super::capability::{self, ReasoningCapability};

/// モデルの capability を考慮してプロバイダーオプションを構築する。
///
/// `settings` は JSON object として現在の AI 設定全体を含む。
/// `defaults_capability` は選択されたモデルの ProviderModelDefaults 由来の
/// reasoningCapability（存在すれば）。
///
/// 戻り値はプロバイダーオプションの JSON object、または不要な場合は None。
pub fn build_provider_options(
    settings: &Value,
    defaults_capability: Option<&ReasoningCapability>,
) -> Option<Value> {
    let provider = settings
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("");
    let model_id = settings
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("");

    let cap = settings
        .get("reasoningCapability")
        .and_then(|v| serde_json::from_value::<ReasoningCapability>(v.clone()).ok())
        .or_else(|| capability::get_model_capability(provider, model_id, defaults_capability));

    match provider {
        "openai" => {
            let effort = settings
                .get("openaiReasoningEffort")
                .and_then(Value::as_str);
            let Some(effort) = effort else { return None };
            let base_url = settings
                .get("baseUrl")
                .and_then(Value::as_str)
                .unwrap_or("");
            if base_url.contains("api.platform.preferredai.jp") {
                return None;
            }
            // GPT-5.1 以降 "minimal" は API から削除済み（"none" が後継）。旧設定を救済する。
            let effort = if effort == "minimal" { "none" } else { effort };
            let mut opts = Map::new();
            opts.insert("reasoningEffort".into(), Value::String(effort.into()));
            opts.insert("reasoningSummary".into(), Value::String("auto".into()));
            let mut result = Map::new();
            result.insert("openai".into(), Value::Object(opts));
            Some(Value::Object(result))
        }
        "anthropic" => {
            let cap = cap.as_ref();
            if cap.is_none() {
                let effort = settings
                    .get("anthropicThinkingEffort")
                    .and_then(Value::as_str);
                let Some(effort) = effort else { return None };
                let mut thinking = Map::new();
                thinking.insert("type".into(), Value::String("adaptive".into()));
                let mut opts = Map::new();
                opts.insert("thinking".into(), Value::Object(thinking));
                opts.insert("effort".into(), Value::String(effort.into()));
                let mut result = Map::new();
                result.insert("anthropic".into(), Value::Object(opts));
                return Some(Value::Object(result));
            }
            let cap = cap.unwrap();
            if cap.kind == "anthropic-adaptive" {
                if cap.can_disable
                    && settings
                        .get("anthropicThinkingEnabled")
                        .and_then(Value::as_bool)
                        == Some(false)
                {
                    return None;
                }
                if !cap.can_disable
                    && settings.get("anthropicThinkingEffort").is_none()
                {
                    return None;
                }
                let mut thinking = Map::new();
                thinking.insert("type".into(), Value::String("adaptive".into()));
                if cap.display.as_deref() == Some("summarized") {
                    thinking.insert(
                        "display".into(),
                        Value::String("summarized".into()),
                    );
                }
                let mut opts = Map::new();
                opts.insert("thinking".into(), Value::Object(thinking));
                if let Some(effort) =
                    settings.get("anthropicThinkingEffort").and_then(Value::as_str)
                {
                    opts.insert("effort".into(), Value::String(effort.into()));
                }
                let mut result = Map::new();
                result.insert("anthropic".into(), Value::Object(opts));
                Some(Value::Object(result))
            } else {
                // Budget thinking
                if settings
                    .get("anthropicThinkingEnabled")
                    .and_then(Value::as_bool)
                    == Some(false)
                {
                    let mut thinking = Map::new();
                    thinking.insert("type".into(), Value::String("disabled".into()));
                    let mut opts = Map::new();
                    opts.insert("thinking".into(), Value::Object(thinking));
                    let mut result = Map::new();
                    result.insert("anthropic".into(), Value::Object(opts));
                    return Some(Value::Object(result));
                }
                let budget = settings
                    .get("anthropicThinkingBudget")
                    .and_then(Value::as_u64);
                let Some(budget) = budget else { return None };
                let mut thinking = Map::new();
                thinking.insert("type".into(), Value::String("enabled".into()));
                thinking.insert(
                    "budgetTokens".into(),
                    Value::Number(budget.into()),
                );
                let mut opts = Map::new();
                opts.insert("thinking".into(), Value::Object(thinking));
                let mut result = Map::new();
                result.insert("anthropic".into(), Value::Object(opts));
                Some(Value::Object(result))
            }
        }
        "deepseek" => {
            let thinking_disabled = settings
                .get("deepseekThinkingEnabled")
                .and_then(Value::as_bool)
                == Some(false);
            if thinking_disabled && !capability::is_deepseek_v4_model(model_id) {
                let mut thinking = Map::new();
                thinking.insert("type".into(), Value::String("disabled".into()));
                let mut opts = Map::new();
                opts.insert("thinking".into(), Value::Object(thinking));
                let mut result = Map::new();
                result.insert("deepseek".into(), Value::Object(opts));
                return Some(Value::Object(result));
            }
            let mut thinking = Map::new();
            thinking.insert("type".into(), Value::String("enabled".into()));
            let mut opts = Map::new();
            opts.insert("thinking".into(), Value::Object(thinking));
            if let Some(effort) = settings
                .get("deepseekReasoningEffort")
                .and_then(Value::as_str)
            {
                if effort == "high" || effort == "max" {
                    opts.insert(
                        "reasoningEffort".into(),
                        Value::String(effort.into()),
                    );
                }
            }
            let mut result = Map::new();
            result.insert("deepseek".into(), Value::Object(opts));
            Some(Value::Object(result))
        }
        "codex" => {
            let effort = settings
                .get("openaiReasoningEffort")
                .and_then(Value::as_str);
            let effort = effort.map(|e| if e == "minimal" { "none" } else { e });
            let mut opts = Map::new();
            if let Some(effort) = effort {
                opts.insert(
                    "reasoningEffort".into(),
                    Value::String(effort.into()),
                );
            }
            opts.insert("reasoningSummary".into(), Value::String("auto".into()));
            opts.insert("store".into(), Value::Bool(false));
            opts.insert(
                "include".into(),
                Value::Array(vec![Value::String(
                    "reasoning.encrypted_content".into(),
                )]),
            );
            let mut result = Map::new();
            result.insert("openai".into(), Value::Object(opts));
            Some(Value::Object(result))
        }
        "github-copilot" => {
            let cap = cap.as_ref();
            match cap.map(|c| c.kind.as_str()) {
                Some("anthropic-adaptive") => {
                    let effort = settings
                        .get("anthropicThinkingEffort")
                        .and_then(Value::as_str);
                    let Some(effort) = effort else { return None };
                    let mut thinking = Map::new();
                    thinking.insert(
                        "type".into(),
                        Value::String("adaptive".into()),
                    );
                    if cap.unwrap().display.as_deref() == Some("summarized") {
                        thinking.insert(
                            "display".into(),
                            Value::String("summarized".into()),
                        );
                    }
                    let mut opts = Map::new();
                    opts.insert("thinking".into(), Value::Object(thinking));
                    opts.insert("effort".into(), Value::String(effort.into()));
                    let mut result = Map::new();
                    result.insert("anthropic".into(), Value::Object(opts));
                    Some(Value::Object(result))
                }
                Some("anthropic-budget") => {
                    if settings
                        .get("anthropicThinkingEnabled")
                        .and_then(Value::as_bool)
                        == Some(false)
                    {
                        let mut thinking = Map::new();
                        thinking.insert(
                            "type".into(),
                            Value::String("disabled".into()),
                        );
                        let mut opts = Map::new();
                        opts.insert("thinking".into(), Value::Object(thinking));
                        let mut result = Map::new();
                        result.insert("anthropic".into(), Value::Object(opts));
                        return Some(Value::Object(result));
                    }
                    let budget = settings
                        .get("anthropicThinkingBudget")
                        .and_then(Value::as_u64);
                    let Some(budget) = budget else { return None };
                    let mut thinking = Map::new();
                    thinking.insert(
                        "type".into(),
                        Value::String("enabled".into()),
                    );
                    thinking.insert(
                        "budgetTokens".into(),
                        Value::Number(budget.into()),
                    );
                    let mut opts = Map::new();
                    opts.insert("thinking".into(), Value::Object(thinking));
                    let mut result = Map::new();
                    result.insert("anthropic".into(), Value::Object(opts));
                    Some(Value::Object(result))
                }
                Some("openai") => {
                    let effort = settings
                        .get("openaiReasoningEffort")
                        .and_then(Value::as_str);
                    let Some(effort) = effort else { return None };
                    let mut opts = Map::new();
                    opts.insert(
                        "reasoningEffort".into(),
                        Value::String(effort.into()),
                    );
                    opts.insert(
                        "reasoningSummary".into(),
                        Value::String("auto".into()),
                    );
                    opts.insert(
                        "include".into(),
                        Value::Array(vec![Value::String(
                            "reasoning.encrypted_content".into(),
                        )]),
                    );
                    let mut result = Map::new();
                    result.insert("openai".into(), Value::Object(opts));
                    Some(Value::Object(result))
                }
                _ => None,
            }
        }
        "sakura" => {
            let mut opts = Map::new();
            opts.insert(
                "parallelToolCalls".into(),
                Value::Bool(false),
            );
            let mut result = Map::new();
            result.insert("openai".into(), Value::Object(opts));
            Some(Value::Object(result))
        }
        "google" => {
            if !capability::is_gemini3_model(model_id) {
                return None;
            }
            let level = settings
                .get("googleThinkingLevel")
                .and_then(Value::as_str);
            let supported = cap
                .as_ref()
                .filter(|c| c.kind == "google")
                .map(|c| &c.supported_efforts);

            let mut level = level.map(|l| l.to_string());
            if let (Some(l), Some(supported)) = (&level, supported) {
                if !supported.contains(l) {
                    let fallback = if l == "minimal" {
                        Some("low".to_string())
                    } else {
                        None
                    };
                    level = fallback.filter(|f| supported.contains(f));
                }
            }

            let mut thinking_config = Map::new();
            thinking_config.insert(
                "includeThoughts".into(),
                Value::Bool(true),
            );
            if let Some(l) = level {
                thinking_config
                    .insert("thinkingLevel".into(), Value::String(l));
            }
            let mut opts = Map::new();
            opts.insert(
                "thinkingConfig".into(),
                Value::Object(thinking_config),
            );
            let mut result = Map::new();
            result.insert("google".into(), Value::Object(opts));
            Some(Value::Object(result))
        }
        _ => None,
    }
}

/// debugFetch が独自のリトライを行うプロバイダでは AI SDK の標準リトライを無効化し、
/// 二重リトライによる過剰な待ち時間を防ぐ。
pub fn build_retry_option(provider: &str) -> Option<u32> {
    match provider {
        "opencode" | "sakura" | "codex" | "github-copilot" => Some(0),
        _ => None,
    }
}

/// AI 呼び出しのエラーメッセージをユーザー向けに整形する。
pub fn format_ai_error_message(error: &str) -> String {
    let lower = error.to_lowercase();
    if lower.contains("upstream request failed")
        || lower.contains("upstream error")
        || lower.contains("upstream unavailable")
        || lower.contains("overloaded")
        || lower.contains("temporarily unavailable")
        || lower.contains("service unavailable")
        || lower.contains("rate limit")
        || lower.contains("rate-limit")
        || lower.contains("too many requests")
        || lower.contains("throttl")
    {
        format!("{error}\n\n時間をおいて再度送信してください。")
    } else {
        error.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn openai_basic_options() {
        let settings = json!({
            "provider": "openai",
            "model": "gpt-5.1",
            "openaiReasoningEffort": "medium",
            "baseUrl": ""
        });
        let result = build_provider_options(&settings, None);
        assert!(result.is_some());
        let opts = result.unwrap();
        assert_eq!(
            opts["openai"]["reasoningEffort"].as_str().unwrap(),
            "medium"
        );
    }

    #[test]
    fn openai_minimal_upgraded_to_none() {
        let settings = json!({
            "provider": "openai",
            "model": "gpt-5.1",
            "openaiReasoningEffort": "minimal",
            "baseUrl": ""
        });
        let result = build_provider_options(&settings, None);
        assert_eq!(
            result.unwrap()["openai"]["reasoningEffort"]
                .as_str()
                .unwrap(),
            "none"
        );
    }

    #[test]
    fn deepseek_thinking_disabled() {
        let settings = json!({
            "provider": "deepseek",
            "model": "deepseek-v3",
            "deepseekThinkingEnabled": false
        });
        let result = build_provider_options(&settings, None);
        assert!(result.is_some());
        let opts = result.unwrap();
        assert_eq!(
            opts["deepseek"]["thinking"]["type"].as_str().unwrap(),
            "disabled"
        );
    }

    #[test]
    fn deepseek_v4_never_disabled() {
        let settings = json!({
            "provider": "deepseek",
            "model": "deepseek-v4-0324",
            "deepseekThinkingEnabled": false
        });
        let result = build_provider_options(&settings, None);
        let opts = result.unwrap();
        assert_eq!(
            opts["deepseek"]["thinking"]["type"].as_str().unwrap(),
            "enabled"
        );
    }

    #[test]
    fn sakura_disables_parallel_tool_calls() {
        let settings = json!({
            "provider": "sakura",
            "model": "some-model"
        });
        let result = build_provider_options(&settings, None);
        assert_eq!(
            result.unwrap()["openai"]["parallelToolCalls"]
                .as_bool()
                .unwrap(),
            false
        );
    }
}
