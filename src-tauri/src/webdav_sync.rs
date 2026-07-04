use base64::Engine;
use quick_xml::events::Event;
use quick_xml::reader::Reader;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashSet, VecDeque},
    fs,
    path::{Component, Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

use crate::storage::{data_or_documents_dir, documents_dir, ensure_parent_dir};

const CONFIG_FILE: &str = "webdav-sync.json";
const SYNC_ROOT: &str = "litra";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[derive(Default)]
pub struct WebDavSyncConfig {
    pub enabled: bool,
    pub base_url: String,
    pub username: Option<String>,
    pub password: Option<String>,
    /// 保存先フォルダ（base_url 直下）。空文字や ".." "." は SYNC_ROOT にフォールバック。
    /// `#[serde(default)]` で既存設定ファイルとの後方互換性を確保。
    #[serde(default)]
    pub remote_folder: String,
}


#[derive(Debug)]
enum SyncJob {
    Put { path: String, content: String },
    Delete { path: String },
}

#[derive(Default)]
struct SyncState {
    queue: VecDeque<SyncJob>,
    draining: bool,
    ensured_dirs: HashSet<String>,
}

static SYNC_STATE: OnceLock<Mutex<SyncState>> = OnceLock::new();

fn state() -> &'static Mutex<SyncState> {
    SYNC_STATE.get_or_init(|| Mutex::new(SyncState::default()))
}

fn config_path() -> Result<PathBuf, String> {
    Ok(data_or_documents_dir()?.join("litra").join(CONFIG_FILE))
}

fn read_config() -> Result<WebDavSyncConfig, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(WebDavSyncConfig::default());
    }
    let text = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    serde_json::from_str(&text).map_err(|e| format!("Failed to parse {}: {}", path.display(), e))
}

fn write_config(config: &WebDavSyncConfig) -> Result<(), String> {
    let path = config_path()?;
    ensure_parent_dir(&path)?;
    let normalized = WebDavSyncConfig {
        enabled: config.enabled,
        base_url: config.base_url.trim().trim_end_matches('/').to_string(),
        username: config
            .username
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
        password: config
            .password
            .as_deref()
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
        remote_folder: normalize_remote_folder(&config.remote_folder),
    };
    fs::write(
        &path,
        serde_json::to_string_pretty(&normalized).expect("config serialization should not fail"),
    )
    .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    if let Ok(mut state) = state().lock() {
        state.ensured_dirs.clear();
    }
    Ok(())
}

#[tauri::command]
pub fn load_webdav_sync_config() -> Result<WebDavSyncConfig, String> {
    read_config()
}

#[tauri::command]
pub fn save_webdav_sync_config(config: WebDavSyncConfig) -> Result<(), String> {
    write_config(&config)
}

#[tauri::command]
pub fn write_document_text_file(path: String, contents: String) -> Result<(), String> {
    let local_path = document_relative_path(&path)?;
    ensure_parent_dir(&local_path)?;
    fs::write(&local_path, &contents)
        .map_err(|e| format!("Failed to write {}: {}", local_path.display(), e))?;
    enqueue_put_path(&local_path, contents);
    Ok(())
}

#[tauri::command]
pub fn remove_document_path(path: String, recursive: Option<bool>) -> Result<(), String> {
    let local_path = document_relative_path(&path)?;
    if recursive.unwrap_or(false) {
        fs::remove_dir_all(&local_path)
            .map_err(|e| format!("Failed to remove {}: {}", local_path.display(), e))?;
    } else {
        fs::remove_file(&local_path)
            .map_err(|e| format!("Failed to remove {}: {}", local_path.display(), e))?;
    }
    enqueue_delete_relative(normalize_relative_path(&path)?);
    Ok(())
}

pub fn enqueue_put_path(path: &Path, content: String) {
    let Ok(relative_path) = documents_relative_path(path) else {
        return;
    };
    enqueue(SyncJob::Put {
        path: relative_path,
        content,
    });
}

fn enqueue_delete_relative(path: String) {
    enqueue(SyncJob::Delete { path });
}

fn enqueue(job: SyncJob) {
    let Ok(config) = read_config() else {
        return;
    };
    if !config.enabled || config.base_url.trim().is_empty() {
        return;
    }

    let should_spawn = {
        let mut state = state().lock().expect("webdav sync state poisoned");
        state.queue.push_back(job);
        if state.draining {
            false
        } else {
            state.draining = true;
            true
        }
    };

    if should_spawn {
        tauri::async_runtime::spawn(async {
            drain_queue().await;
        });
    }
}

async fn drain_queue() {
    loop {
        let job = {
            let mut state = state().lock().expect("webdav sync state poisoned");
            match state.queue.pop_front() {
                Some(job) => job,
                None => {
                    state.draining = false;
                    return;
                }
            }
        };

        if let Err(error) = run_job(job).await {
            eprintln!("[litra:webdav] sync failed: {error}");
        }
    }
}

