use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::spawn_local;

mod ai;
mod components;
mod data;
mod hashline;
mod runtime;
mod ui;
mod windows;
#[wasm_bindgen(start)]
pub fn start() -> Result<(), JsValue> {
    let document = web_sys::window()
        .and_then(|window| window.document())
        .ok_or_else(|| JsValue::from_str("document is unavailable"))?;
    let window_name = document
        .body()
        .and_then(|body| body.get_attribute("data-rust-window"));

    spawn_local(async move {
        let _ = match window_name.as_deref() {
            Some("chat") => windows::chat::mount(&document).await,
            Some("genre-library") => windows::genre_library::mount(&document).await,
            Some("genre-chat") => windows::genre_chat::mount(&document).await,
            Some("main") => windows::main_app::mount(&document).await,
            Some("memo") => windows::memo::mount(&document).await,
            Some("project-memos") => windows::project_memos::mount(&document).await,
            Some("settings") => windows::settings::mount(&document).await,
            Some("summary") => windows::summary::mount(&document).await,
            _ => Ok(()),
        };
    });
    Ok(())
}
