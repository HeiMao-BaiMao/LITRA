//! 全 wire protocol で共通に使える単一の強制ツール呼び出しとして
//! 構造化出力を得る。response_format の互換性差を避け、
//! 接続・ストリーム解析は Rust core に集約する。
//!
//! TypeScript `structured-output.ts` の Rust 移植。
#![allow(dead_code)]

use serde::de::DeserializeOwned;
use serde_json::Value;
use wasm_bindgen::JsValue;

use crate::runtime::ai;

const STRUCTURED_OUTPUT_TOOL_NAME: &str = "submit_structured_output";

/// 強制ツール呼び出しを使って構造化 JSON を取得する。
///
/// `json_schema` は JSON Schema (draft-07) オブジェクト。
/// `system` はシステムプロンプト（省略可）。
/// `prompt` はユーザープロンプト。
/// `role` は使用する AI ロール（例: "judgment"）。
///
/// モデルがツールを呼ばなかった場合は、互換性のためテキスト JSON を
/// フォールバックとして検証する。どちらもスキーマに合わない場合はエラーを返す。
pub async fn generate_structured_object<T: DeserializeOwned>(
    role: &str,
    system: Option<&str>,
    prompt: &str,
    json_schema: Value,
    provider_override: Option<&str>,
    model_override: Option<&str>,
) -> Result<T, JsValue> {
    let tool = serde_json::json!({
        "name": STRUCTURED_OUTPUT_TOOL_NAME,
        "description": "Submit the structured output. Call this tool exactly once with the response that matches the required schema. Do not include any other text.",
        "inputSchema": json_schema,
    });

    let messages: Vec<Value> = vec![serde_json::json!({
        "role": "user",
        "content": prompt,
    })];

    let turn = ai::agent_turn(
        role,
        system.unwrap_or("").to_string(),
        messages,
        vec![tool],
        provider_override,
        model_override,
    )
    .await?;

    let call = turn
        .tool_calls
        .iter()
        .find(|c| c.name == STRUCTURED_OUTPUT_TOOL_NAME);

    if let Some(call) = call {
        let parsed: T = serde_json::from_value(call.input.clone()).map_err(|e| {
            JsValue::from_str(&format!(
                "generateStructuredObject: structured output validation failed: {e}"
            ))
        })?;
        return Ok(parsed);
    }

    // OpenCode's DeepSeek V4 route intentionally removes tool_choice while
    // thinking is enabled. Keep structured generation usable there by
    // accepting a JSON object returned as the assistant text.
    parse_structured_text(&turn.text).ok_or_else(|| {
        JsValue::from_str(&format!(
            "generateStructuredObject: model did not call \"{STRUCTURED_OUTPUT_TOOL_NAME}\" and did not return valid JSON"
        ))
    })
}

fn parse_structured_text<T: DeserializeOwned>(text: &str) -> Option<T> {
    let trimmed = text.trim();
    for candidate in [trimmed, strip_code_fence(trimmed)] {
        if let Ok(value) = serde_json::from_str(candidate) {
            return Some(value);
        }
    }
    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    if start >= end {
        return None;
    }
    let candidate = &trimmed[start..=end];
    serde_json::from_str(candidate)
        .ok()
        .or_else(|| serde_json::from_str(&escape_raw_json_controls(candidate)).ok())
}

fn strip_code_fence(text: &str) -> &str {
    let text = text.strip_prefix("```").unwrap_or(text);
    let text = text
        .strip_prefix("json")
        .or_else(|| text.strip_prefix("JSON"))
        .unwrap_or(text);
    text.strip_suffix("```").unwrap_or(text).trim()
}

fn escape_raw_json_controls(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    let mut in_string = false;
    let mut escaped_character = false;
    for character in text.chars() {
        if in_string {
            if escaped_character {
                escaped.push(character);
                escaped_character = false;
            } else if character == '\\' {
                escaped.push(character);
                escaped_character = true;
            } else if character == '"' {
                escaped.push(character);
                in_string = false;
            } else if character == '\n' {
                escaped.push_str("\\n");
            } else if character == '\r' {
                escaped.push_str("\\r");
            } else if character == '\t' {
                escaped.push_str("\\t");
            } else {
                escaped.push(character);
            }
        } else {
            if character == '"' {
                in_string = true;
            }
            escaped.push(character);
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::parse_structured_text;
    use serde_json::json;

    #[test]
    fn parses_direct_json_text() {
        assert_eq!(
            parse_structured_text::<serde_json::Value>(r#"{"ok":true}"#),
            Some(json!({"ok": true}))
        );
    }

    #[test]
    fn parses_fenced_json_with_preamble() {
        assert_eq!(
            parse_structured_text::<serde_json::Value>(
                "結果です。\n```json\n{\"ok\":true}\n```"
            ),
            Some(json!({"ok": true}))
        );
    }

    #[test]
    fn rejects_non_json_text() {
        assert_eq!(parse_structured_text::<serde_json::Value>("結果だけです"), None);
    }

    #[test]
    fn parses_multiline_json_string_from_compatible_model() {
        assert_eq!(
            parse_structured_text::<serde_json::Value>("{\"text\":\"一行目。\n二行目。\"}"),
            Some(json!({"text": "一行目。\n二行目。"}))
        );
    }
}
