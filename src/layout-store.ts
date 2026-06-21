import { Store } from "@tauri-apps/plugin-store";

const STORE_NAME = "phenex-layout.json";

export type PanelRatioKey = "projectNav" | "chatPanel" | "settingsSidebar";

interface PanelRatios {
  projectNav?: number;
  chatPanel?: number;
  settingsSidebar?: number;
}

let store: Store | null = null;

async function getStore(): Promise<Store> {
  if (!store) {
    store = await Store.load(STORE_NAME);
  }
  return store;
}

function clampRatio(value: number): number {
  return Math.min(0.5, Math.max(0.1, value));
}

export async function loadPanelRatio(key: PanelRatioKey): Promise<number | undefined> {
  const s = await getStore();
  const ratios = await s.get<PanelRatios>("panelRatios");
  const value = ratios?.[key];
  if (typeof value !== "number") return undefined;
  return clampRatio(value);
}

export async function savePanelRatio(key: PanelRatioKey, ratio: number): Promise<void> {
  const s = await getStore();
  const ratios = (await s.get<PanelRatios>("panelRatios")) ?? {};
  ratios[key] = clampRatio(ratio);
  await s.set("panelRatios", ratios);
  await s.save();
}
