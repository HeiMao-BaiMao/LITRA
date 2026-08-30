use js_sys::Object;
use wasm_bindgen::prelude::*;
#[wasm_bindgen(inline_js = r#"
export async function checkForUpdate() {
  try {
    const update = await window.__TAURI__.updater.check();
    return update ? { available: true, version: update.version || "", body: update.body || "", date: update.date || "" } : { available: false, version: "", body: "", date: "" };
  } catch (e) {
    return { available: false, error: String(e) };
  }
}

export async function installUpdate() {
  try {
    const result = await window.__TAURI__.updater.downloadAndInstall();
    return { success: true, result: result || "" };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

export async function closeApp() {
  try {
    const currentWindow = window.__TAURI__.window.getCurrentWindow();
    await currentWindow.close();
  } catch (e) {
    // fallback: try app exit
    try {
      await window.__TAURI__.process.exit(0);
    } catch (_) {}
  }
}
"#)]
extern "C" {
    #[wasm_bindgen(catch, js_name = checkForUpdate)]
    async fn check_for_update() -> Result<JsValue, JsValue>;

    #[wasm_bindgen(catch, js_name = installUpdate)]
    async fn install_update() -> Result<JsValue, JsValue>;

    #[wasm_bindgen(catch, js_name = closeApp)]
    async fn close_app() -> Result<(), JsValue>;
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct UpdateInfo {
    pub available: bool,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub date: String,
    #[serde(default)]
    pub error: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct InstallResult {
    pub success: bool,
    #[serde(default)]
    pub result: String,
    #[serde(default)]
    pub error: String,
}

pub async fn check_update() -> Result<UpdateInfo, String> {
    let result = check_for_update()
        .await
        .map_err(|e| format!("check failed: {e:?}"))?;
    serde_wasm_bindgen::from_value::<UpdateInfo>(result)
        .map_err(|e| format!("deserialize failed: {e}"))
}

pub async fn install() -> Result<InstallResult, String> {
    let result = install_update()
        .await
        .map_err(|e| format!("install failed: {e:?}"))?;
    serde_wasm_bindgen::from_value::<InstallResult>(result)
        .map_err(|e| format!("deserialize failed: {e}"))
}

pub async fn close_application() -> Result<(), JsValue> {
    close_app().await
}