async fn run_job(job: SyncJob) -> Result<(), String> {
    match job {
        SyncJob::Put { path, content } => {
            put_remote_file(&path, content).await?;
        }
        SyncJob::Delete { path } => {
            let remote_relative = local_to_remote_relative(&path)?;
            let url = remote_url_for(&remote_relative)?;
            let response = client()
                .delete(&url)
                .headers(auth_headers()?)
                .send()
                .await
                .map_err(|e| format!("DELETE {remote_relative} failed: {e}"))?;
            if !response.status().is_success() && response.status().as_u16() != 404 {
                return Err(format!("DELETE {remote_relative} failed: {}", response.status()));
            }
        }
    }
    Ok(())
}

/// ローカル相対パス（`litra/...`）の内容をリモートに PUT する。
/// 親コレクションが無ければ作成してから送信する。
async fn put_remote_file(local_relative: &str, content: String) -> Result<(), String> {
    let remote_relative = local_to_remote_relative(local_relative)?;
    ensure_remote_parents(&remote_relative).await?;
    let url = remote_url_for(&remote_relative)?;
    let response = client()
        .put(&url)
        .headers(auth_headers()?)
        .body(content)
        .send()
        .await
        .map_err(|e| format!("PUT {remote_relative} failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("PUT {remote_relative} failed: {}", response.status()));
    }
    Ok(())
}

async fn ensure_remote_parents(remote_relative: &str) -> Result<(), String> {
    let parts: Vec<&str> = remote_relative
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    // 最後のセグメント（ファイル名）を除いてディレクトリを保証
    if parts.len() <= 1 {
        return Ok(());
    }

    let mut current = String::new();
    for part in &parts[..parts.len() - 1] {
        if current.is_empty() {
            current.push_str(part);
        } else {
            current.push('/');
            current.push_str(part);
        }
        let url = remote_url_for(&current)?;
        ensure_remote_dir_exists(&url).await?;
    }
    Ok(())
}

/// `remote_folder` を正規化する。空文字や `"." / ".."` を含む値は既定値にフォールバック。
fn normalize_remote_folder(value: &str) -> String {
    let trimmed = value.trim().trim_matches('/');
    if trimmed.is_empty() {
        return SYNC_ROOT.to_string();
    }
    let parts: Vec<&str> = trimmed.split('/').filter(|p| !p.is_empty()).collect();
    // 安全のため "." / ".." セグメントを拒否（既定値にフォールバック）
    if parts.iter().any(|p| *p == ".." || *p == ".") {
        return SYNC_ROOT.to_string();
    }
    parts.join("/")
}

/// ローカル相対パス（`litra/...`）をリモート相対パス（`{remote_folder}/...`）に変換する。
fn local_to_remote_relative(path: &str) -> Result<String, String> {
    let config = read_config()?;
    let remote_folder = normalize_remote_folder(&config.remote_folder);
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    // 先頭が SYNC_ROOT("litra") ならそれを取り除き、remote_folder を前置する
    let rest: &[&str] = if parts.first() == Some(&SYNC_ROOT) {
        &parts[1..]
    } else {
        &parts[..]
    };
    let mut remote_parts: Vec<&str> = remote_folder
        .split('/')
        .filter(|p| !p.is_empty())
        .collect();
    remote_parts.extend_from_slice(rest);
    Ok(remote_parts.join("/"))
}

/// 完全 URL の MKCOL を送信してステータスコードを返す。
async fn mkcol(full_url: &str) -> Result<u16, String> {
    let response = client()
        .request(
            reqwest::Method::from_bytes(b"MKCOL").expect("valid method"),
            full_url,
        )
        .headers(auth_headers()?)
        .send()
        .await
        .map_err(|e| format!("MKCOL {full_url} failed: {e}"))?;
    Ok(response.status().as_u16())
}

/// 完全 URL の親 URL を返す。ホストルートに到達したら `None`。
/// `url` クレートは使わず、文字列操作で安全に切り詰める。
fn parent_url(full_url: &str) -> Option<String> {
    // クエリ/フラグメントがあればそれ以降を切り捨てる
    let url = if let Some(idx) = full_url.find(['?', '#']) {
        &full_url[..idx]
    } else {
        full_url
    };

    let scheme_end = url.find("://")?;
    let after_scheme = &url[scheme_end + 3..];
    let path_start = after_scheme.find('/')?;
    let host_part = &after_scheme[..path_start];
    let path = after_scheme[path_start..].trim_end_matches('/');
    let last_slash = path.rfind('/')?;
    let parent_path = &path[..last_slash];
    if parent_path.is_empty() {
        return None;
    }
    let scheme = &url[..scheme_end];
    Some(format!("{scheme}://{host_part}{parent_path}"))
}

/// 完全 URL で指定されたディレクトリを WebDAV 上に確保する。
/// 409 Conflict の場合は親コレクションを再帰的に作成してから再試行する。
/// 成功した（201/200/405: Method Not Allowed = 既存）ディレクトリ URL はキャッシュして再送を防ぐ。
async fn ensure_remote_dir_exists(full_url: &str) -> Result<(), String> {
    {
        let state = state().lock().expect("webdav sync state poisoned");
        if state.ensured_dirs.contains(full_url) {
            return Ok(());
        }
    }

    let status = mkcol(full_url).await?;
    match status {
        201 | 200 | 405 => {
            let mut state = state().lock().expect("webdav sync state poisoned");
            state.ensured_dirs.insert(full_url.to_string());
            Ok(())
        }
        409 => {
            // 親コレクションが存在しない。親を再帰的に作成してから再試行する。
            // Rust の async fn は再帰呼び出しのサイズ未知のため Box::pin で heap 化する。
            let Some(parent) = parent_url(full_url) else {
                return Err(format!(
                    "MKCOL {full_url} failed: 409 Conflict (親コレクションを作成できません; WebDAV のベース URL を確認してください)"
                ));
            };
            Box::pin(ensure_remote_dir_exists(&parent)).await?;
            let retry_status = mkcol(full_url).await?;
            match retry_status {
                201 | 200 | 405 => {
                    let mut state = state().lock().expect("webdav sync state poisoned");
                    state.ensured_dirs.insert(full_url.to_string());
                    Ok(())
                }
                401 | 403 => Err(format!(
                    "MKCOL {full_url} failed: {retry_status} (認証または権限のエラー; WebDAV の URL と認証情報を確認してください)"
                )),
                other => Err(format!("MKCOL {full_url} failed: {other}")),
            }
        }
        401 | 403 => Err(format!(
            "MKCOL {full_url} failed: {status} (認証または権限のエラー; WebDAV の URL と認証情報を確認してください)"
        )),
        other => Err(format!("MKCOL {full_url} failed: {other}")),
    }
}

fn client() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .build()
                .expect("failed to build reqwest client")
        })
        .clone()
}

