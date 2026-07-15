mod codex;
mod copilot;
mod opencode;
mod sakura;

use reqwest::RequestBuilder;
use serde_json::Value;

use super::types::AiTextRequest;

/// Wire protocol 共通処理では表現できない provider 固有ヘッダーを付与する。
/// リトライやレスポンス補正も、移行時はこの階層へ provider ごとに追加する。
pub async fn apply_request(
    builder: RequestBuilder,
    request: &AiTextRequest,
    client: &reqwest::Client,
) -> Result<RequestBuilder, String> {
    match request.provider.as_str() {
        "codex" => codex::apply_request(builder, client).await,
        "github-copilot" => copilot::apply_request(builder, request).await,
        "opencode" => Ok(opencode::apply_request(builder)),
        _ => Ok(builder),
    }
}

/// Provider 固有の wire-format 制約を、汎用 protocol builder の後段で補正する。
pub fn normalize_body(request: &AiTextRequest, body: Value) -> Value {
    match request.provider.as_str() {
        "opencode" => opencode::normalize_body(body),
        "sakura" => sakura::normalize_body(body),
        _ => body,
    }
}

pub async fn wait_for_request_slot(request: &AiTextRequest) {
    match request.provider.as_str() {
        "opencode" => opencode::wait_for_request_slot().await,
        "sakura" => sakura::wait_for_request_slot().await,
        _ => {}
    }
}

pub fn retry_delay(
    request: &AiTextRequest,
    status: u16,
    attempt: usize,
) -> Option<std::time::Duration> {
    match request.provider.as_str() {
        "opencode" => opencode::retry_delay(status, attempt),
        "sakura" => sakura::retry_delay(status, attempt),
        _ => None,
    }
}

pub fn requires_stream_head_inspection(request: &AiTextRequest) -> bool {
    request.provider == "opencode"
}

pub fn stream_head_error(request: &AiTextRequest, text: &str) -> Option<String> {
    match request.provider.as_str() {
        "opencode" => opencode::transient_error_message(text),
        _ => None,
    }
}
