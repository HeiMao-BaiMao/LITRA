//! 全 wire protocol で共通に使える単一の強制ツール呼び出しとして
//! 構造化出力を得る。response_format の互換性差を避け、
//! 接続・ストリーム解析は Rust core に集約する。
//!
//! TypeScript `structured-output.ts` の Rust 移植。

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
/// モデルがツールを呼ばなかった場合、または出力がスキーマに合わない場合はエラーを返す。
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

    let Some(call) = call else {
        return Err(JsValue::from_str(&format!(
            "generateStructuredObject: model did not call \"{STRUCTURED_OUTPUT_TOOL_NAME}\""
        )));
    };

    let parsed: T = serde_json::from_value(call.input.clone()).map_err(|e| {
        JsValue::from_str(&format!(
            "generateStructuredObject: structured output validation failed: {e}"
        ))
    })?;

    Ok(parsed)
}
