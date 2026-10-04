// T-004: Codex ブラウザ PKCE OAuth 実装
//
// 方針:
// - ローカルのコールバックサーバー (127.0.0.1:1455, /auth/callback) を一時的に立ち上げる
// - PKCE verifier/challenge と CSRF state を生成し、ブラウザを開いて認可 URL へ誘導
// - コールバックで code を受け取り、state 検証 → code 交換 → キーリング保存まで行う
// - タイムアウト / キャンセル / エラーは日本語エラーメッセージで返す
// - 成功・エラー画面はブラウザに安全な HTML を返す
// - キャンセルは各試行に固有の CancellationToken 経由で行う

use base64::engine::general_purpose::URL_SAFE_NO_PAD as BASE64URL;
use base64::Engine;
use rand::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;
use tokio::sync::oneshot;

use crate::ai::{auth::store, oauth::flow::OAuthFlow};
use tokio_util::sync::CancellationToken;

// ---- 定数（サンプル準拠） ----

const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER: &str = "https://auth.openai.com";
const DEFAULT_PORT: u16 = 1455;
const CALLBACK_PATH: &str = "/auth/callback";
const TIMEOUT_MINUTES: u64 = 5;

// ---- 認証試行の管理（Tauri managed state として登録） ----

#[derive(Clone, Default)]
pub struct OAuthCancelFlag(OAuthFlow);

impl OAuthCancelFlag {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self) {
        self.0.cancel();
    }
}

// ---- PKCE 関連 ----

struct PkceCodes {
    verifier: String,
    challenge: String,
}

/// cryptographically secure PKCE verifier (43 chars) + base64url(SHA-256(verifier))
fn generate_pkce() -> PkceCodes {
    const CHARSET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let mut rng = rand::rng();
    let verifier: String = (0..43)
        .map(|_| {
            let idx = rng.random_range(0..CHARSET.len());
            CHARSET[idx] as char
        })
        .collect();

    let hash = Sha256::digest(verifier.as_bytes());
    let challenge = BASE64URL.encode(hash);
    PkceCodes {
        verifier,
        challenge,
    }
}

/// cryptographically secure CSRF state (32 random bytes, base64url)
fn generate_state() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill(&mut bytes);
    BASE64URL.encode(bytes)
}

/// 認可 URL を組み立てる（サンプルの buildAuthorizeUrl 準拠）
fn build_authorize_url(redirect_uri: &str, pkce: &PkceCodes, state: &str) -> String {
    let params = [
        ("response_type", "code"),
        ("client_id", CLIENT_ID),
        ("redirect_uri", redirect_uri),
        ("scope", "openid profile email offline_access"),
        ("code_challenge", &pkce.challenge),
        ("code_challenge_method", "S256"),
        ("id_token_add_organizations", "true"),
        ("codex_cli_simplified_flow", "true"),
        ("state", state),
        ("originator", "opencode"),
    ];

    let query: String = params
        .iter()
        .map(|(k, v)| format!("{}={}", url_encode_param(k), url_encode_param(v)))
        .collect::<Vec<_>>()
        .join("&");

    format!("{}/oauth/authorize?{}", ISSUER, query)
}

/// URL エンコード（簡易版、ASCII 範囲の値だけ扱う）
fn url_encode_param(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                result.push(byte as char);
            }
            b' ' => result.push_str("%20"),
            _ => {
                result.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    result
}

/// UTF-8 対応の URL クエリデコード。
fn parse_query(query: &str) -> Vec<(String, String)> {
    // The URL implementation correctly decodes percent-encoded UTF-8 and +.
    reqwest::Url::parse(&format!("http://localhost/?{query}"))
        .map(|url| url.query_pairs().into_owned().collect())
        .unwrap_or_default()
}

// ---- コールバックサーバー ----

