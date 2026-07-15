mod codex;
mod copilot;
mod opencode;

use reqwest::RequestBuilder;

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
