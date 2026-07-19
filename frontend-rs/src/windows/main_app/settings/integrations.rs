use serde::{Deserialize, Serialize};
use wasm_bindgen::{closure::Closure, JsCast, JsValue};
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

pub async fn pull_on_start(_document: &Document) -> Result<(), JsValue> {
    let config: WebDavConfig = invoke::invoke("load_webdav_sync_config", &Empty {}).await?;
    if !config.enabled || config.base_url.trim().is_empty() {
        return Ok(());
    }
    if let Some(window) = web_sys::window() {
        show_sync_modal(&window, "WebDAV から同期中…");
    }
    let result: Result<SyncSummary, JsValue> = invoke::invoke("pull_webdav_all", &Empty {}).await;
    match result {
        Ok(summary) => {
            if let Some(window) = web_sys::window() {
                update_sync_modal(&window, &format!(
                    "WebDAV 同期完了: {} 件処理、{} 件失敗",
                    summary.files_processed, summary.files_failed
                ));
                // 完了表示後に非表示
                let window_clone = window.clone();
                let _ = window.set_timeout_with_callback_and_timeout_and_arguments_0(
                    Closure::once_into_js(move || hide_sync_modal(&window_clone)).unchecked_ref(),
                    3000,
                );
            }
        }
        Err(error) => {
            if let Some(window) = web_sys::window() {
                update_sync_modal(&window, &format!("WebDAV 同期失敗: {error:?}"));
                let window_clone = window.clone();
                let _ = window.set_timeout_with_callback_and_timeout_and_arguments_0(
                    Closure::once_into_js(move || hide_sync_modal(&window_clone)).unchecked_ref(),
                    8000,
                );
            }
        }
    }
    Ok(())
}

pub async fn push_on_close() -> Result<(), JsValue> {
    let config: WebDavConfig = invoke::invoke("load_webdav_sync_config", &Empty {}).await?;
    if config.enabled && !config.base_url.trim().is_empty() {
        if let Some(window) = web_sys::window() {
            show_sync_modal(&window, "WebDAVに同期中...");
            // ブラウザがDOMを描画するまで待機（必須: さもなくば非同期処理が先に始まり表示されない）
            sleep_ms(150).await;
        }
        match invoke::invoke::<_, SyncSummary>("push_webdav_all", &Empty {}).await {
            Ok(summary) => {
                if let Some(window) = web_sys::window() {
                    update_sync_modal(&window, &format!(
                        "完了: {}件処理、{}件失敗",
                        summary.files_processed, summary.files_failed
                    ));
                    // 完了表示をユーザーが見られるように待機（この直後にウィンドウ破棄）
                    sleep_ms(2000).await;
                }
                web_sys::console::log_1(
                    &format!(
                        "[litra] WebDAV push complete: {} processed, {} failed",
                        summary.files_processed, summary.files_failed
                    )
                    .into(),
                );
            }
            Err(error) => {
                if let Some(window) = web_sys::window() {
                    update_sync_modal(&window, &format!("失敗: {error:?}"));
                    sleep_ms(5000).await;
                }
                web_sys::console::error_1(
                    &format!("[litra] WebDAV push failed: {error:?}").into(),
                );
            }
        }
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

// ---- 同期モーダル (旧TS createSyncOverlay の移植) ----

fn show_sync_modal(window: &web_sys::Window, message: &str) {
    let document = window.document().unwrap();
    // 既存のオーバーレイがあれば再利用
    if let Some(overlay) = document.get_element_by_id("litra-sync-overlay") {
        if let Some(msg_el) = document.get_element_by_id("litra-sync-message") {
            msg_el.set_text_content(Some(message));
        }
        // プログレスバーをリセット
        if let Some(fill) = document.get_element_by_id("litra-sync-progress-fill") {
            let _ = fill.set_attribute("style", "width: 0%");
        }
        if let Some(count) = document.get_element_by_id("litra-sync-count") {
            count.set_text_content(Some(""));
        }
        let _ = overlay.set_attribute("style", "display: flex");
        return;
    }
    // 新規作成
    let overlay = document.create_element("div").unwrap();
    overlay.set_id("litra-sync-overlay");
    let _ = overlay.set_attribute("style",
        "position: fixed; top: 0; left: 0; width: 100%; height: 100%; \
         background: rgba(0,0,0,0.5); display: flex; align-items: center; \
         justify-content: center; z-index: 10000;");

    let card = document.create_element("div").unwrap();
    let _ = card.set_attribute("style",
        "background: var(--surface, #1e1e2e); color: var(--text-primary, #cdd6f4); \
         padding: 2rem 3rem; border-radius: 12px; \
         box-shadow: 0 4px 24px rgba(0,0,0,0.3); \
         text-align: center; min-width: 320px;");

    let msg_el = document.create_element("div").unwrap();
    msg_el.set_id("litra-sync-message");
    let _ = msg_el.set_attribute("style",
        "font-size: 1.1rem; margin-bottom: 1rem;");
    msg_el.set_text_content(Some(message));

    let bar = document.create_element("div").unwrap();
    bar.set_id("litra-sync-progress-bar");
    let _ = bar.set_attribute("style",
        "width: 100%; height: 6px; background: var(--surface-hover, #313244); \
         border-radius: 3px; overflow: hidden;");

    let fill = document.create_element("div").unwrap();
    fill.set_id("litra-sync-progress-fill");
    let _ = fill.set_attribute("style",
        "width: 0%; height: 100%; background: var(--accent, #89b4fa); \
         transition: width 0.3s;");

    let count = document.create_element("div").unwrap();
    count.set_id("litra-sync-count");
    let _ = count.set_attribute("style",
        "margin-top: 0.5rem; font-size: 0.85rem; \
         color: var(--text-secondary, #a6adc8);");

    let _ = bar.append_child(&fill);
    let _ = card.append_child(&msg_el);
    let _ = card.append_child(&bar);
    let _ = card.append_child(&count);
    let _ = overlay.append_child(&card);
    let _ = document.body().unwrap().append_child(&overlay);
}

fn update_sync_modal(window: &web_sys::Window, message: &str) {
    if let Some(document) = window.document() {
        if let Some(msg_el) = document.get_element_by_id("litra-sync-message") {
            msg_el.set_text_content(Some(message));
        }
    }
}

fn hide_sync_modal(window: &web_sys::Window) {
    if let Some(document) = window.document() {
        if let Some(overlay) = document.get_element_by_id("litra-sync-overlay") {
            let _ = overlay.set_attribute("style", "display: none");
        }
    }
}

/// 指定ミリ秒間だけ待機する。DOM描画の待機や完了表示に使う。
async fn sleep_ms(ms: i32) {
    let promise = js_sys::Promise::new(&mut |resolve, _reject| {
        if let Some(window) = web_sys::window() {
            let _ = window.set_timeout_with_callback_and_timeout_and_arguments_0(
                &resolve,
                ms,
            );
        } else {
            // window がない場合は即座に解決
            let _ = resolve.call0(&JsValue::UNDEFINED);
        }
    });
    let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
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
