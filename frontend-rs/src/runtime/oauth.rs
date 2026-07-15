use js_sys::Function;
use wasm_bindgen::{prelude::*, JsCast};

#[wasm_bindgen(inline_js = r#"
export async function startCodexOAuth() {
  return window.__TAURI__.core.invoke("start_codex_browser_auth");
}

export async function cancelCodexOAuth() {
  return window.__TAURI__.core.invoke("cancel_codex_browser_auth");
}

export async function startCopilotOAuth(onCode) {
  const channel = new window.__TAURI__.core.Channel();
  channel.onmessage = async (event) => {
    onCode(event.userCode, event.verificationUri);
    await window.__TAURI__.opener.openUrl(event.verificationUri);
  };
  return window.__TAURI__.core.invoke("start_copilot_device_auth", {
    enterpriseUrl: null,
    onEvent: channel,
  });
}

export async function cancelCopilotOAuth() {
  return window.__TAURI__.core.invoke("cancel_copilot_device_auth");
}
"#)]
extern "C" {
    #[wasm_bindgen(catch, js_name = startCodexOAuth)]
    pub async fn start_codex() -> Result<JsValue, JsValue>;

    #[wasm_bindgen(catch, js_name = cancelCodexOAuth)]
    pub async fn cancel_codex() -> Result<JsValue, JsValue>;

    #[wasm_bindgen(catch, js_name = startCopilotOAuth)]
    async fn start_copilot_js(on_code: &Function) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(catch, js_name = cancelCopilotOAuth)]
    pub async fn cancel_copilot() -> Result<JsValue, JsValue>;
}

pub async fn start_copilot(on_code: &Function) -> Result<(), JsValue> {
    start_copilot_js(on_code).await.map(|_| ())
}

pub fn as_function(value: &JsValue) -> &Function {
    value.unchecked_ref()
}
