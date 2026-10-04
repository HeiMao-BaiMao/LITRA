use serde::{de::DeserializeOwned, Serialize};
use std::sync::Mutex;

const MAX_CHUNKS: usize = 32;
// Windows passwords have a byte limit and are stored as UTF-16. Count code
// units, not Unicode characters, so surrogate pairs fit too.
const CHUNK_UTF16_UNITS: usize = 1000;
static STORE_LOCK: Mutex<()> = Mutex::new(());

trait SecretStore {
    fn get(&self, key: &str) -> Result<Option<String>, String>;
    fn set(&self, key: &str, value: &str) -> Result<(), String>;
    fn delete(&self, key: &str) -> Result<(), String>;
}

struct KeyringStore;
impl SecretStore for KeyringStore {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        crate::secrets::get_secret(key)
    }
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        crate::secrets::set_secret(key, value)
    }
    fn delete(&self, key: &str) -> Result<(), String> {
        crate::secrets::delete_secret(key)
    }
}

fn chunk_keys(key: &str, manifest: &str) -> Result<Option<Vec<String>>, String> {
    let invalid = || "OAuth credential chunk manifest is invalid".to_owned();
    let (prefix, count) = if let Some(count) = manifest.strip_prefix("chunks:v1:") {
        (key.to_owned(), count)
    } else if let Some(rest) = manifest.strip_prefix("chunks:v2:") {
        let (generation, count) = rest.split_once(':').ok_or_else(invalid)?;
        if generation.len() != 32 || !generation.bytes().all(|ch| ch.is_ascii_hexdigit()) {
            return Err(invalid());
        }
        (format!("{key}:{generation}"), count)
    } else if manifest.starts_with("chunks:") {
        return Err(invalid());
    } else {
        return Ok(None);
    };
    let count = count.parse::<usize>().map_err(|_| invalid())?;
    if count == 0 || count > MAX_CHUNKS {
        return Err(invalid());
    }
    Ok(Some(
        (0..count)
            .map(|index| format!("{prefix}:{index}"))
            .collect(),
    ))
}

fn read_raw(store: &impl SecretStore, key: &str) -> Result<Option<String>, String> {
    let Some(manifest) = store.get(key)? else {
        return Ok(None);
    };
    let Some(keys) = chunk_keys(key, &manifest)? else {
        return Ok(Some(manifest));
    };
    let mut raw = String::new();
    for chunk_key in keys {
        raw.push_str(
            &store
                .get(&chunk_key)?
                .ok_or_else(|| "OAuth credential chunk is missing".to_owned())?,
        );
    }
    Ok(Some(raw))
}

fn credential_chunks(raw: &str) -> Result<Vec<String>, String> {
    let mut chunks = Vec::new();
    let mut chunk = String::new();
    let mut units = 0;
    for ch in raw.chars() {
        if units + ch.len_utf16() > CHUNK_UTF16_UNITS {
            chunks.push(std::mem::take(&mut chunk));
            units = 0;
        }
        chunk.push(ch);
        units += ch.len_utf16();
    }
    if !chunk.is_empty() {
        chunks.push(chunk);
    }
    if chunks.is_empty() || chunks.len() > MAX_CHUNKS {
        return Err("OAuth credential size is invalid".into());
    }
    Ok(chunks)
}

fn write_raw(store: &impl SecretStore, key: &str, raw: &str) -> Result<(), String> {
    write_raw_checked(store, key, raw, || Ok(()))
}

fn write_raw_checked(
    store: &impl SecretStore,
    key: &str,
    raw: &str,
    check: impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    check()?;
    let chunks = credential_chunks(raw)?;
    let previous = store.get(key)?;
    let old_keys = previous
        .as_deref()
        // A broken legacy manifest must not prevent a fresh login/logout.
        // Never follow unvalidated chunk names while cleaning it up.
        .and_then(|manifest| chunk_keys(key, manifest).ok().flatten())
        .unwrap_or_default();
    let generation = uuid::Uuid::new_v4().simple().to_string();
    let keys = (0..chunks.len())
        .map(|index| format!("{key}:{generation}:{index}"))
        .collect::<Vec<_>>();
    let result = (|| {
        for (chunk_key, chunk) in keys.iter().zip(&chunks) {
            store.set(chunk_key, chunk)?;
        }
        // Publish only after every new chunk is durable. A failed write leaves
        // the previous credential intact and readable.
        check()?;
        store.set(key, &format!("chunks:v2:{generation}:{}", chunks.len()))
    })();
    let cleanup = if result.is_ok() { &old_keys } else { &keys };
    for chunk_key in cleanup {
        let _ = store.delete(chunk_key);
    }
    result
}

fn delete_raw(store: &impl SecretStore, key: &str) -> Result<(), String> {
    let keys = store
        .get(key)?
        .as_deref()
        // A broken legacy manifest must not prevent a fresh login/logout.
        // Never follow unvalidated chunk names while cleaning it up.
        .and_then(|manifest| chunk_keys(key, manifest).ok().flatten())
        .unwrap_or_default();
    // Remove the published pointer first so a partial cleanup cannot leave a
    // corrupt credential looking logged-in.
    store.delete(key)?;
    for chunk_key in keys {
        store.delete(&chunk_key)?;
    }
    Ok(())
}

