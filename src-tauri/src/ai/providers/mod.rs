mod opencode;

use reqwest::RequestBuilder;

use super::types::AiTextRequest;

/// Wire protocol 共通処理では表現できない provider 固有ヘッダーを付与する。
/// リトライやレスポンス補正も、移行時はこの階層へ provider ごとに追加する。
pub fn apply_request(builder: RequestBuilder, request: &AiTextRequest) -> RequestBuilder {
    match request.provider.as_str() {
        "opencode" => opencode::apply_request(builder),
        _ => builder,
    }
}
