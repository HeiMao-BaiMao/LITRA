use js_sys::Function;
use wasm_bindgen::{closure::Closure, prelude::*, JsCast};
use wasm_bindgen_futures::spawn_local;

#[wasm_bindgen(inline_js = r#"
export async function listenTauriEvent(name, callback) {
  return window.__TAURI__.event.listen(name, (event) => callback(event.payload));
}

export function emitTauriEvent(name, payload) {
  void window.__TAURI__.event.emit(name, payload);
}

export async function startDpiZoomListener() {
  const apply = async () => {
    try {
      const currentWindow = window.__TAURI__.window.getCurrentWindow();
      const currentWebview = window.__TAURI__.webview.getCurrentWebview();
      const scaleFactor = await currentWindow.scaleFactor();
      const dpr = window.devicePixelRatio || 1;
      const zoom = scaleFactor / dpr;
      if (!Number.isFinite(zoom) || zoom < 0.5 || zoom > 4) return;
      if (Math.abs(zoom - 1) < 0.01) return;
      await currentWebview.setZoom(zoom);
    } catch (error) {
      console.warn("[litra] failed to apply DPI zoom:", error);
    }
  };
  await apply();
  return window.__TAURI__.window.getCurrentWindow().onScaleChanged(apply);
}
"#)]
extern "C" {
    #[wasm_bindgen(catch, js_name = listenTauriEvent)]
    async fn listen_tauri_event(name: &str, callback: &Function) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(js_name = emitTauriEvent)]
    fn emit_tauri_event(name: &str, payload: &JsValue);

    #[wasm_bindgen(catch, js_name = startDpiZoomListener)]
    async fn start_dpi_zoom_listener() -> Result<JsValue, JsValue>;
}

pub fn listen(event_name: &'static str, callback: Closure<dyn FnMut(JsValue)>) {
    spawn_local(async move {
        let function = callback.as_ref().unchecked_ref::<Function>();
        if listen_tauri_event(event_name, function).await.is_ok() {
            callback.forget();
        }
    });
}

pub fn emit(event_name: &str, payload: &JsValue) {
    emit_tauri_event(event_name, payload);
}

pub fn listen_dpi_zoom() {
    spawn_local(async {
        let _ = start_dpi_zoom_listener().await;
    });
}