pub async fn read_json<T>(provider: &str) -> Result<Option<T>, String>
where
    T: DeserializeOwned + Send + 'static,
{
    let provider = provider.to_owned();
    tokio::task::spawn_blocking(move || read_json_sync(&provider))
        .await
        .map_err(|error| format!("OAuth credential read task failed: {error}"))?
}

pub fn read_json_sync<T: DeserializeOwned>(provider: &str) -> Result<Option<T>, String> {
    let _guard = STORE_LOCK
        .lock()
        .map_err(|_| "OAuth credential lock failed")?;
    read_raw(&KeyringStore, &format!("oauth:{provider}"))?
        .map(|raw| {
            serde_json::from_str(&raw)
                .map_err(|error| format!("OAuth credential JSON is invalid: {error}"))
        })
        .transpose()
}

pub async fn write_json_cancellable<T: Serialize>(
    provider: &str,
    credential: &T,
    token: tokio_util::sync::CancellationToken,
) -> Result<(), String> {
    let key = format!("oauth:{provider}");
    let raw = serde_json::to_string(credential)
        .map_err(|error| format!("OAuth credential serialization failed: {error}"))?;
    tokio::task::spawn_blocking(move || {
        let _guard = STORE_LOCK
            .lock()
            .map_err(|_| "OAuth credential lock failed")?;
        write_raw_checked(&KeyringStore, &key, &raw, || {
            if token.is_cancelled() {
                Err("認証がキャンセルされました。".into())
            } else {
                Ok(())
            }
        })
    })
    .await
    .map_err(|error| format!("OAuth credential write task failed: {error}"))?
}

/// Refresh must not recreate credentials after logout or overwrite a newer
/// login while the token endpoint was in flight.
pub async fn replace_json<T: Serialize>(
    provider: &str,
    previous: &T,
    credential: &T,
) -> Result<bool, String> {
    let key = format!("oauth:{provider}");
    let expected = serde_json::to_value(previous).map_err(|error| error.to_string())?;
    let raw = serde_json::to_string(credential).map_err(|error| error.to_string())?;
    tokio::task::spawn_blocking(move || {
        let _guard = STORE_LOCK
            .lock()
            .map_err(|_| "OAuth credential lock failed")?;
        replace_raw(&KeyringStore, &key, &expected, &raw)
    })
    .await
    .map_err(|error| format!("OAuth credential write task failed: {error}"))?
}

fn replace_raw(
    store: &impl SecretStore,
    key: &str,
    expected: &serde_json::Value,
    raw: &str,
) -> Result<bool, String> {
    let current = read_raw(store, key)?
        .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok());
    if current.as_ref() != Some(expected) {
        return Ok(false);
    }
    write_raw(store, key, raw)?;
    Ok(true)
}

fn validate_oauth_provider(provider: &str) -> Result<(), String> {
    match provider {
        "codex" | "github-copilot" => Ok(()),
        _ => Err(format!("OAuth is not supported for provider: {provider}")),
    }
}

#[tauri::command]
pub async fn oauth_credential_status(provider: String) -> Result<bool, String> {
    validate_oauth_provider(&provider)?;
    tokio::task::spawn_blocking(move || {
        read_json_sync::<serde_json::Value>(&provider)
            .map(|value| value.is_some_and(|value| valid_credential_shape(&provider, &value)))
            .unwrap_or(false)
    })
    .await
    .map_err(|error| format!("OAuth credential status task failed: {error}"))
}

fn valid_credential_shape(provider: &str, value: &serde_json::Value) -> bool {
    match provider {
        "codex" => {
            value
                .get("access")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|value| !value.trim().is_empty())
                && value
                    .get("refresh")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty())
                && value
                    .get("expires")
                    .and_then(serde_json::Value::as_u64)
                    .is_some()
        }
        "github-copilot" => value
            .get("token")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| !value.trim().is_empty()),
        _ => false,
    }
}

