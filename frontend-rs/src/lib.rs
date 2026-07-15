use wasm_bindgen::prelude::*;

mod components;
mod runtime;
mod windows;

#[wasm_bindgen(start)]
pub fn start() -> Result<(), JsValue> {
    let document = web_sys::window()
        .and_then(|window| window.document())
        .ok_or_else(|| JsValue::from_str("document is unavailable"))?;
    let window_name = document
        .body()
        .and_then(|body| body.get_attribute("data-rust-window"));

    match window_name.as_deref() {
        Some("memo") => windows::memo::mount(&document),
        Some("summary") => windows::summary::mount(&document),
        _ => Ok(()),
    }
}
