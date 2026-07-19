//! モデルの推論/思考能力を解決するモジュール。
//! ProviderModelDefaults の reasoningCapability メタデータを参照し、
//! UI が表示すべきコントロールや build_provider_options が送信すべき
//! プロトコルオプションを決定する。
//!
//! TypeScript `capability.ts` の Rust 移植。
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/// Anthropic 適応的思考で使用可能な effort 値。
pub type AnthropicEffort = String;

/// アプリ全体で使う thinking/reasoning の抽象設定値。
pub type ThinkingEffort = String;

/// 推論/思考能力のメタデータ。
/// TypeScript `ReasoningCapability` に相当。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningCapability {
    /// "openai" | "anthropic-adaptive" | "anthropic-budget" | "deepseek" | "google"
    pub kind: String,
    /// サポートされている effort 値の一覧
    #[serde(default)]
    pub supported_efforts: Vec<String>,
    /// "summarized" が指定されている場合のみ表示
    #[serde(default)]
    pub display: Option<String>,
    /// 無効化可能かどうか
    #[serde(default)]
    pub can_disable: bool,
    /// budget 入力をサポートするか
    #[serde(default)]
    pub supports_budget: bool,
    /// budget の最小値
    #[serde(default)]
    pub min_budget: Option<u64>,
    /// budget の最大値
    #[serde(default)]
    pub max_budget: Option<u64>,
    /// 既定の effort 値
    #[serde(default)]
    pub default_effort: Option<String>,
}

/// 表示すべき UI コントロールの種別。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ControlType {
    None,
    OpenAIReasoningEffort,
    AnthropicAdaptive,
    AnthropicBudget,
    DeepSeek,
    GoogleThinkingLevel,
}

// ---------------------------------------------------------------------------
// 公開関数
// ---------------------------------------------------------------------------

/// DeepSeek V4 は非 Thinking 出力で日本語が破損するため、接続先によらず Thinking 固定。
pub fn is_deepseek_v4_model(model_id: &str) -> bool {
    let model_id = model_id.trim().to_lowercase();
    model_id.starts_with("deepseek-v4-") || model_id == "deepseek-v4"
}

/// Copilot キャッシュエントリの能力情報を ReasoningCapability に変換する。
/// キャッシュが無いか不完全な場合は None を返す。
pub fn copilot_cache_to_capability(
    endpoint: Option<&str>,
    reasoning_effort: Option<&[String]>,
    adaptive_thinking: Option<bool>,
    min_thinking_budget: Option<u64>,
    max_thinking_budget: Option<u64>,
) -> Option<ReasoningCapability> {
    let endpoint = endpoint?;

    if endpoint == "messages" {
        if adaptive_thinking == Some(true) {
            return Some(ReasoningCapability {
                kind: "anthropic-adaptive".into(),
                supported_efforts: reasoning_effort
                    .map(|e| e.to_vec())
                    .unwrap_or_else(|| vec!["low".into(), "medium".into(), "high".into()]),
                display: Some("summarized".into()),
                can_disable: false,
                supports_budget: false,
                min_budget: None,
                max_budget: None,
                default_effort: None,
            });
        }
        if max_thinking_budget.is_some() {
            return Some(ReasoningCapability {
                kind: "anthropic-budget".into(),
                supported_efforts: vec![],
                display: None,
                can_disable: true,
                supports_budget: true,
                min_budget: min_thinking_budget,
                max_budget: max_thinking_budget,
                default_effort: None,
            });
        }
    }

    if endpoint == "responses" {
        if let Some(efforts) = reasoning_effort {
            if !efforts.is_empty() {
                return Some(ReasoningCapability {
                    kind: "openai".into(),
                    supported_efforts: efforts.to_vec(),
                    display: None,
                    can_disable: false,
                    supports_budget: false,
                    min_budget: None,
                    max_budget: None,
                    default_effort: None,
                });
            }
        }
    }

    None
}

