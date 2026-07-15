// T-004: Codex ブラウザ PKCE OAuth 実装
//
// 方針:
// - ローカルのコールバックサーバー (127.0.0.1:1455, /auth/callback) を一時的に立ち上げる
// - PKCE verifier/challenge と CSRF state を生成し、ブラウザを開いて認可 URL へ誘導
// - コールバックで code を受け取り、state 検証 → code 交換 → キーリング保存まで行う
// - タイムアウト / キャンセル / エラーは日本語エラーメッセージで返す
// - 成功・エラー画面はブラウザに安全な HTML を返す
// - キャンセルは cancel_codex_browser_auth コマンドから atomic フラグ経由で行う

use base64::engine::general_purpose::URL_SAFE_NO_PAD as BASE64URL;
use base64::Engine;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::oneshot;

use crate::secrets;

// ---- 定数（サンプル準拠） ----

const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER: &str = "https://auth.openai.com";
const DEFAULT_PORT: u16 = 1455;
const CALLBACK_PATH: &str = "/auth/callback";
const TIMEOUT_MINUTES: u64 = 5;

// ---- キャンセルフラグ（Tauri managed state として登録） ----

#[derive(Clone)]
pub struct OAuthCancelFlag(pub Arc<AtomicBool>);

impl OAuthCancelFlag {
    pub fn new() -> Self {
        OAuthCancelFlag(Arc::new(AtomicBool::new(false)))
    }

    pub fn reset(&self) {
        self.0.store(false, Ordering::SeqCst);
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    #[allow(dead_code)]
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
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
    let mut rng = rand::thread_rng();
    let verifier: String = (0..43)
        .map(|_| {
            let idx = rng.gen_range(0..CHARSET.len());
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
    rand::thread_rng().fill(&mut bytes);
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

/// URL デコード（簡易版）
fn url_decode_param(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut chars = input.chars();
    while let Some(c) = chars.next() {
        if c == '%' {
            let hex: String = chars.by_ref().take(2).collect();
            if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                result.push(byte as char);
            } else {
                result.push('%');
                result.push_str(&hex);
            }
        } else if c == '+' {
            result.push(' ');
        } else {
            result.push(c);
        }
    }
    result
}

/// URL クエリ文字列を key=value のリストにパースする
fn parse_query(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|s| !s.is_empty())
        .filter_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            let key = parts.next()?.to_string();
            let value = parts.next().unwrap_or("").to_string();
            Some((key, url_decode_param(&value)))
        })
        .collect()
}

// ---- コールバックサーバー ----

