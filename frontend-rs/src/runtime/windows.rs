use wasm_bindgen::prelude::*;

#[wasm_bindgen(inline_js = r#"
export async function openManagedWindow(label, url, title, width, height) {
  const WebviewWindow = window.__TAURI__.webviewWindow.WebviewWindow;
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) { await existing.show(); await existing.setFocus(); return; }
  const child = new WebviewWindow(label, { url, title, width, height, center: true, resizable: true });
  await new Promise((resolve, reject) => { child.once('tauri://created', resolve); child.once('tauri://error', e => reject(e.payload)); });
}
"#)]
extern "C" {
    #[wasm_bindgen(catch, js_name = openManagedWindow)]
    pub async fn open_managed_window(
        label: &str,
        url: &str,
        title: &str,
        width: f64,
        height: f64,
    ) -> Result<JsValue, JsValue>;
}
