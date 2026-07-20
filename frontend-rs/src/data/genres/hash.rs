use wasm_bindgen::JsValue;
use wasm_bindgen_futures::JsFuture;

/// Compute the SHA-256 hash of `text` using the WebCrypto API.
///
/// Returns a lowercase 64-character hex string, compatible with the legacy
/// TypeScript implementation that used `crypto.subtle.digest("SHA-256", …)`.
pub async fn compute_text_hash(text: &str) -> Result<String, JsValue> {
    let window = web_sys::window().ok_or_else(|| JsValue::from_str("window unavailable"))?;
    let subtle = window.crypto()?.subtle();
    let data = js_sys::Uint8Array::from(text.as_bytes());
    let promise = subtle
        .digest_with_str_and_buffer_source("SHA-256", &data)
        .map_err(|_| JsValue::from_str("SHA-256 digest failed"))?;
    let buffer = JsFuture::from(promise).await?;
    let array = js_sys::Uint8Array::new(&buffer);
    let mut hex = String::with_capacity(64);
    for i in 0..array.length() {
        use std::fmt::Write;
        let _ = write!(hex, "{:02x}", array.get_index(i));
    }
    Ok(hex)
}

/// Return the first `length` characters of a hex hash (default 16).
pub fn shorten_hash(hash: &str, length: usize) -> &str {
    let end = hash.len().min(length);
    &hash[..end]
}
