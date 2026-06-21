import {
  BaseDirectory,
  exists,
  readTextFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";

export type SdkType = "openai" | "anthropic" | "google";

export interface ProviderEntry {
  id: string;
  name: string;
  sdkType: SdkType;
  defaultBaseUrl: string;
  defaultModel: string;
}

export interface ProviderConfig {
  providers: ProviderEntry[];
}

const CONFIG_FILE = "providers.json";
const BASE_DIR = BaseDirectory.AppConfig;

import defaultProviders from "./default-providers.json" with { type: "json" };

const DEFAULT_CONFIG: ProviderConfig = defaultProviders as ProviderConfig;

async function initializeDefaultConfig(): Promise<void> {
  const text = JSON.stringify(DEFAULT_CONFIG, null, 2);
  await writeTextFile(CONFIG_FILE, text, { baseDir: BASE_DIR });
}

function mergeDefaultProviders(config: ProviderConfig): ProviderConfig {
  const existingIds = new Set(config.providers.map((p) => p.id));
  const merged = [...config.providers];

  for (const defaultProvider of DEFAULT_CONFIG.providers) {
    if (!existingIds.has(defaultProvider.id)) {
      merged.push(defaultProvider);
    }
  }

  return { providers: merged };
}

export async function loadProviderConfig(): Promise<ProviderConfig> {
  const fileExists = await exists(CONFIG_FILE, { baseDir: BASE_DIR });
  if (!fileExists) {
    await initializeDefaultConfig();
  }

  const text = await readTextFile(CONFIG_FILE, { baseDir: BASE_DIR });
  const parsed: unknown = JSON.parse(text);

  if (!isProviderConfig(parsed)) {
    throw new Error("providers.json の形式が不正です。");
  }

  const merged = mergeDefaultProviders(parsed);
  if (merged.providers.length !== parsed.providers.length) {
    await writeTextFile(CONFIG_FILE, JSON.stringify(merged, null, 2), { baseDir: BASE_DIR });
  }

  return merged;
}

export function getProviderEntry(
  config: ProviderConfig,
  providerId: string,
): ProviderEntry | undefined {
  return config.providers.find((provider) => provider.id === providerId);
}

function isProviderConfig(value: unknown): value is ProviderConfig {
  if (typeof value !== "object" || value === null) return false;
  const config = value as Partial<ProviderConfig>;
  if (!Array.isArray(config.providers)) return false;

  return config.providers.every((provider) => {
    const p = provider as Partial<ProviderEntry>;
    return (
      typeof p.id === "string" &&
      typeof p.name === "string" &&
      (p.sdkType === "openai" || p.sdkType === "anthropic" || p.sdkType === "google") &&
      typeof p.defaultBaseUrl === "string" &&
      typeof p.defaultModel === "string"
    );
  });
}