/// モデルの capability メタデータを取得する。
/// ProviderModelDefaults の reasoningCapability が存在すればそれを返す。
/// 無い場合は provider と model ID から類推する（フォールバック）。
/// `defaults_capability` を渡すと curated メタデータを優先する。
pub fn get_model_capability(
    provider: &str,
    model_id: &str,
    defaults_capability: Option<&ReasoningCapability>,
) -> Option<ReasoningCapability> {
    if let Some(cap) = defaults_capability {
        return Some(cap.clone());
    }

    // フォールバック: プロバイダとモデル名から推論
    match provider {
        "anthropic" => {
            if model_id == "claude-fable-5" {
                Some(ReasoningCapability {
                    kind: "anthropic-adaptive".into(),
                    supported_efforts: vec![
                        "low".into(), "medium".into(), "high".into(),
                        "xhigh".into(), "max".into(),
                    ],
                    display: Some("summarized".into()),
                    ..Default::default()
                })
            } else if model_id.starts_with("claude-opus-4-7")
                || model_id.starts_with("claude-opus-4-8")
            {
                Some(ReasoningCapability {
                    kind: "anthropic-adaptive".into(),
                    supported_efforts: vec![
                        "low".into(), "medium".into(), "high".into(),
                        "xhigh".into(), "max".into(),
                    ],
                    display: Some("summarized".into()),
                    can_disable: true,
                    ..Default::default()
                })
            } else if model_id.starts_with("claude-") {
                Some(ReasoningCapability {
                    kind: "anthropic-budget".into(),
                    can_disable: true,
                    supports_budget: true,
                    ..Default::default()
                })
            } else {
                None
            }
        }
        "deepseek" => Some(ReasoningCapability {
            kind: "deepseek".into(),
            supported_efforts: vec!["high".into(), "max".into()],
            can_disable: true,
            ..Default::default()
        }),
        "google" => {
            if model_id.starts_with("gemini-3.1-pro") {
                Some(ReasoningCapability {
                    kind: "google".into(),
                    supported_efforts: vec!["low".into(), "medium".into(), "high".into()],
                    ..Default::default()
                })
            } else if model_id.starts_with("gemini-3") {
                // gemini-3.0 など
                Some(ReasoningCapability {
                    kind: "google".into(),
                    supported_efforts: vec![
                        "minimal".into(), "low".into(), "medium".into(), "high".into(),
                    ],
                    ..Default::default()
                })
            } else {
                None
            }
        }
        "openai" | "codex" => Some(ReasoningCapability {
            kind: "openai".into(),
            supported_efforts: vec![
                "none".into(), "low".into(), "medium".into(),
                "high".into(), "xhigh".into(),
            ],
            ..Default::default()
        }),
        "github-copilot" => {
            if model_id.starts_with("claude-fable-5") {
                Some(ReasoningCapability {
                    kind: "anthropic-adaptive".into(),
                    supported_efforts: vec!["low".into(), "medium".into(), "high".into()],
                    display: Some("summarized".into()),
                    ..Default::default()
                })
            } else if model_id.starts_with("claude-opus-4-7")
                || model_id.starts_with("claude-opus-4-8")
            {
                Some(ReasoningCapability {
                    kind: "anthropic-adaptive".into(),
                    supported_efforts: vec![
                        "low".into(), "medium".into(), "high".into(),
                        "xhigh".into(), "max".into(),
                    ],
                    display: Some("summarized".into()),
                    can_disable: true,
                    ..Default::default()
                })
            } else if model_id.starts_with("claude-") {
                Some(ReasoningCapability {
                    kind: "anthropic-budget".into(),
                    can_disable: true,
                    supports_budget: true,
                    ..Default::default()
                })
            } else if model_id.starts_with("gpt-5") {
                Some(ReasoningCapability {
                    kind: "openai".into(),
                    supported_efforts: vec![
                        "none".into(), "low".into(), "medium".into(),
                        "high".into(), "xhigh".into(),
                    ],
                    ..Default::default()
                })
            } else {
                None
            }
        }
        "opencode" => {
            if is_deepseek_v4_model(model_id) {
                Some(ReasoningCapability {
                    kind: "deepseek".into(),
                    supported_efforts: vec!["high".into(), "max".into()],
                    can_disable: false,
                    ..Default::default()
                })
            } else if model_id == "minimax-m3" || model_id.starts_with("qwen3.") {
                None
            } else {
                None
            }
        }
        _ => None,
    }
}

/// 指定されたモデルが reasoning/thinking をサポートするかどうかを返す。
pub fn model_supports_reasoning(cap: Option<&ReasoningCapability>) -> bool {
    cap.is_some()
}

/// 指定されたモデルで thinking を無効化できるかどうかを返す。
pub fn can_disable_thinking(cap: Option<&ReasoningCapability>) -> bool {
    cap.map_or(false, |c| c.can_disable)
}

/// reasoning/thinking が常時有効かどうかを返す。
pub fn is_thinking_always_on(cap: Option<&ReasoningCapability>) -> bool {
    cap.map_or(false, |c| c.kind == "anthropic-adaptive" && !c.can_disable)
}

/// モデルが effort 選択をサポートするかどうか。
pub fn supports_effort_selector(cap: Option<&ReasoningCapability>) -> bool {
    match cap {
        Some(c) if c.kind == "google" => false,
        Some(c) => !c.supported_efforts.is_empty(),
        None => false,
    }
}

