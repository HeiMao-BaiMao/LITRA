use serde::{Deserialize, Serialize};
use wasm_bindgen::{JsCast, JsValue};
use web_sys::{Document, HtmlInputElement};

use crate::runtime::invoke;

const EXA_KEY: &str = "websearch:exaApiKey";

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WebDavConfig {
    enabled: bool,
    base_url: String,
    username: Option<String>,
    password: Option<String>,
    remote_folder: String,
}

#[derive(Serialize)]
struct ConfigArgs<'a> {
    config: &'a WebDavConfig,
}

#[derive(Serialize)]
struct SecretArgs<'a> {
    key: &'a str,
}

#[derive(Serialize)]
struct SecretSetArgs<'a> {
    key: &'a str,
    value: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncSummary {
    files_processed: usize,
    files_failed: usize,
}

pub async fn populate(document: &Document) -> Result<(), JsValue> {
    let config: WebDavConfig = invoke::invoke("load_webdav_sync_config", &Empty {}).await?;
    set_checked(document, "setting-webdav-enabled", config.enabled);
    set_value(document, "setting-webdav-url", &config.base_url);
    set_value(
        document,
        "setting-webdav-username",
        config.username.as_deref().unwrap_or_default(),
    );
    set_value(
        document,
        "setting-webdav-password",
        config.password.as_deref().unwrap_or_default(),
    );
    set_value(document, "setting-webdav-folder", &config.remote_folder);
    let exa: Option<String> = invoke::invoke("secret_get", &SecretArgs { key: EXA_KEY }).await?;
    set_value(
        document,
        "setting-exa-api-key",
        exa.as_deref().unwrap_or_default(),
    );
    update_enabled(document)
}

pub async fn save(document: &Document) -> Result<(), JsValue> {
    let config = read(document);
    invoke::invoke::<_, ()>("save_webdav_sync_config", &ConfigArgs { config: &config }).await?;
    let exa = value(document, "setting-exa-api-key");
    if exa.trim().is_empty() {
        invoke::invoke::<_, ()>("secret_delete", &SecretArgs { key: EXA_KEY }).await
    } else {
        invoke::invoke::<_, ()>(
            "secret_set",
            &SecretSetArgs {
                key: EXA_KEY,
                value: exa.trim(),
            },
        )
        .await
    }
}

pub fn update_enabled(document: &Document) -> Result<(), JsValue> {
    let disabled = !checked(document, "setting-webdav-enabled");
    for id in [
        "setting-webdav-url",
        "setting-webdav-username",
        "setting-webdav-password",
        "setting-webdav-folder",
    ] {
        if let Some(input) = input(document, id) {
            input.set_disabled(disabled);
        }
    }
    Ok(())
}

pub async fn pull_on_start(document: &Document) -> Result<(), JsValue> {
    let config: WebDavConfig = invoke::invoke("load_webdav_sync_config", &Empty {}).await?;
    if !config.enabled || config.base_url.trim().is_empty() {
        return Ok(());
    }
    show_status(document, "WebDAV から同期中…")?;
    let result: Result<SyncSummary, JsValue> = invoke::invoke("pull_webdav_all", &Empty {}).await;
    match result {
        Ok(summary) => show_status(
            document,
            &format!(
                "WebDAV 同期完了: {} 件処理、{} 件失敗",
                summary.files_processed, summary.files_failed
            ),
        )?,
        Err(error) => show_status(document, &format!("WebDAV 同期失敗: {error:?}"))?,
    }
    Ok(())
}

pub async fn push_on_close() -> Result<(), JsValue> {
    let config: WebDavConfig = invoke::invoke("load_webdav_sync_config", &Empty {}).await?;
    if config.enabled && !config.base_url.trim().is_empty() {
        let summary: SyncSummary = invoke::invoke("push_webdav_all", &Empty {}).await?;
        let _ = (summary.files_processed, summary.files_failed);
    }
    Ok(())
}

fn read(document: &Document) -> WebDavConfig {
    WebDavConfig {
        enabled: checked(document, "setting-webdav-enabled"),
        base_url: value(document, "setting-webdav-url").trim().into(),
        username: non_empty(value(document, "setting-webdav-username")),
        password: non_empty(value(document, "setting-webdav-password")),
        remote_folder: value(document, "setting-webdav-folder").trim().into(),
    }
}

fn show_status(document: &Document, message: &str) -> Result<(), JsValue> {
    let id = "litra-sync-status";
    let element = if let Some(element) = document.get_element_by_id(id) {
        element
    } else {
        let element = document.create_element("div")?;
        element.set_id(id);
        element.set_attribute("class", "sync-status-overlay")?;
        document
            .body()
            .ok_or_else(|| JsValue::from_str("document body is missing"))?
            .append_child(&element)?;
        element
    };
    element.set_text_content(Some(message));
    Ok(())
}

fn non_empty(value: String) -> Option<String> {
    let value = value.trim().to_owned();
    (!value.is_empty()).then_some(value)
}
fn input(document: &Document, id: &str) -> Option<HtmlInputElement> {
    document.get_element_by_id(id)?.dyn_into().ok()
}
fn value(document: &Document, id: &str) -> String {
    input(document, id)
        .map(|item| item.value())
        .unwrap_or_default()
}
fn set_value(document: &Document, id: &str, value: &str) {
    if let Some(input) = input(document, id) {
        input.set_value(value);
    }
}
fn checked(document: &Document, id: &str) -> bool {
    input(document, id)
        .map(|item| item.checked())
        .unwrap_or(false)
}
fn set_checked(document: &Document, id: &str, checked: bool) {
    if let Some(input) = input(document, id) {
        input.set_checked(checked);
    }
}

#[derive(Serialize)]
struct Empty {}
