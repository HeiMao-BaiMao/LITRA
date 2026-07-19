//! パネル比率の永続化クライアント。
//! Tauri バックエンドの `layout_load` / `layout_save` コマンドを呼んで
//! `litra-layout.json` を読み書きする。
//!
//! TypeScript `src/layout-store.ts` の移植。

use serde_json::{json, Value};
use wasm_bindgen::JsValue;

use crate::runtime::invoke;

pub const PANEL_PROJECT_NAV: &str = "projectNav";
pub const PANEL_CHAT_PANEL: &str = "chatPanel";
pub const PANEL_SETTINGS_SIDEBAR: &str = "settingsSidebar";
pub const PANEL_GENRE_SIDEBAR: &str = "genreSidebar";
pub const PANEL_GENRE_CHAT_SIDEBAR: &str = "genreChatSidebar";

const MIN_RATIO: f64 = 0.1;
const MAX_RATIO: f64 = 0.5;

fn clamp(value: f64) -> f64 {
    value.max(MIN_RATIO).min(MAX_RATIO)
}

/// バックエンドからレイアウト JSON を取得する。
async fn load_raw() -> Option<Value> {
    let result: Result<Option<String>, JsValue> =
        invoke::invoke("layout_load", &()).await;
    let json = result.ok().flatten()?;
    serde_json::from_str(&json).ok()
}

/// バックエンドにレイアウト JSON を保存する。
async fn save_raw(value: &Value) {
    let s = value.to_string();
    let _: Result<(), JsValue> = invoke::invoke("layout_save", &s).await;
}

/// 指定キーのパネル比率を読み込む。範囲外 / 未保存 / 失敗時は `None`。
pub async fn load_panel_ratio(key: &str) -> Option<f64> {
    let doc = load_raw().await?;
    let ratio = doc.get("panelRatios")?.get(key)?.as_f64()?;
    if !ratio.is_finite() {
        return None;
    }
    Some(clamp(ratio))
}

/// パネル比率を保存する（0.1〜0.5 にクランプされる）。
pub async fn save_panel_ratio(key: &str, ratio: f64) {
    let mut doc = load_raw().await.unwrap_or_else(|| {
        json!({ "schemaVersion": 1, "panelRatios": {} })
    });
    if doc.get("panelRatios").is_none() {
        doc["panelRatios"] = json!({});
    }
    doc["panelRatios"][key] = json!(clamp(ratio));
    save_raw(&doc).await;
}

/// すべてのレイアウト状態をクリアする。
/// 設定リセット時に呼ぶ。
pub async fn clear_layout() {
    let empty = json!({ "schemaVersion": 1, "panelRatios": {} });
    save_raw(&empty).await;
}
