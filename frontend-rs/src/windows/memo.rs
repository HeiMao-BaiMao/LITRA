use wasm_bindgen::JsValue;
use web_sys::Document;

use crate::{
    components::synced_textarea::{self, SyncedTextareaConfig},
    runtime::tauri,
};

pub fn mount(document: &Document) -> Result<(), JsValue> {
    tauri::listen_dpi_zoom();
    synced_textarea::mount(
        document,
        SyncedTextareaConfig {
            selector: "#memo-textarea",
            sync_event: "memo-sync",
            update_event: "memo-update",
            ready_event: "memo-ready",
            enabled_placeholder: "このエピソードの覚え書き（下書き）を入力...",
            disabled_placeholder: "エピソードを選択してください...",
        },
    )?;
    Ok(())
}