/// 1つの HTTP リクエストを読み取り、path と query params を返す。パース失敗は Err。
fn read_http_request(
    stream: &mut TcpStream,
    cancel: &CancellationToken,
) -> Result<(String, Vec<(String, String)>), String> {
    stream
        .set_read_timeout(Some(Duration::from_millis(200)))
        .map_err(|e| format!("コールバック読み取り設定エラー: {e}"))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(1)))
        .map_err(|e| format!("コールバック書き込み設定エラー: {e}"))?;
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    let mut request = Vec::new();
    let mut chunk = [0; 1024];
    // TCP may fragment the request line at any byte. A silent local socket
    // must not hold the callback listener or cancellation hostage.
    while !request.contains(&b'\n') {
        if cancel.is_cancelled() {
            return Err("認証がキャンセルされました。".into());
        }
        if std::time::Instant::now() >= deadline || request.len() >= 8192 {
            return Err("コールバックのリクエストが不完全です。".into());
        }
        match stream.read(&mut chunk) {
            Ok(0) => return Err("空または不完全なリクエストを受信しました".into()),
            Ok(count) => request.extend_from_slice(&chunk[..count]),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(error) => return Err(format!("リクエスト読み取りエラー: {error}")),
        }
    }
    let first_line = std::str::from_utf8(&request)
        .map_err(|_| "リクエストのエンコードが不正です")?
        .lines()
        .next()
        .ok_or("空のリクエスト行")?;
    let parts = first_line.split_whitespace().collect::<Vec<_>>();
    if parts.len() != 3 || parts[0] != "GET" || !parts[2].starts_with("HTTP/") {
        return Err("不正な HTTP リクエストです。".into());
    }
    let (path, query) = parts[1].split_once('?').unwrap_or((parts[1], ""));
    Ok((path.into(), parse_query(query)))
}

