use serde::Serialize;
use wasm_bindgen::{closure::Closure, JsValue};
use wasm_bindgen_futures::spawn_local;
use web_sys::Document;

use crate::runtime::{invoke, oauth};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OAuthArgs<'a> {
    provider: &'a str,
}

pub fn provider_changed(document: &Document, provider: &str) -> Result<(), JsValue> {
    let is_oauth = matches!(provider, "codex" | "github-copilot");
    set_hidden(document, "setting-api-key-row", is_oauth)?;
    set_hidden(document, "setting-oauth-row", !is_oauth)?;
    if is_oauth {
        set_busy(document, false)?;
        let document = document.clone();
        let provider = provider.to_owned();
        spawn_local(async move {
            let _ = refresh_status(&document, &provider).await;
        });
    }
    Ok(())
}

pub async fn start_oauth(document: &Document, provider: &str) -> Result<(), JsValue> {
    if !matches!(provider, "codex" | "github-copilot") {
        return Ok(());
    }
    set_busy(document, true)?;
    set_text(document, "setting-oauth-status", "認証中…");
    set_hidden(document, "setting-oauth-user-code", true)?;
    let result = if provider == "codex" {
        set_text(
            document,
            "setting-oauth-status",
            "ブラウザで認証を完了してください…",
        );
        oauth::start_codex().await.map(|_| ())
    } else {
        let callback_document = document.clone();
        let callback = Closure::wrap(Box::new(move |code: String, uri: String| {
            set_text(
                &callback_document,
                "setting-oauth-status",
                "GitHub でデバイスコードを入力してください",
            );
            set_text(
                &callback_document,
                "setting-oauth-user-code",
                &format!("コード: {code}  ({uri})"),
            );
            let _ = set_hidden(&callback_document, "setting-oauth-user-code", false);
        }) as Box<dyn FnMut(String, String)>);
        let result = oauth::start_copilot(oauth::as_function(callback.as_ref())).await;
        drop(callback);
        result
    };
    set_busy(document, false)?;
    match result {
        Ok(()) => refresh_status(document, provider).await,
        Err(error) => {
            set_text(
                document,
                "setting-oauth-status",
                &format!("認証に失敗しました: {}", js_error(&error)),
            );
            Err(error)
        }
    }
}

pub async fn cancel_oauth(document: &Document, provider: &str) -> Result<(), JsValue> {
    if provider == "codex" {
        oauth::cancel_codex().await?;
    } else if provider == "github-copilot" {
        oauth::cancel_copilot().await?;
    }
    set_busy(document, false)?;
    set_text(document, "setting-oauth-status", "認証をキャンセルしました");
    Ok(())
}

pub async fn logout_oauth(document: &Document, provider: &str) -> Result<(), JsValue> {
    invoke::invoke::<_, ()>("oauth_credential_delete", &OAuthArgs { provider }).await?;
    refresh_status(document, provider).await
}

async fn refresh_status(document: &Document, provider: &str) -> Result<(), JsValue> {
    let logged_in: bool =
        invoke::invoke("oauth_credential_status", &OAuthArgs { provider }).await?;
    set_text(
        document,
        "setting-oauth-status",
        if logged_in { "ログイン済み" } else { "未ログイン" },
    );
    set_hidden(document, "btn-oauth-login", logged_in)?;
    set_hidden(document, "btn-oauth-logout", !logged_in)?;
    set_hidden(document, "btn-oauth-cancel", true)?;
    set_hidden(document, "setting-oauth-user-code", true)
}

fn set_busy(document: &Document, busy: bool) -> Result<(), JsValue> {
    set_hidden(document, "btn-oauth-login", busy)?;
    set_hidden(document, "btn-oauth-logout", busy)?;
    set_hidden(document, "btn-oauth-cancel", !busy)
}

fn set_hidden(document: &Document, id: &str, hidden: bool) -> Result<(), JsValue> {
    if let Some(element) = document.get_element_by_id(id) {
        element.class_list().toggle_with_force("hidden", hidden)?;
    }
    Ok(())
}

fn set_text(document: &Document, id: &str, value: &str) {
    if let Some(element) = document.get_element_by_id(id) {
        element.set_text_content(Some(value));
    }
}

fn js_error(error: &JsValue) -> String {
    error.as_string().unwrap_or_else(|| format!("{error:?}"))
}
