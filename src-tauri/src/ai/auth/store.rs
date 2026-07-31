use serde::{de::DeserializeOwned, Serialize};

const CHUNK_PREFIX: &str = "chunks:v1:";
const MAX_CHUNKS: usize = 32;
const CHUNK_SIZE: usize = 2000;

pub async fn read_json<T>(provider: &str) -> Result<Option<T>, String>
where
    T: DeserializeOwned + Send + 'static,
{
    let provider = provider.to_owned();
    tokio::task::spawn_blocking(move || read_json_sync(&provider))
        .await
        .map_err(|error| format!("OAuth credential read task failed: {error}"))?
}

pub fn read_json_sync<T>(provider: &str) -> Result<Option<T>, String>
where
    T: DeserializeOwned,
{
    let key = format!("oauth:{provider}");
    let Some(manifest) = crate::secrets::get_secret(&key)? else {
        return Ok(None);
    };
    let raw = if let Some(count) = manifest
        .strip_prefix(CHUNK_PREFIX)
        .and_then(|value| value.parse::<usize>().ok())
    {
        if count == 0 || count > MAX_CHUNKS {
            return Err("OAuth credential chunk manifest is invalid".into());
        }
        let mut raw = String::new();
        for index in 0..count {
            raw.push_str(
                &crate::secrets::get_secret(&format!("{key}:{index}"))?
                    .ok_or_else(|| format!("OAuth credential chunk is missing: {key}:{index}"))?,
            );
        }
        raw
    } else {
        manifest
    };
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|error| format!("OAuth credential JSON is invalid: {error}"))
}

pub async fn write_json<T>(provider: &str, credential: &T) -> Result<(), String>
where
    T: Serialize,
{
    let key = format!("oauth:{provider}");
    let raw = serde_json::to_string(credential)
        .map_err(|error| format!("OAuth credential serialization failed: {error}"))?;
    tokio::task::spawn_blocking(move || {
        if let Some(previous) = crate::secrets::get_secret(&key)? {
            if let Some(count) = previous
                .strip_prefix(CHUNK_PREFIX)
                .and_then(|value| value.parse::<usize>().ok())
            {
                for index in 0..count.min(MAX_CHUNKS) {
                    crate::secrets::delete_secret(&format!("{key}:{index}"))?;
                }
            }
        }
        let characters = raw.chars().collect::<Vec<_>>();
        let chunks = characters.chunks(CHUNK_SIZE).collect::<Vec<_>>();
        for (index, chunk) in chunks.iter().enumerate() {
            crate::secrets::set_secret(
                &format!("{key}:{index}"),
                &chunk.iter().collect::<String>(),
            )?;
        }
        crate::secrets::set_secret(&key, &format!("{CHUNK_PREFIX}{}", chunks.len()))
    })
    .await
    .map_err(|error| format!("OAuth credential write task failed: {error}"))?
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
    Ok(tokio::task::spawn_blocking(move || {
        read_json_sync::<serde_json::Value>(&provider)
            .map(|value| value.is_some_and(|value| valid_credential_shape(&provider, &value)))
            .unwrap_or(false)
    })
    .await
    .map_err(|error| format!("OAuth credential status task failed: {error}"))?)
}

fn valid_credential_shape(provider: &str, value: &serde_json::Value) -> bool {
    match provider {
        "codex" => {
            value
                .get("access")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|value| !value.is_empty())
                && value
                    .get("refresh")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|value| !value.is_empty())
                && value
                    .get("expires")
                    .and_then(serde_json::Value::as_u64)
                    .is_some()
        }
        "github-copilot" => value
            .get("token")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| !value.is_empty()),
        _ => false,
    }
}

#[tauri::command]
pub async fn oauth_credential_delete(provider: String) -> Result<(), String> {
    validate_oauth_provider(&provider)?;
    let key = format!("oauth:{provider}");
    tokio::task::spawn_blocking(move || {
        if let Some(manifest) = crate::secrets::get_secret(&key)? {
            if let Some(count) = manifest
                .strip_prefix(CHUNK_PREFIX)
                .and_then(|value| value.parse::<usize>().ok())
            {
                for index in 0..count.min(MAX_CHUNKS) {
                    crate::secrets::delete_secret(&format!("{key}:{index}"))?;
                }
            }
        }
        crate::secrets::delete_secret(&key)
    })
    .await
    .map_err(|error| format!("OAuth credential delete task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::{valid_credential_shape, validate_oauth_provider};

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
}
