use serde::{de::DeserializeOwned, Serialize};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(inline_js = r#"
export async function invokeTauri(command, args) {
  return window.__TAURI__.core.invoke(command, args);
}
"#)]
extern "C" {
    #[wasm_bindgen(catch, js_name = invokeTauri)]
    async fn invoke_tauri(command: &str, args: JsValue) -> Result<JsValue, JsValue>;
}

pub async fn invoke<A, R>(command: &str, args: &A) -> Result<R, JsValue>
where
    A: Serialize,
    R: DeserializeOwned,
{
    let args = serde_wasm_bindgen::to_value(args)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let result = invoke_tauri(command, args).await?;
    serde_wasm_bindgen::from_value(result).map_err(|error| JsValue::from_str(&error.to_string()))
}
