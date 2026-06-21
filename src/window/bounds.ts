import { PhysicalPosition, PhysicalSize, type Window } from "@tauri-apps/api/window";
import { Store } from "@tauri-apps/plugin-store";

const STORE_FILE = "window-bounds.json";
let store: Store | null = null;

async function getStore(): Promise<Store> {
  if (!store) {
    store = await Store.load(STORE_FILE);
  }
  return store;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function loadWindowBounds(label: string): Promise<WindowBounds | undefined> {
  const s = await getStore();
  const all = await s.get<Record<string, WindowBounds>>("bounds");
  return all?.[label];
}

export async function saveWindowBounds(label: string, bounds: WindowBounds): Promise<void> {
  const s = await getStore();
  const all = (await s.get<Record<string, WindowBounds>>("bounds")) ?? {};
  all[label] = bounds;
  await s.set("bounds", all);
  await s.save();
}

export async function loadWindowDetached(label: string): Promise<boolean> {
  const s = await getStore();
  const all = await s.get<Record<string, boolean>>("detached");
  return all?.[label] ?? false;
}

export async function saveWindowDetached(label: string, detached: boolean): Promise<void> {
  const s = await getStore();
  const all = (await s.get<Record<string, boolean>>("detached")) ?? {};
  all[label] = detached;
  await s.set("detached", all);
  await s.save();
}

export async function applyWindowBounds(win: Window, label: string): Promise<void> {
  const bounds = await loadWindowBounds(label);
  if (!bounds) return;

  try {
    await win.setPosition(new PhysicalPosition(bounds.x, bounds.y));
    await win.setSize(new PhysicalSize(bounds.width, bounds.height));
  } catch (error) {
    console.warn(`[phenex] failed to apply bounds for ${label}:`, error);
  }
}

export function trackWindowBounds(win: Window, label: string): void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const save = async (): Promise<void> => {
    try {
      const position = await win.outerPosition();
      const size = await win.outerSize();
      await saveWindowBounds(label, {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
      });
    } catch (error) {
      console.warn(`[phenex] failed to save bounds for ${label}:`, error);
    }
  };

  const scheduleSave = (): void => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      void save();
    }, 300);
  };

  win.onMoved(scheduleSave).catch((error) => {
    console.warn(`[phenex] failed to listen window move for ${label}:`, error);
  });
  win.onResized(scheduleSave).catch((error) => {
    console.warn(`[phenex] failed to listen window resize for ${label}:`, error);
  });
}
