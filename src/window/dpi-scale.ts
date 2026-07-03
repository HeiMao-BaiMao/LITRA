import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4.0;
const ZOOM_EPSILON = 0.01;

/**
 * ウィンドウのモニタースケールファクターを確認し、WebView のズームレベルを
 * そのスケールに合わせる。
 *
 * Windows では子ウィンドウが DPI スケーリングを正しく引き継がない場合があり、
 * ウィンドウは広いのに内部の描画サイズだけ小さくなる現象を防ぐ。
 */
export async function applyDpiZoom(): Promise<void> {
  try {
    const win = getCurrentWindow();
    const webview = getCurrentWebview();
    const scaleFactor = await win.scaleFactor();
    const dpr = window.devicePixelRatio || 1;
    const zoom = scaleFactor / dpr;

    if (!Number.isFinite(zoom) || zoom < MIN_ZOOM || zoom > MAX_ZOOM) return;
    if (Math.abs(zoom - 1) < ZOOM_EPSILON) return;

    await webview.setZoom(zoom);
  } catch (error) {
    console.warn("[litra] failed to apply DPI zoom:", error);
  }
}

/**
 * 起動時に DPI ズームを適用し、モニター移動などでスケールファクターが
 * 変化したときにも再適用する。
 */
export async function listenDpiZoom(): Promise<() => void> {
  await applyDpiZoom();

  const win = getCurrentWindow();
  const unlisten = await win.onScaleChanged(() => {
    void applyDpiZoom();
  });

  return unlisten;
}
