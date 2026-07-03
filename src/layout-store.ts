import { Store } from "@tauri-apps/plugin-store";

const STORE_NAME = "litra-layout.json";
const LEGACY_STORE_NAME = "phenex-layout.json";

export type PanelRatioKey = "projectNav" | "chatPanel" | "settingsSidebar" | "genreSidebar" | "genreChatSidebar";

interface PanelRatios {
  projectNav?: number;
  chatPanel?: number;
  settingsSidebar?: number;
  genreSidebar?: number;
  genreChatSidebar?: number;
}

let store: Store | null = null;
let legacyStoreMigrationChecked = false;

async function getStore(): Promise<Store> {
  if (!store) {
    store = await Store.load(STORE_NAME);
    await migrateLegacyLayoutStore(store);
  }
  return store;
}

function isPanelRatios(value: unknown): value is PanelRatios {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return Object.entries(record).some(([key, val]) => {
    return (
      ["projectNav", "chatPanel", "settingsSidebar", "genreSidebar", "genreChatSidebar"].includes(key) &&
      typeof val === "number" &&
      Number.isFinite(val)
    );
  });
}

async function migrateLegacyLayoutStore(target: Store): Promise<void> {
  if (legacyStoreMigrationChecked) return;
  legacyStoreMigrationChecked = true;
  if ((await target.get("panelRatios")) !== undefined) return;

  const legacyStore = await Store.load(LEGACY_STORE_NAME);
  const ratios = await legacyStore.get("panelRatios");
  if (!isPanelRatios(ratios)) return;

  await target.set("panelRatios", ratios);
  await target.save();
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

export async function clearPanelRatios(): Promise<void> {
  const s = await getStore();
  await s.clear();
  await s.save();
}