fn auth_headers() -> Result<HeaderMap, String> {
    let config = read_config()?;
    let mut headers = HeaderMap::new();
    let Some(username) = config.username.filter(|value| !value.is_empty()) else {
        return Ok(headers);
    };
    let password = config.password.unwrap_or_default();
    let encoded =
        base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"));
    let value = HeaderValue::from_str(&format!("Basic {encoded}"))
        .map_err(|e| format!("Invalid authorization header: {e}"))?;
    headers.insert(AUTHORIZATION, value);
    Ok(headers)
}

fn remote_url_for(path: &str) -> Result<String, String> {
    let config = read_config()?;
    let encoded_path = path
        .split('/')
        .filter(|part| !part.is_empty())
        .map(url_encode_path_segment)
        .collect::<Vec<_>>()
        .join("/");
    Ok(format!(
        "{}/{}",
        config.base_url.trim().trim_end_matches('/'),
        encoded_path
    ))
}

fn document_relative_path(path: &str) -> Result<PathBuf, String> {
    Ok(documents_dir()?.join(normalize_relative_path(path)?))
}

fn documents_relative_path(path: &Path) -> Result<String, String> {
    let documents = documents_dir()?;
    let relative = path
        .strip_prefix(&documents)
        .map_err(|_| format!("Path is outside Documents: {}", path.display()))?;
    normalize_relative_path(&relative.to_string_lossy())
}

fn normalize_relative_path(path: &str) -> Result<String, String> {
    let normalized = path.replace('\\', "/");
    let path = Path::new(&normalized);
    if path.is_absolute() {
        return Err("Absolute paths are not allowed".to_string());
    }

    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().to_string()),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err("Parent path components are not allowed".to_string())
            }
            _ => return Err("Unsupported path component".to_string()),
        }
    }

    if parts.first().map(String::as_str) != Some(SYNC_ROOT) {
        return Err("Only litra document paths can be synchronized".to_string());
    }

    Ok(parts.join("/"))
}

