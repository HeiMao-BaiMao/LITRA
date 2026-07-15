use serde::{de::DeserializeOwned, Serialize};

const CHUNK_PREFIX: &str = "chunks:v1:";
const MAX_CHUNKS: usize = 32;
const CHUNK_SIZE: usize = 2000;

pub async fn read_json<T>(provider: &str) -> Result<Option<T>, String>
where
    T: DeserializeOwned + Send + 'static,
{
    let key = format!("oauth:{provider}");
    tokio::task::spawn_blocking(move || {
        let Some(manifest) = crate::secrets::get_secret(&key)? else {
            return Ok(None);
        };
        let raw = if let Some(count) = manifest
            .strip_prefix(CHUNK_PREFIX)
            .and_then(|value| value.parse::<usize>().ok())
        {
            let mut raw = String::new();
            for index in 0..count.min(MAX_CHUNKS) {
                raw.push_str(
                    &crate::secrets::get_secret(&format!("{key}:{index}"))?.ok_or_else(|| {
                        format!("OAuth credential chunk is missing: {key}:{index}")
                    })?,
                );
            }
            raw
        } else {
            manifest
        };
        serde_json::from_str(&raw)
            .map(Some)
            .map_err(|error| format!("OAuth credential JSON is invalid: {error}"))
    })
    .await
    .map_err(|error| format!("OAuth credential read task failed: {error}"))?
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
    let key = format!("oauth:{provider}");
    tokio::task::spawn_blocking(move || {
        crate::secrets::get_secret(&key).map(|value| value.is_some())
    })
    .await
    .map_err(|error| format!("OAuth credential status task failed: {error}"))?
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
    use super::validate_oauth_provider;

    #[test]
    fn oauth_commands_only_accept_supported_providers() {
        assert!(validate_oauth_provider("codex").is_ok());
        assert!(validate_oauth_provider("github-copilot").is_ok());
        assert!(validate_oauth_provider("openai").is_err());
    }
}
