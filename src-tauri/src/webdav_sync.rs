use base64::Engine;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashSet, VecDeque},
    fs,
    path::{Component, Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use crate::storage::{data_or_documents_dir, documents_dir, ensure_parent_dir};

const CONFIG_FILE: &str = "webdav-sync.json";
const SYNC_ROOT: &str = "litra";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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

impl Default for WebDavSyncConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            base_url: String::new(),
            username: None,
            password: None,
            remote_folder: String::new(),
        }
    }
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
            let remote_relative = local_to_remote_relative(&path)?;
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
    reqwest::Client::new()
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