/// モデルが budget 入力をサポートするかどうか。
pub fn supports_budget_input(cap: Option<&ReasoningCapability>) -> bool {
    cap.map_or(false, |c| c.supports_budget)
}

/// 表示すべき UI コントロールの種別を返す。
pub fn get_control_type(cap: Option<&ReasoningCapability>) -> ControlType {
    match cap {
        None => ControlType::None,
        Some(c) => match c.kind.as_str() {
            "openai" => ControlType::OpenAIReasoningEffort,
            "anthropic-adaptive" => ControlType::AnthropicAdaptive,
            "anthropic-budget" => ControlType::AnthropicBudget,
            "deepseek" => ControlType::DeepSeek,
            "google" => ControlType::GoogleThinkingLevel,
            _ => ControlType::None,
        },
    }
}

/// モデルがサポートする effort 値の一覧を返す。
pub fn get_supported_efforts(cap: Option<&ReasoningCapability>) -> Vec<String> {
    cap.map_or(vec![], |c| c.supported_efforts.clone())
}

/// コントロールを非表示（hidden）にすべきかを返す。
pub fn should_hide_controls(cap: Option<&ReasoningCapability>) -> bool {
    cap.is_none()
}

/// Gemini 3 系かどうかを判定する。
pub fn is_gemini3_model(model: &str) -> bool {
    let model = model.trim().to_lowercase();
    model.starts_with("gemini-3.")
        || model.starts_with("gemini-3-")
        || model == "gemini-3"
}

impl Default for ReasoningCapability {
    fn default() -> Self {
        Self {
            kind: String::new(),
            supported_efforts: Vec::new(),
            display: None,
            can_disable: false,
            supports_budget: false,
            min_budget: None,
            max_budget: None,
            default_effort: None,
        }
    }
}

/// `resolve_forced_tool_choice` — モデルごとに tool_choice を "required" / "auto" / None に決定する。
/// TypeScript `resolveForcedToolChoice` の移植。
pub fn resolve_forced_tool_choice(
    provider: &str,
    model_id: &str,
    deepseek_thinking_enabled: Option<bool>,
) -> Option<String> {
    if provider == "opencode" {
        return None;
    }
    if provider == "deepseek" {
        let thinking = deepseek_thinking_enabled.unwrap_or(true);
        return if thinking { Some("auto".into()) } else { Some("required".into()) };
    }
    if provider == "google" && is_gemini3_model(model_id) {
        return Some("required".into());
    }
    // OpenAI / Anthropic / Codex / Copilot: tool_choice はサーバ側に任せる
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deepseek_v4_detection() {
        assert!(is_deepseek_v4_model("deepseek-v4-0324"));
        assert!(is_deepseek_v4_model("DEEPSEEK-V4-latest "));
        assert!(!is_deepseek_v4_model("deepseek-v3"));
    }

    #[test]
    fn anthropic_model_capability() {
        let cap = get_model_capability("anthropic", "claude-fable-5", None);
        assert!(cap.is_some());
        let cap = cap.unwrap();
        assert_eq!(cap.kind, "anthropic-adaptive");
        assert!(!cap.can_disable);

        let cap = get_model_capability("anthropic", "claude-opus-4-8-20250701", None);
        assert!(cap.is_some());
        let cap = cap.unwrap();
        assert!(cap.can_disable);
    }

    #[test]
    fn openai_capability() {
        let cap = get_model_capability("openai", "gpt-5.1", None);
        assert!(cap.is_some());
        let cap = cap.unwrap();
        assert_eq!(cap.kind, "openai");
        assert!(!cap.supported_efforts.contains(&"minimal".to_string()));
    }

    #[test]
    fn forced_tool_choice_deepseek() {
        assert_eq!(
            resolve_forced_tool_choice("deepseek", "deepseek-v3", Some(false)),
            Some("required".into())
        );
        assert_eq!(
            resolve_forced_tool_choice("deepseek", "deepseek-v3", Some(true)),
            Some("auto".into())
        );
    }

    #[test]
    fn forced_tool_choice_opencode_returns_none() {
        assert_eq!(
            resolve_forced_tool_choice("opencode", "deepseek-v4", None),
            None
        );
    }

    #[test]
    fn gemini3_detection() {
        assert!(is_gemini3_model("gemini-3.1-pro"));
        assert!(is_gemini3_model("gemini-3-flash"));
        assert!(!is_gemini3_model("gemini-2.5-pro"));
    }

    #[test]
    fn control_type_mapping() {
        assert_eq!(
            get_control_type(Some(&ReasoningCapability {
                kind: "openai".into(),
                ..Default::default()
            })),
            ControlType::OpenAIReasoningEffort
        );
        assert_eq!(get_control_type(None), ControlType::None);
    }
}