#[tauri::command]
pub async fn oauth_credential_delete(provider: String) -> Result<(), String> {
    validate_oauth_provider(&provider)?;
    tokio::task::spawn_blocking(move || {
        let _guard = STORE_LOCK
            .lock()
            .map_err(|_| "OAuth credential lock failed")?;
        delete_raw(&KeyringStore, &format!("oauth:{provider}"))
    })
    .await
    .map_err(|error| format!("OAuth credential delete task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oauth_commands_only_accept_supported_providers() {
        assert!(validate_oauth_provider("codex").is_ok());
        assert!(validate_oauth_provider("github-copilot").is_ok());
        assert!(validate_oauth_provider("openai").is_err());
    }

    #[test]
    fn malformed_or_incomplete_credentials_are_logged_out() {
        assert!(valid_credential_shape(
            "codex",
            &serde_json::json!({"access":"a","refresh":"r","expires":1})
        ));
        assert!(!valid_credential_shape(
            "codex",
            &serde_json::json!({"access":"a"})
        ));
        assert!(valid_credential_shape(
            "github-copilot",
            &serde_json::json!({"token":"t"})
        ));
        assert!(!valid_credential_shape(
            "github-copilot",
            &serde_json::json!({"token":""})
        ));
    }
    #[derive(Default)]
    struct MemoryStore {
        values: std::cell::RefCell<std::collections::HashMap<String, String>>,
        writes: std::cell::Cell<usize>,
        fail_at: std::cell::Cell<Option<usize>>,
    }
    impl SecretStore for MemoryStore {
        fn get(&self, key: &str) -> Result<Option<String>, String> {
            Ok(self.values.borrow().get(key).cloned())
        }
        fn set(&self, key: &str, value: &str) -> Result<(), String> {
            let write = self.writes.get() + 1;
            self.writes.set(write);
            if self.fail_at.get() == Some(write) {
                return Err("simulated keyring write failure".into());
            }
            self.values.borrow_mut().insert(key.into(), value.into());
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<(), String> {
            self.values.borrow_mut().remove(key);
            Ok(())
        }
    }

    #[test]
    fn chunk_sizes_are_safe_for_utf16_including_surrogate_pairs() {
        let raw = "日😀".repeat(1500);
        let chunks = credential_chunks(&raw).unwrap();
        assert_eq!(chunks.concat(), raw);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.encode_utf16().count() <= CHUNK_UTF16_UNITS));
    }

    #[test]
    fn staged_writes_preserve_previous_credential_on_chunk_or_manifest_failure() {
        for fail_at in [1, 2, 3] {
            let store = MemoryStore::default();
            store
                .values
                .borrow_mut()
                .insert("key".into(), "original".into());
            store.fail_at.set(Some(fail_at));
            assert!(write_raw(&store, "key", &"a".repeat(1500)).is_err());
            assert_eq!(
                read_raw(&store, "key").unwrap().as_deref(),
                Some("original")
            );
            assert_eq!(store.values.borrow().len(), 1);
        }
    }

    #[test]
    fn migrates_legacy_chunks_then_deletes_all_current_chunks() {
        let store = MemoryStore::default();
        store.set("key", "chunks:v1:2").unwrap();
        store.set("key:0", "old").unwrap();
        store.set("key:1", "value").unwrap();
        assert_eq!(
            read_raw(&store, "key").unwrap().as_deref(),
            Some("oldvalue")
        );
        write_raw(&store, "key", "newvalue").unwrap();
        assert_eq!(
            read_raw(&store, "key").unwrap().as_deref(),
            Some("newvalue")
        );
        assert!(store.get("key:0").unwrap().is_none());
        delete_raw(&store, "key").unwrap();
        assert!(store.values.borrow().is_empty());
    }

    #[test]
    fn refresh_cannot_restore_logout_or_overwrite_new_login() {
        let store = MemoryStore::default();
        let expected = serde_json::json!({"access":"old"});
        assert!(!replace_raw(&store, "key", &expected, r#"{"access":"refreshed"}"#).unwrap());
        write_raw(&store, "key", r#"{"access":"new login"}"#).unwrap();
        assert!(!replace_raw(&store, "key", &expected, r#"{"access":"refreshed"}"#).unwrap());
        assert_eq!(
            read_raw(&store, "key").unwrap().as_deref(),
            Some(r#"{"access":"new login"}"#)
        );
    }

    #[test]
    fn rejects_oversized_and_invalid_manifests_without_writes() {
        let store = MemoryStore::default();
        assert!(write_raw(
            &store,
            "key",
            &"x".repeat(CHUNK_UTF16_UNITS * MAX_CHUNKS + 1)
        )
        .is_err());
        assert_eq!(store.writes.get(), 0);
        for manifest in [
            "chunks:v1:0",
            "chunks:v1:33",
            "chunks:v1:abc",
            "chunks:v2:bad:1",
        ] {
            assert!(chunk_keys("key", manifest).is_err());
        }
    }
    #[test]
    fn cancellation_before_publication_keeps_old_credential_and_cleans_staging() {
        let store = MemoryStore::default();
        store.set("key", "previous").unwrap();
        let checks = std::cell::Cell::new(0);
        let result = write_raw_checked(&store, "key", "new", || {
            checks.set(checks.get() + 1);
            if checks.get() == 2 {
                Err("cancelled".into())
            } else {
                Ok(())
            }
        });
        assert!(result.is_err());
        assert_eq!(
            read_raw(&store, "key").unwrap().as_deref(),
            Some("previous")
        );
        assert_eq!(store.values.borrow().len(), 1);
    }
    #[test]
    fn corrupted_manifest_can_be_replaced_or_logged_out() {
        let store = MemoryStore::default();
        store.set("key", "chunks:v1:not-a-count").unwrap();
        assert!(read_raw(&store, "key").is_err());
        write_raw(&store, "key", "repaired").unwrap();
        assert_eq!(
            read_raw(&store, "key").unwrap().as_deref(),
            Some("repaired")
        );
        store.set("key", "chunks:v2:invalid").unwrap();
        delete_raw(&store, "key").unwrap();
        assert!(store.get("key").unwrap().is_none());
    }
}