/// HTTP レスポンスをストリームに書き込む
fn send_http_response(stream: &mut TcpStream, status: &str, content_type: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        content_type,
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

/// 認証成功時にブラウザに表示する HTML（サンプルの OauthCallbackPage.success 相当）
fn success_html() -> &'static str {
    r#"<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>認可コード受信 - LITRA</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f0f4f8}
.card{background:#fff;border-radius:16px;padding:2.5rem;box-shadow:0 4px 24px rgba(0,0,0,.08);text-align:center;max-width:400px}
.icon{font-size:48px;margin-bottom:16px}
h1{color:#1b5e20;margin:0 0 8px;font-size:1.5rem}
p{color:#555;margin:0;line-height:1.6}
</style>
</head>
<body>
<div class="card">
<div class="icon">&#x2705;</div>
<h1>認可コードを受信しました</h1>
<p>LITRA でログイン処理を完了しています。<br>このウィンドウを閉じ、LITRA で結果を確認してください。</p>
</div>
</body>
</html>"#
}

/// 認証エラー時にブラウザに表示する HTML（機密情報を含まないメッセージのみ）
fn error_html(message: &str) -> String {
    // OAuth error_description is remote input. Escape it before embedding in HTML.
    let safe_msg = message
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;");
    format!(
        r#"<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>認証エラー - LITRA</title>
<style>
body{{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f0f4f8}}
.card{{background:#fff;border-radius:16px;padding:2.5rem;box-shadow:0 4px 24px rgba(0,0,0,.08);text-align:center;max-width:400px}}
.icon{{font-size:48px;margin-bottom:16px}}
h1{{color:#c62828;margin:0 0 8px;font-size:1.5rem}}
p{{color:#555;margin:0;line-height:1.6}}
</style>
</head>
<body>
<div class="card">
<div class="icon">&#x274C;</div>
<h1>認証エラー</h1>
<p>{}</p>
</div>
</body>
</html>"#,
        safe_msg
    )
}

// ---- トークン交換（サンプル準拠） ----

#[derive(Debug, Deserialize)]
struct TokenResponse {
    id_token: Option<String>,
    access_token: String,
    refresh_token: String,
    expires_in: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct IdTokenClaims {
    chatgpt_account_id: Option<String>,
    organizations: Option<Vec<IdTokenOrg>>,
    #[serde(rename = "https://api.openai.com/auth")]
    openai_auth: Option<OpenaiAuth>,
}

#[derive(Debug, Deserialize)]
struct IdTokenOrg {
    id: String,
}

#[derive(Debug, Deserialize)]
struct OpenaiAuth {
    chatgpt_account_id: Option<String>,
}

/// token から account ID を抽出（サンプルの extractAccountId 準拠）
fn extract_account_id_from_tokens(tokens: &TokenResponse) -> Option<String> {
    // id_token から優先抽出
    if let Some(id_token) = &tokens.id_token {
        if let Some(id) = extract_account_id_from_jwt(id_token) {
            return Some(id);
        }
    }
    // access_token からフォールバック
    extract_account_id_from_jwt(&tokens.access_token)
}

pub(crate) fn extract_account_id_from_jwt(token: &str) -> Option<String> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let decoded = BASE64URL.decode(parts[1]).ok()?;
    let claims: IdTokenClaims = serde_json::from_slice(&decoded).ok()?;

    claims
        .chatgpt_account_id
        .or_else(|| claims.openai_auth?.chatgpt_account_id)
        .or_else(|| Some(claims.organizations?.first()?.id.clone()))
}

/// 認可コードをトークンと交換する（サンプルの exchangeCodeForTokens 準拠）
async fn exchange_code_for_tokens(
    code: &str,
    redirect_uri: &str,
    code_verifier: &str,
) -> Result<TokenResponse, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("OAuth HTTP client error: {e}"))?;
    let params = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("client_id", CLIENT_ID),
        ("code_verifier", code_verifier),
    ];

    let body: String = params
        .iter()
        .map(|(k, v)| format!("{}={}", url_encode_param(k), url_encode_param(v)))
        .collect::<Vec<_>>()
        .join("&");

    let response = client
        .post(format!("{}/oauth/token", ISSUER))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("トークン交換リクエスト失敗: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!(
            "トークン交換に失敗しました ({}): {}",
            status,
            text.chars().take(200).collect::<String>()
        ));
    }

    let response_body = response
        .text()
        .await
        .map_err(|e| format!("トークン応答の読み取り失敗: {}", e))?;

    serde_json::from_str::<TokenResponse>(&response_body)
        .map_err(|e| format!("トークン応答の解析失敗: {}", e))
}

/// トークンをキーリングに保存する（既存の secrets モジュール経由）
async fn save_credential(tokens: &TokenResponse, cancel: CancellationToken) -> Result<(), String> {
    if tokens.access_token.trim().is_empty() || tokens.refresh_token.trim().is_empty() {
        return Err("OAuth から空のトークンが返されました。".into());
    }
    let account_id = extract_account_id_from_tokens(tokens);
    let expires = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64)
        .saturating_add(tokens.expires_in.unwrap_or(3600).saturating_mul(1000));
    store::write_json_cancellable(
        "codex",
        &serde_json::json!({
            "access": tokens.access_token,
            "refresh": tokens.refresh_token,
            "expires": expires,
            "accountId": account_id,
        }),
        cancel,
    )
    .await
}

// ---- 公開コマンド ----

#[derive(Debug, Serialize)]
pub struct CodexAuthResult {
    pub success: bool,
    pub message: String,
}

/// ブラウザ PKCE OAuth フロー全体を実行する Tauri コマンド。
/// 内部で TCP コールバックサーバーを起動し、PKCE 認可コードフローで認証する。
/// キャンセルは cancel_codex_browser_auth コマンド経由で現在の試行に通知する。
#[tauri::command]
pub async fn start_codex_browser_auth(
    _app: tauri::AppHandle,
    cancel_flag: tauri::State<'_, OAuthCancelFlag>,
) -> Result<CodexAuthResult, String> {
    let attempt = cancel_flag.0.begin()?;

    // ---- 1. PKCE & state 生成 ----
    let pkce = generate_pkce();
    let state = generate_state();

    // ---- 2. TCP サーバー起動 ----
    // OpenAI に登録されている Codex CLI の redirect URI は
    // `http://localhost:1455/auth/callback` と完全一致する必要がある。
    // 127.0.0.1 や任意ポートへ変えると authorize_hydra_invalid_request になる。
    let listener = TcpListener::bind(format!("127.0.0.1:{}", DEFAULT_PORT)).map_err(|e| {
        format!(
            "Codex 認証用ポート {} を使用できません。他の Codex/OpenCode を終了して再試行してください: {}",
            DEFAULT_PORT, e
        )
    })?;

    let redirect_uri = format!("http://localhost:{}{}", DEFAULT_PORT, CALLBACK_PATH);

    // ---- 3. 認可 URL 構築 ----
    let auth_url = build_authorize_url(&redirect_uri, &pkce, &state);

    // ---- 4. ブラウザで開く ----
    // tauri_plugin_opener::open_url(url, with) — アプリハンドル不要
    tauri_plugin_opener::open_url(&auth_url, None::<&str>)
        .map_err(|e| format!("ブラウザの起動に失敗しました: {}", e))?;

    // ---- 5. コールバック待機（別スレッド）----
    // 別スレッドで accept し、結果を oneshot で送る。
    // キャンセルフラグを定期的に確認する。
    let (result_tx, result_rx) = oneshot::channel::<Result<String, String>>();
    let state_clone = state.clone();
    let cancel = attempt.token.clone();

    listener
        .set_nonblocking(true)
        .map_err(|e| format!("OAuth listener error: {e}"))?;
    let worker = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(TIMEOUT_MINUTES * 60);

        loop {
            // キャンセルチェック
            if cancel.is_cancelled() {
                let _ = result_tx.send(Err("認証がキャンセルされました。".to_string()));
                return;
            }

            // タイムアウトチェック
            if std::time::Instant::now() > deadline {
                let _ = result_tx.send(Err(
                    "認証のタイムアウト (5分) になりました。もう一度お試しください。".to_string(),
                ));
                return;
            }

            match listener.accept() {
                Ok((mut stream, _)) => {
                    // このクロージャ内では ? を使わず、明示的に Result を組み立てる
                    let outcome = match read_http_request(&mut stream, &cancel) {
                        Ok((path, params)) => {
                            if path != CALLBACK_PATH {
                                send_http_response(
                                    &mut stream,
                                    "404 Not Found",
                                    "text/html; charset=utf-8",
                                    &error_html("無効なコールバックパスです。"),
                                );
                                continue;
                            }
                            let received_state = params
                                .iter()
                                .find(|(k, _)| k == "state")
                                .map(|(_, v)| v.as_str())
                                .unwrap_or("");

                            if received_state != state_clone {
                                send_http_response(
                                    &mut stream,
                                    "400 Bad Request",
                                    "text/html; charset=utf-8",
                                    &error_html(
                                        "CSRF 攻撃の可能性があります。認証をやり直してください。",
                                    ),
                                );
                                // Ignore unrelated/stale callbacks rather than letting
                                // them terminate the legitimate authentication attempt.
                                continue;
                            } else if let Some(error) = params.iter().find(|(k, _)| k == "error") {
                                let desc = params
                                    .iter()
                                    .find(|(k, _)| k == "error_description")
                                    .map(|(_, v)| v.as_str())
                                    .unwrap_or(&error.1);
                                send_http_response(
                                    &mut stream,
                                    "200 OK",
                                    "text/html; charset=utf-8",
                                    &error_html(desc),
                                );
                                Err(desc.to_string())
                            } else if let Some((_, code_val)) = params
                                .iter()
                                .find(|(k, value)| k == "code" && !value.is_empty())
                            {
                                send_http_response(
                                    &mut stream,
                                    "200 OK",
                                    "text/html; charset=utf-8",
                                    success_html(),
                                );
                                Ok(code_val.clone())
                            } else {
                                send_http_response(
                                    &mut stream,
                                    "400 Bad Request",
                                    "text/html; charset=utf-8",
                                    &error_html("認可コードがありません"),
                                );
                                Err("認可コードがありません".to_string())
                            }
                        }
                        Err(e) => {
                            send_http_response(
                                &mut stream,
                                "400 Bad Request",
                                "text/html; charset=utf-8",
                                &error_html(&e),
                            );
                            continue;
                        }
                    };
                    let _ = result_tx.send(outcome);
                    return;
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(200));
                    continue;
                }
                Err(e) => {
                    let _ = result_tx.send(Err(format!("コールバック受信エラー: {}", e)));
                    return;
                }
            }
        }
    });

    // Cancellation also covers token exchange, not just the callback wait.
    let callback = tokio::select! {
        biased;
        _ = attempt.token.cancelled() => Err("認証がキャンセルされました。".to_owned()),
        result = tokio::time::timeout(Duration::from_secs(TIMEOUT_MINUTES * 60 + 5), result_rx) => {
            result.map_err(|_| "認証がタイムアウトしました。".to_owned())
                .and_then(|result| result.map_err(|_| "OAuth callback stopped".to_owned()))
                .and_then(|result| result)
        }
    };
    // Ensure the old listener has released the fixed port before allowing a
    // new attempt. Signal its cancellation only when no callback was received.
    if callback.is_err() {
        attempt.token.cancel();
    }
    tokio::task::spawn_blocking(move || worker.join())
        .await
        .map_err(|e| format!("OAuth callback task failed: {e}"))?
        .map_err(|_| "OAuth callback thread failed".to_owned())?;
    let code = callback?;
    let tokens = tokio::select! {
        biased;
        _ = attempt.token.cancelled() => return Err("認証がキャンセルされました。".into()),
        result = exchange_code_for_tokens(&code, &redirect_uri, &pkce.verifier) => result?,
    };
    attempt.check()?;
    save_credential(&tokens, attempt.token.clone()).await?;

    Ok(CodexAuthResult {
        success: true,
        message: "ログインしました。".to_string(),
    })
}