/// 1つの HTTP リクエストを読み取り、path と query params を返す。パース失敗は Err。
fn read_http_request(stream: &mut TcpStream) -> Result<(String, Vec<(String, String)>), String> {
    let mut buf = [0u8; 4096];
    let n = stream
        .read(&mut buf)
        .map_err(|e| format!("リクエスト読み取りエラー: {}", e))?;

    if n == 0 {
        return Err("空のリクエストを受信しました".to_string());
    }

    let request = std::str::from_utf8(&buf[..n])
        .map_err(|_| "リクエストのエンコードが不正です".to_string())?;

    // 1行目: "GET /auth/callback?code=xxx&state=yyy HTTP/1.1"
    let first_line = request
        .lines()
        .next()
        .ok_or_else(|| "空のリクエスト行".to_string())?;
    let parts: Vec<&str> = first_line.split_whitespace().collect();
    if parts.len() < 2 || parts[0] != "GET" {
        return Err(format!(
            "サポートされていないメソッド: {}",
            parts.first().unwrap_or(&"?")
        ));
    }

    let path_and_query = parts[1];

    // /cancel はキャンセルとして扱う
    if path_and_query == "/cancel" {
        return Err("認証がキャンセルされました".to_string());
    }

    let (path, query_str) = match path_and_query.find('?') {
        Some(pos) => (&path_and_query[..pos], &path_and_query[pos + 1..]),
        None => (path_and_query, ""),
    };

    if path != CALLBACK_PATH {
        return Err(format!("不明なパス: {}", path));
    }

    let params = parse_query(query_str);
    Ok((path.to_string(), params))
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
<title>認証完了 - LITRA</title>
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
<h1>認証完了</h1>
<p>ChatGPT アカウントの認証が完了しました。<br>このウィンドウは閉じて LITRA に戻ってください。</p>
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
    let client = reqwest::Client::new();
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
fn save_credential_sync(tokens: &TokenResponse) -> Result<(), String> {
    let account_id = extract_account_id_from_tokens(tokens);
    let expires = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
        + (tokens.expires_in.unwrap_or(3600) * 1000);

    let credential = serde_json::json!({
        "access": tokens.access_token,
        "refresh": tokens.refresh_token,
        "expires": expires,
        "accountId": account_id,
    });

    let json_str =
        serde_json::to_string(&credential).map_err(|e| format!("JSON シリアライズ失敗: {}", e))?;

    // Windows Credential Manager limits one password to 2560 UTF-16 code units.
    // Keep the same chunked format used by src/secrets.ts.
    // Windows stores the password as UTF-16 under a 2560-byte limit.
    // 1000 code points leaves room for surrogate pairs/backend overhead.
    const CHUNK_SIZE: usize = 1000;
    const BASE_KEY: &str = "oauth:codex";
    let chunks: Vec<String> = json_str
        .chars()
        .collect::<Vec<_>>()
        .chunks(CHUNK_SIZE)
        .map(|chunk| chunk.iter().collect())
        .collect();

    // Remove chunks from a previous chunked credential before replacing it.
    if let Some(previous) = secrets::get_secret(BASE_KEY)? {
        if let Some(count) = previous
            .strip_prefix("chunks:v1:")
            .and_then(|v| v.parse::<usize>().ok())
        {
            for index in 0..count.min(32) {
                secrets::delete_secret(&format!("{}:{}", BASE_KEY, index))?;
            }
        }
    }
    for (index, chunk) in chunks.iter().enumerate() {
        secrets::set_secret(&format!("{}:{}", BASE_KEY, index), chunk)?;
    }
    secrets::set_secret(BASE_KEY, &format!("chunks:v1:{}", chunks.len()))
}

// ---- 公開コマンド ----

#[derive(Debug, Serialize)]
pub struct CodexAuthResult {
    pub success: bool,
    pub message: String,
}

/// ブラウザ PKCE OAuth フロー全体を実行する Tauri コマンド。
/// 内部で TCP コールバックサーバーを起動し、PKCE 認可コードフローで認証する。
/// キャンセルは cancel_codex_browser_auth コマンド経由で atomic フラグを設定する。
#[tauri::command]
pub async fn start_codex_browser_auth(
    _app: tauri::AppHandle,
    cancel_flag: tauri::State<'_, OAuthCancelFlag>,
) -> Result<CodexAuthResult, String> {
    // キャンセルフラグをリセット
    cancel_flag.reset();

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
    let cancel = cancel_flag.0.clone();

    std::thread::spawn(move || {
        listener
            .set_nonblocking(true)
            .expect("set_nonblocking failed");

        let deadline = std::time::Instant::now() + Duration::from_secs(TIMEOUT_MINUTES * 60);

        loop {
            // キャンセルチェック
            if cancel.load(Ordering::SeqCst) {
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
                    let outcome = match read_http_request(&mut stream) {
                        Ok((path, params)) => {
                            if path != CALLBACK_PATH {
                                send_http_response(
                                    &mut stream,
                                    "404 Not Found",
                                    "text/html; charset=utf-8",
                                    &error_html("無効なコールバックパスです。"),
                                );
                                let _ =
                                    result_tx.send(Err("無効なコールバックパスです。".to_string()));
                                return;
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
                                Err("state 検証エラー: 値が一致しません".to_string())
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
                            } else if let Some((_, code_val)) =
                                params.iter().find(|(k, _)| k == "code")
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
                            Err(e)
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

    // ---- 6. 結果を待機（最長 TIMEOUT_MINUTES + 余裕）----
    let timeout_dur = Duration::from_secs(TIMEOUT_MINUTES * 60 + 30);
    let code = tokio::time::timeout(timeout_dur, result_rx)
        .await
        .map_err(|_| "認証のタイムアウト (5分) になりました。もう一度お試しください。".to_string())?
        .map_err(|_| "認証がキャンセルされました。".to_string())??;

    // ---- 7. トークン交換 ----
    let tokens = exchange_code_for_tokens(&code, &redirect_uri, &pkce.verifier).await?;

    // ---- 8. キーリングに保存 ----
    save_credential_sync(&tokens)?;

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
