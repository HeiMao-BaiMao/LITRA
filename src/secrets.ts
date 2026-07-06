import { invoke } from "@tauri-apps/api/core";
import type { Provider } from "./settings.ts";

export function apiKeySecretKey(provider: Provider): string {
  return `apikey:${provider}`;
}

export async function secretGet(key: string): Promise<string | undefined> {
  const value = await invoke<string | null>("secret_get", { key });
  return value ?? undefined;
}

export async function secretSet(key: string, value: string): Promise<void> {
  await invoke("secret_set", { key, value });
}

export async function secretDelete(key: string): Promise<void> {
  await invoke("secret_delete", { key });
}

export async function setOrDeleteSecret(key: string, value: string | undefined): Promise<void> {
  const trimmed = value?.trim() ?? "";
  if (trimmed) {
    await secretSet(key, trimmed);
  } else {
    await secretDelete(key);
  }
}