/// 進行中のブラウザ OAuth をキャンセルする Tauri コマンド。
#[tauri::command]
pub async fn cancel_codex_browser_auth(
    cancel_flag: tauri::State<'_, OAuthCancelFlag>,
) -> Result<(), String> {
    cancel_flag.cancel();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_decoder_preserves_unicode_and_encoded_separators() {
        assert_eq!(
            parse_query("error_description=%E6%97%A5%E6%9C%AC%E8%AA%9E+a%26b&code=x%3Dy"),
            vec![
                ("error_description".into(), "日本語 a&b".into()),
                ("code".into(), "x=y".into())
            ]
        );
    }

    #[test]
    fn callback_reads_fragmented_request_line() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let sender = std::thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            for part in [
                "GET /auth/call",
                "back?code=abc&state=xyz ",
                "HTTP/1.1\r\n\r\n",
            ] {
                stream.write_all(part.as_bytes()).unwrap();
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        let (mut stream, _) = listener.accept().unwrap();
        let (path, params) = read_http_request(&mut stream, &CancellationToken::new()).unwrap();
        assert_eq!(path, CALLBACK_PATH);
        assert!(params.contains(&("code".into(), "abc".into())));
        sender.join().unwrap();
    }

    #[test]
    fn silent_callback_socket_cannot_block_cancellation() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let _client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut stream, _) = listener.accept().unwrap();
        let token = CancellationToken::new();
        token.cancel();
        let started = std::time::Instant::now();
        assert!(read_http_request(&mut stream, &token).is_err());
        assert!(started.elapsed() < Duration::from_millis(200));
    }

    #[test]
    fn callback_html_escapes_untrusted_error_text() {
        let html = error_html("<script>alert('x')</script>&");
        assert!(!html.contains("<script>"));
        assert!(html.contains("&lt;script&gt;"));
    }
}