fn url_encode_path_segment(segment: &str) -> String {
    segment
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

// ============================================================================
// Full sync (pull / push) - recursive WebDAV operations
// ============================================================================

const SYNC_PROGRESS_EVENT: &str = "webdav-sync-progress";
const SYNC_ERROR_LOG_LIMIT: usize = 10;
const PROGRESS_EMIT_EVERY: usize = 10;
const QUEUE_DRAIN_TIMEOUT_MS: u64 = 120_000;
const QUEUE_DRAIN_POLL_MS: u64 = 100;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSummary {
    pub files_processed: usize,
    pub files_failed: usize,
    pub errors: Vec<String>,
}

impl SyncSummary {
    fn record_error(&mut self, message: String) {
        if self.errors.len() < SYNC_ERROR_LOG_LIMIT {
            self.errors.push(message);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncProgressPayload {
    phase: String,
    current: usize,
    total: usize,
    message: String,
}

#[derive(Debug, Clone)]
struct RemoteEntry {
    href: String,
    is_collection: bool,
}

/// 完全同期用の WebDAV ルート URL（`{base_url}/{remote_folder}/`）を返す。
fn remote_root_url() -> Result<String, String> {
    let config = read_config()?;
    let folder = normalize_remote_folder(&config.remote_folder);
    remote_url_for(&folder)
}

/// `litra/` 配下の全ファイル（ディレクトリは除く）を再帰的に列挙する。
/// 戻り値の各パスは絶対 PathBuf。
fn walk_local_litra_tree() -> Result<Vec<PathBuf>, String> {
    let root = documents_dir()?.join(SYNC_ROOT);
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    walk_local_recursive(&root, &mut files)?;
    Ok(files)
}

fn walk_local_recursive(dir: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = fs::read_dir(dir)
        .map_err(|e| format!("Failed to read directory {}: {}", dir.display(), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read dir entry: {e}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Failed to read file type {}: {}", path.display(), e))?;
        if file_type.is_dir() {
            walk_local_recursive(&path, files)?;
        } else if file_type.is_file() {
            files.push(path);
        }
        // シンボリックリンク等（is_dir でも is_file でもない特殊なエントリ）は
        // 追跡先を辿らず明示的にスキップする（誤削除・シンボリックリンクループ防止）。
    }
    Ok(())
}

/// `href` の末尾セグメントを取り出し、`%XX` をデコードして返す。
/// ディレクトリを示す末尾 `/` は取り除いてから抽出する。
fn last_path_segment_from_href(href: &str) -> Option<String> {
    let trimmed = href.trim_end_matches('/');
    let last_slash = trimmed.rfind('/')?;
    let raw = &trimmed[last_slash + 1..];
    if raw.is_empty() {
        return None;
    }
    Some(percent_decode(raw))
}

/// `%XX` を ASCII / UTF-8 バイト列としてデコードする。
/// 不正なエンコードはそのまま残す（クラッシュ回避）。
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = hex_value(bytes[i + 1]);
            let lo = hex_value(bytes[i + 2]);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| input.to_string())
}

/// href またはリクエスト URL からパス部分だけを取り出し、デコードして末尾 `/` を除去する。
/// href は絶対 URL（`https://host/path`）と絶対パス（`/path`）のどちらの形式でも
/// 返され得るため、比較用に正規化する。
fn normalize_href_path(value: &str) -> String {
    let path = if let Some(idx) = value.find("://") {
        let after = &value[idx + 3..];
        match after.find('/') {
            Some(p) => &after[p..],
            None => "/",
        }
    } else {
        value
    };
    percent_decode(path.trim_end_matches('/'))
}

/// パスセグメントとして安全な名前かどうかを判定する。
/// 空文字・`.`・`..` に加えて、パーセントデコード後に `/`・`\` を含むものも拒否する
/// （デコード前に分割した名前がデコード後にパス区切りを含み、ディレクトリトラバーサルに
/// 悪用され得るため）。
fn is_safe_name_segment(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains('/') && !name.contains('\\')
}

fn hex_value(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// PROPFIND を送信し、`Depth: <depth>` のレスポンスからエントリ一覧を返す。
/// 戻り値の先頭要素はリクエスト URL 自身（ルート）なので呼び出し側でスキップすること。
async fn propfind(url: &str, depth: &str) -> Result<Vec<RemoteEntry>, String> {
    let body = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<propfind xmlns=\"DAV:\">\n  <prop>\n    <resourcetype/>\n  </prop>\n</propfind>\n";

    let response = client()
        .request(
            reqwest::Method::from_bytes(b"PROPFIND").expect("PROPFIND is a valid method"),
            url,
        )
        .headers(auth_headers()?)
        .header("Depth", depth)
        .header("Content-Type", "application/xml; charset=utf-8")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("PROPFIND {url} failed: {e}"))?;

    let status = response.status();
    if !status.is_success() && status.as_u16() != 207 {
        return Err(format!("PROPFIND {url} failed: {status}"));
    }

    let text = response
        .text()
        .await
        .map_err(|e| format!("PROPFIND {url} body read failed: {e}"))?;

    parse_propfind_response(&text)
}

/// 207 Multi-Status の XML レスポンスをパースして `RemoteEntry` の Vec を返す。
/// `<response>` 要素内の `<href>` と `<resourcetype>` を読み取る。
/// 名前空間プレフィックスは `local_name()` で吸収する。
fn parse_propfind_response(xml: &str) -> Result<Vec<RemoteEntry>, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut entries: Vec<RemoteEntry> = Vec::new();
    let mut buf = Vec::new();

    let mut in_response = false;
    let mut in_href = false;
    let mut in_resourcetype = false;
    let mut current_href = String::new();
    let mut is_collection = false;

    loop {
        match reader
            .read_event_into(&mut buf)
            .map_err(|e| format!("XML parse error: {e}"))?
        {
            Event::Start(e) => {
                let name = e.name();
                let local = name.local_name();
                if local.as_ref() == b"response" {
                    in_response = true;
                    current_href.clear();
                    is_collection = false;
                } else if in_response && local.as_ref() == b"href" {
                    in_href = true;
                } else if in_response && local.as_ref() == b"resourcetype" {
                    in_resourcetype = true;
                } else if in_response && in_resourcetype && local.as_ref() == b"collection" {
                    // `<collection></collection>`（Start/End 形式）を返すサーバー向け
                    is_collection = true;
                }
            }
            Event::Empty(e) => {
                let local = e.name().local_name();
                if in_response && in_resourcetype && local.as_ref() == b"collection" {
                    // `<collection/>`（自己終了形式）を返すサーバー向け
                    is_collection = true;
                }
            }
            Event::Text(e) => {
                if in_response && in_href {
                    match e.unescape() {
                        Ok(text) => current_href.push_str(&text),
                        Err(err) => {
                            return Err(format!("XML unescape failed: {err}"));
                        }
                    }
                }
            }
            Event::End(e) => {
                let local = e.name().local_name();
                if local.as_ref() == b"href" {
                    in_href = false;
                } else if local.as_ref() == b"resourcetype" {
                    in_resourcetype = false;
                } else if local.as_ref() == b"response" {
                    if in_response && !current_href.is_empty() {
                        entries.push(RemoteEntry {
                            href: current_href.clone(),
                            is_collection,
                        });
                    }
                    in_response = false;
                    current_href.clear();
                    is_collection = false;
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    Ok(entries)
}

/// WebDAV サーバーから 1 ファイルのテキスト内容を取得する。
async fn get_remote_file(url: &str) -> Result<String, String> {
    let response = client()
        .get(url)
        .headers(auth_headers()?)
        .send()
        .await
        .map_err(|e| format!("GET {url} failed: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("GET {url} failed: {status}"));
    }

    response
        .text()
        .await
        .map_err(|e| format!("GET {url} body read failed: {e}"))
}

/// 進捗イベントを 10 件ごとに間引いて発火する。
/// `force=true` で強制発火（最初/最後用）。
fn emit_progress(
    app: &AppHandle,
    phase: &str,
    current: usize,
    total: usize,
    message: &str,
    force: bool,
) {
    if !force && !current.is_multiple_of(PROGRESS_EMIT_EVERY) {
        return;
    }
    let payload = SyncProgressPayload {
        phase: phase.to_string(),
        current,
        total,
        message: message.to_string(),
    };
    if let Err(error) = app.emit(SYNC_PROGRESS_EVENT, payload) {
        eprintln!("[litra:webdav] failed to emit progress: {error}");
    }
}

/// 現在のキューが空になり、ドレイナも完了するまで最大 `timeout_ms` ミリ秒待機する。
/// 完了したら `true`、タイムアウトなら `false`。
async fn wait_queue_drain(timeout_ms: u64) -> bool {
    let timeout = Duration::from_millis(timeout_ms);
    let join = tauri::async_runtime::spawn_blocking(move || {
        let start = Instant::now();
        loop {
            let done = {
                let state = state().lock().expect("webdav sync state poisoned");
                state.queue.is_empty() && !state.draining
            };
            if done {
                return true;
            }
            if start.elapsed() > timeout {
                return false;
            }
            std::thread::sleep(Duration::from_millis(QUEUE_DRAIN_POLL_MS));
        }
    });
    match join.await {
        Ok(result) => result,
        Err(error) => {
            eprintln!("[litra:webdav] wait_queue_drain join error: {error}");
            false
        }
    }
}

/// WebDAV から全ファイルをダウンロードし、ローカルを完全ミラー化する。
/// リモートに存在しないローカルファイルは削除する（リモートファイル数 0 の場合は安全装置として削除スキップ）。
#[tauri::command]
pub async fn pull_webdav_all(app: AppHandle) -> Result<SyncSummary, String> {
    let config = read_config()?;
    if !config.enabled || config.base_url.trim().is_empty() {
        return Ok(SyncSummary::default());
    }

    let mut summary = SyncSummary::default();
    let mut remote_files: HashSet<String> = HashSet::new();

    let root_url = match remote_root_url() {
        Ok(value) => value,
        Err(e) => {
            summary.record_error(format!("remote_root_url: {e}"));
            return Ok(summary);
        }
    };

    // ルートディレクトリの存在を保証（ベストエフォート）
    if let Err(e) = ensure_remote_dir_exists(&root_url).await {
        eprintln!("[litra:webdav] ensure_remote_dir_exists(root) warning: {e}");
    }

    let root_local = match documents_dir() {
        Ok(value) => value.join(SYNC_ROOT),
        Err(e) => {
            summary.record_error(format!("documents_dir: {e}"));
            return Ok(summary);
        }
    };

    emit_progress(
        &app,
        "pull",
        0,
        0,
        "WebDavから同期中...",
        true,
    );

    // Pull フェーズ
    if let Err(e) = pull_directory(&app, &root_url, &root_local, &mut remote_files, &mut summary)
        .await
    {
        summary.record_error(format!("pull_directory: {e}"));
    }

    // 削除フェーズ:
    // - リモートファイル数が 0 の場合はスキップ（誤って全削除しないための安全装置）
    // - pull 中に何らかのエラー（PROPFIND 失敗・GET 失敗・書き込み失敗等）が発生した場合も
    //   スキップする。remote_files の集合が不完全な可能性があり、実際にはリモートに
    //   存在するファイルを誤って削除してしまうおそれがあるため。
    if remote_files.is_empty() {
        eprintln!(
            "[litra:webdav] pull: remote returned 0 files; skipping local deletion for safety"
        );
    } else if !summary.errors.is_empty() {
        eprintln!(
            "[litra:webdav] pull: encountered errors during pull; skipping local deletion for safety"
        );
    } else if let Err(e) = delete_local_extras(&root_local, &remote_files, &mut summary) {
        summary.record_error(format!("delete_local_extras: {e}"));
    }

    let total = summary.files_processed;
    emit_progress(
        &app,
        "pull",
        total,
        total,
        "WebDavからの同期が完了しました",
        true,
    );

    Ok(summary)
}

/// 1 ディレクトリ分のリモート→ローカル pull。
/// `remote_url` の末尾には `/` を付ける。
async fn pull_directory(
    app: &AppHandle,
    remote_url: &str,
    local_dir: &Path,
    remote_files: &mut HashSet<String>,
    summary: &mut SyncSummary,
) -> Result<(), String> {
    if let Err(e) = fs::create_dir_all(local_dir) {
        return Err(format!(
            "Failed to create local dir {}: {}",
            local_dir.display(),
            e
        ));
    }

    let entries = match propfind(remote_url, "1").await {
        Ok(value) => value,
        Err(e) => {
            // 一部ディレクトリの失敗はスキップして続行するが、このサブツリーの内容は
            // 不明なので summary.errors に記録し、削除フェーズを安全に抑止する
            // （pull_webdav_all 側で errors が空でない場合は削除をスキップする）。
            summary.record_error(format!("PROPFIND {remote_url}: {e}"));
            emit_progress(
                app,
                "pull",
                summary.files_processed,
                0,
                &format!("PROPFIND 失敗をスキップ: {remote_url}"),
                true,
            );
            return Ok(());
        }
    };

    // レスポンス順序は RFC 4918 で保証されないため、位置（先頭 = 自分自身）ではなく
    // パスの一致で自己エントリを除外する。
    let self_path = normalize_href_path(remote_url);

    for entry in entries {
        if normalize_href_path(&entry.href) == self_path {
            continue;
        }

        let name = match last_path_segment_from_href(&entry.href) {
            Some(value) => value,
            None => continue,
        };

        if !is_safe_name_segment(&name) {
            summary.record_error(format!("Unsafe path segment skipped: {name}"));
            continue;
        }

        let child_remote_url = if entry.is_collection {
            format!("{}/", join_remote_url(remote_url, &name))
        } else {
            join_remote_url(remote_url, &name)
        };

        let child_local = local_dir.join(&name);

        if entry.is_collection {
            // 再帰
            Box::pin(pull_directory(
                app,
                &child_remote_url,
                &child_local,
                remote_files,
                summary,
            ))
            .await?;
        } else {
            // ★重要: このファイルがリモートに存在するという事実は、ダウンロードの
            // 成否とは独立に記録する。GET/書き込みが失敗しても、リモートに実在する
            // ファイルのローカルコピーを「リモートに無い」として削除してはならない。
            if let Ok(rel) = child_local.strip_prefix(
                documents_dir()
                    .map(|d| d.join(SYNC_ROOT))
                    .unwrap_or_else(|_| PathBuf::from(SYNC_ROOT)),
            ) {
                let rel_str = rel.to_string_lossy().replace('\\', "/");
                remote_files.insert(rel_str);
            }

            let content = match get_remote_file(&child_remote_url).await {
                Ok(value) => value,
                Err(e) => {
                    summary.files_failed += 1;
                    summary.record_error(format!("GET {child_remote_url}: {e}"));
                    continue;
                }
            };
            // 親ディレクトリを保証（既に作成済みだが、安全のため）
            if let Err(e) = ensure_parent_dir(&child_local) {
                summary.files_failed += 1;
                summary.record_error(format!(
                    "ensure_parent_dir {}: {}",
                    child_local.display(),
                    e
                ));
                continue;
            }
            // ★重要: pull で書き込む際は enqueue を呼ばない（無限ループ防止）。
            // 直接 std::fs::write を使い、storage::write_text や enqueue_put_path は使わない。
            if let Err(e) = fs::write(&child_local, content.as_bytes()) {
                summary.files_failed += 1;
                summary
                    .record_error(format!("fs::write {}: {}", child_local.display(), e));
                continue;
            }

            summary.files_processed += 1;
            emit_progress(
                app,
                "pull",
                summary.files_processed,
                0,
                &format!("取得: {}", child_local.display()),
                false,
            );
        }
    }

    Ok(())
}

/// `base_url + name` を `URLエンコード` しながら結合する。`base_url` が末尾 `/` で終わることを保証。
fn join_remote_url(base_url: &str, name: &str) -> String {
    let base = base_url.trim_end_matches('/');
    format!("{}/{}", base, url_encode_path_segment(name))
}

/// リモートに存在しないローカルファイルを削除し、空ディレクトリをクリーンアップする。
fn delete_local_extras(
    root_local: &Path,
    remote_files: &HashSet<String>,
    summary: &mut SyncSummary,
) -> Result<(), String> {
    let all_files = walk_local_litra_tree()?;
    let prefix = documents_dir()
        .map(|d| d.join(SYNC_ROOT))
        .unwrap_or_else(|_| PathBuf::from(SYNC_ROOT));

    for file in all_files {
        let rel = match file.strip_prefix(&prefix) {
            Ok(value) => value.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if !remote_files.contains(&rel) {
            if let Err(e) = fs::remove_file(&file) {
                summary.files_failed += 1;
                summary.record_error(format!(
                    "remove_file {}: {}",
                    file.display(),
                    e
                ));
            }
        }
    }

    // 空ディレクトリのクリーンアップ（ルート自体は残す）
    if root_local.exists() {
        cleanup_empty_dirs(root_local)?;
    }
    Ok(())
}

/// 空のディレクトリを再帰的に削除する（root_local 自体は残す）。
fn cleanup_empty_dirs(dir: &Path) -> Result<(), String> {
    let entries = match fs::read_dir(dir) {
        Ok(value) => value,
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            cleanup_empty_dirs(&path)?;
            // 配下を処理した後、空なら削除
            if let Ok(mut inner) = fs::read_dir(&path) {
                if inner.next().is_none() {
                    let _ = fs::remove_dir(&path);
                }
            }
        }
    }
    Ok(())
}

/// ローカルの全ファイルを WebDAV にアップロード（full push）する。
/// ファイルごとに直接 PUT し、成功/失敗を正確に summary へ集計する。
#[tauri::command]
pub async fn push_webdav_all(app: AppHandle) -> Result<SyncSummary, String> {
    let config = read_config()?;
    if !config.enabled || config.base_url.trim().is_empty() {
        return Ok(SyncSummary::default());
    }

    let mut summary = SyncSummary::default();

    let files = match walk_local_litra_tree() {
        Ok(value) => value,
        Err(e) => {
            summary.record_error(format!("walk_local_litra_tree: {e}"));
            return Ok(summary);
        }
    };

    let total = files.len();
    emit_progress(&app, "push", 0, total, "WebDavに同期中...", true);

    // ルートディレクトリを先に保証
    if let Ok(root_url) = remote_root_url() {
        if let Err(e) = ensure_remote_dir_exists(&root_url).await {
            summary.record_error(format!("ensure_remote_dir_exists root: {e}"));
        }
    }

    for (idx, path) in files.iter().enumerate() {
        let content = match fs::read_to_string(path) {
            Ok(value) => value,
            Err(e) => {
                // UTF-8 でないバイナリファイル等はスキップ
                summary.files_failed += 1;
                summary.record_error(format!("read_to_string {}: {}", path.display(), e));
                continue;
            }
        };

        let local_relative = match documents_relative_path(path) {
            Ok(value) => value,
            Err(e) => {
                summary.files_failed += 1;
                summary.record_error(format!(
                    "documents_relative_path {}: {}",
                    path.display(),
                    e
                ));
                continue;
            }
        };

        // 直接 PUT する（enqueue_put_path 経由のバックグラウンドキューだと
        // 成否がドレイン完了までわからず、summary に反映できないため）。
        match put_remote_file(&local_relative, content).await {
            Ok(()) => summary.files_processed += 1,
            Err(e) => {
                summary.files_failed += 1;
                summary.record_error(format!("PUT {}: {}", path.display(), e));
            }
        }

        let current = idx + 1;
        emit_progress(
            &app,
            "push",
            current,
            total,
            &format!("送信: {}", path.display()),
            current == total || current % PROGRESS_EMIT_EVERY == 0,
        );
    }

    // full push とは別に、通常編集による自動同期キュー（enqueue_put_path 経由）に
    // 未処理のジョブが残っている場合に備え、キューが空になるまで待機する（最大 120 秒）。
    let drained = wait_queue_drain(QUEUE_DRAIN_TIMEOUT_MS).await;
    if !drained {
        summary.record_error(format!(
            "push_webdav_all: background queue drain timed out after {QUEUE_DRAIN_TIMEOUT_MS}ms"
        ));
    }

    emit_progress(
        &app,
        "push",
        total,
        total,
        "WebDavへの同期が完了しました",
        true,
    );

    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decode_handles_basic() {
        assert_eq!(percent_decode("hello"), "hello");
        assert_eq!(percent_decode("hello%20world"), "hello world");
        assert_eq!(percent_decode("a%2Bb"), "a+b");
        // 不正なエンコードはそのまま
        assert_eq!(percent_decode("a%2"), "a%2");
        assert_eq!(percent_decode("a%XY"), "a%XY");
    }

    #[test]
    fn last_segment_from_href() {
        assert_eq!(
            last_path_segment_from_href("/litra/projects/foo.json"),
            Some("foo.json".to_string())
        );
        assert_eq!(
            last_path_segment_from_href("/litra/projects/foo%20bar/"),
            Some("foo bar".to_string())
        );
        assert_eq!(
            last_path_segment_from_href("https://example.com/litra/"),
            Some("litra".to_string())
        );
        assert_eq!(last_path_segment_from_href("/"), None);
    }

    #[test]
    fn parse_propfind_finds_collection_and_files() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/litra/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/></D:resourcetype>
      </D:prop>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/litra/projects/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/></D:resourcetype>
      </D:prop>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/litra/projects/foo.json</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype/>
      </D:prop>
    </D:propstat>
  </D:response>
</D:multistatus>"#;
        let entries = parse_propfind_response(xml).expect("parse ok");
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].href, "/litra/");
        assert!(entries[0].is_collection);
        assert_eq!(entries[1].href, "/litra/projects/");
        assert!(entries[1].is_collection);
        assert_eq!(entries[2].href, "/litra/projects/foo.json");
        assert!(!entries[2].is_collection);
    }

    #[test]
    fn parse_propfind_handles_start_end_collection_element() {
        // 一部サーバーは <collection/> ではなく <collection></collection> を返す
        let xml = r#"<?xml version="1.0"?>
<multistatus xmlns="DAV:">
  <response>
    <href>/litra/projects/</href>
    <propstat>
      <prop>
        <resourcetype><collection></collection></resourcetype>
      </prop>
    </propstat>
  </response>
</multistatus>"#;
        let entries = parse_propfind_response(xml).expect("parse ok");
        assert_eq!(entries.len(), 1);
        assert!(entries[0].is_collection);
    }

    #[test]
    fn normalize_href_path_strips_scheme_host_and_trailing_slash() {
        assert_eq!(normalize_href_path("/litra/projects/"), "/litra/projects");
        assert_eq!(
            normalize_href_path("https://example.com/litra/projects/"),
            "/litra/projects"
        );
        assert_eq!(
            normalize_href_path("https://example.com/litra/projects"),
            "/litra/projects"
        );
        assert_eq!(
            normalize_href_path("/litra/foo%20bar"),
            "/litra/foo bar"
        );
    }

    #[test]
    fn is_safe_name_segment_rejects_traversal_and_separators() {
        assert!(is_safe_name_segment("foo.json"));
        assert!(!is_safe_name_segment(""));
        assert!(!is_safe_name_segment("."));
        assert!(!is_safe_name_segment(".."));
        assert!(!is_safe_name_segment("../escape"));
        assert!(!is_safe_name_segment("a/b"));
        assert!(!is_safe_name_segment("a\\b"));
    }

    #[test]
    fn parse_propfind_handles_no_namespace() {
        let xml = r#"<?xml version="1.0"?>
<multistatus>
  <response>
    <href>/litra/notes.txt</href>
    <propstat>
      <prop>
        <resourcetype/>
      </prop>
    </propstat>
  </response>
</multistatus>"#;
        let entries = parse_propfind_response(xml).expect("parse ok");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].href, "/litra/notes.txt");
        assert!(!entries[0].is_collection);
    }

    #[test]
    fn sync_summary_limits_errors() {
        let mut summary = SyncSummary::default();
        for i in 0..(SYNC_ERROR_LOG_LIMIT * 3) {
            summary.record_error(format!("error {i}"));
        }
        assert_eq!(summary.errors.len(), SYNC_ERROR_LOG_LIMIT);
    }
}
