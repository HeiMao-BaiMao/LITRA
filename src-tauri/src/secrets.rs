use keyring::Entry;

const SERVICE: &str = "org.hmbm.litra";

pub fn get_secret(key: &str) -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE, key).map_err(|e| format!("keyring Entry::new({key}): {e}"))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring get_password({key}): {e}")),
    }
}

pub fn set_secret(key: &str, value: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE, key).map_err(|e| format!("keyring Entry::new({key}): {e}"))?;
    entry
        .set_password(value)
        .map_err(|e| format!("keyring set_password({key}): {e}"))
}

pub fn delete_secret(key: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE, key).map_err(|e| format!("keyring Entry::new({key}): {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring delete_credential({key}): {e}")),
    }
}

/// `None` または空文字はエントリ削除、それ以外は保存する。
pub fn set_or_delete_secret(key: &str, value: Option<&str>) -> Result<(), String> {
    match value {
        Some(v) if !v.is_empty() => set_secret(key, v),
        _ => delete_secret(key),
    }
}

#[tauri::command]
pub fn secret_get(key: String) -> Result<Option<String>, String> {
    get_secret(&key)
}

#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    set_secret(&key, &value)
}

#[tauri::command]
pub fn secret_delete(key: String) -> Result<(), String> {
    delete_secret(&key)
}
