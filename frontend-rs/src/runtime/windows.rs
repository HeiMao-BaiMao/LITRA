use js_sys::Function;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(inline_js = r#"
const tauriWindow = () => window.__TAURI__.window;
const tauriWebviewWindow = () => window.__TAURI__.webviewWindow;
const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);

function clampToMonitor(bounds, monitors) {
  const monitor = monitors.find((m) => {
    const right = m.position.x + m.size.width;
    const bottom = m.position.y + m.size.height;
    return (
      bounds.x >= m.position.x &&
      bounds.x < right &&
      bounds.y >= m.position.y &&
      bounds.y < bottom
    );
  }) ?? monitors[0];
  if (!monitor) return bounds;
  const maxX = monitor.position.x + monitor.size.width;
  const maxY = monitor.position.y + monitor.size.height;
  const width = Math.min(bounds.width, monitor.size.width);
  const height = Math.min(bounds.height, monitor.size.height);
  const x = Math.max(monitor.position.x, Math.min(bounds.x, maxX - width));
  const y = Math.max(monitor.position.y, Math.min(bounds.y, maxY - height));
  return { x, y, width, height };
}

async function applyWindowBounds(win, label) {
  let bounds = await invoke('load_window_bounds', { label });
  if (!bounds) return;
  try {
    const { PhysicalPosition, PhysicalSize, availableMonitors } = tauriWindow();
    const monitors = await availableMonitors();
    if (monitors.length > 0) {
      bounds = clampToMonitor(bounds, monitors);
    }
    await win.setPosition(new PhysicalPosition(bounds.x, bounds.y));
    await win.setSize(new PhysicalSize(bounds.width, bounds.height));
  } catch (error) {
    console.warn(`[litra] failed to apply bounds for ${label}:`, error);
  }
}

function trackWindowBounds(win, label) {
  let debounceTimer = null;
  const save = async () => {
    try {
      // 最大化中のサイズは保存しない。閉じた後に画面からはみ出るのを防ぐため。
      if (await win.isMaximized()) return;
      const position = await win.outerPosition();
      const size = await win.outerSize();
      await invoke('save_window_bounds', {
        label,
        bounds: { x: position.x, y: position.y, width: size.width, height: size.height },
      });
    } catch (error) {
      console.warn(`[litra] failed to save bounds for ${label}:`, error);
    }
  };
  const scheduleSave = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { void save(); }, 300);
  };
  win.onMoved(scheduleSave).catch((error) => {
    console.warn(`[litra] failed to listen window move for ${label}:`, error);
  });
  win.onResized(scheduleSave).catch((error) => {
    console.warn(`[litra] failed to listen window resize for ${label}:`, error);
  });
}

export async function openManagedWindow(label, url, title, width, height) {
  const WebviewWindow = tauriWebviewWindow().WebviewWindow;
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) { await existing.show(); await existing.setFocus(); return; }
  const child = new WebviewWindow(label, { url, title, width, height, center: true, resizable: true });
  await new Promise((resolve, reject) => { child.once('tauri://created', resolve); child.once('tauri://error', e => reject(e.payload)); });
  await applyWindowBounds(child, label);
  trackWindowBounds(child, label);
}

export async function listenWindowDestroyed(label, callback) {
  const WebviewWindow = tauriWebviewWindow().WebviewWindow;
  const win = await WebviewWindow.getByLabel(label);
  if (!win) return;
  win.once('tauri://destroyed', () => callback());
}

export async function destroyOtherWindows(currentLabel) {
  const all = await tauriWebviewWindow().getAllWebviewWindows();
  await Promise.all(all.filter((win) => win.label !== currentLabel).map((win) => win.destroy()));
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

    #[wasm_bindgen(catch, js_name = listenWindowDestroyed)]
    async fn listen_window_destroyed(label: &str, callback: &Function) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(catch, js_name = destroyOtherWindows)]
    pub async fn destroy_other_windows(current_label: &str) -> Result<JsValue, JsValue>;
}

pub async fn on_destroyed(
    label: &str,
    callback: wasm_bindgen::closure::Closure<dyn FnMut()>,
) -> Result<(), JsValue> {
    let function = callback.as_ref().unchecked_ref::<Function>();
    listen_window_destroyed(label, function).await?;
    callback.forget();
    Ok(())
}
#[wasm_bindgen(inline_js = r#"
export async function applyWindowBoundsMain(label) {
  const win = window.__TAURI__.window.getCurrentWindow();
  let bounds = await window.__TAURI__.core.invoke('load_window_bounds', { label });
  if (!bounds) return;
  try {
    const { PhysicalPosition, PhysicalSize, availableMonitors } = window.__TAURI__.window;
    const monitors = await availableMonitors();
    if (monitors.length > 0) {
      const monitor = monitors.find((m) => {
        const right = m.position.x + m.size.width;
        const bottom = m.position.y + m.size.height;
        return bounds.x >= m.position.x && bounds.x < right && bounds.y >= m.position.y && bounds.y < bottom;
      }) ?? monitors[0];
      if (monitor) {
        const maxX = monitor.position.x + monitor.size.width;
        const maxY = monitor.position.y + monitor.size.height;
        bounds = {
          x: Math.max(monitor.position.x, Math.min(bounds.x, maxX - bounds.width)),
          y: Math.max(monitor.position.y, Math.min(bounds.y, maxY - bounds.height)),
          width: Math.min(bounds.width, monitor.size.width),
          height: Math.min(bounds.height, monitor.size.height),
        };
      }
    }
    await win.setPosition(new PhysicalPosition(bounds.x, bounds.y));
    await win.setSize(new PhysicalSize(bounds.width, bounds.height));
  } catch (e) {
    console.warn(`[litra] failed to apply bounds for ${label}:`, e);
  }
}

export function trackWindowBoundsMain(label) {
  const win = window.__TAURI__.window.getCurrentWindow();
  let debounceTimer = null;
  const save = async () => {
    try {
      if (await win.isMaximized()) return;
      const position = await win.outerPosition();
      const size = await win.outerSize();
      await window.__TAURI__.core.invoke('save_window_bounds', {
        label,
        bounds: { x: position.x, y: position.y, width: size.width, height: size.height },
      });
    } catch (e) {
      console.warn(`[litra] failed to save bounds for ${label}:`, e);
    }
  };
  win.onMoved(() => { clearTimeout(debounceTimer); debounceTimer = setTimeout(save, 300); });
  win.onResized(() => { clearTimeout(debounceTimer); debounceTimer = setTimeout(save, 300); });
}
"#)]
extern "C" {
    #[wasm_bindgen(catch, js_name = applyWindowBoundsMain)]
    pub async fn apply_window_bounds_main(label: &str) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(js_name = trackWindowBoundsMain)]
    pub fn track_window_bounds_main(label: &str);
}
