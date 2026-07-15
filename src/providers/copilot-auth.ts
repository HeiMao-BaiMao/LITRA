import { Channel, invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { readOAuthCredential, writeOAuthCredential } from "../secrets.ts";

export interface CopilotCredential {
  [key: string]: unknown;
  token: string;
  enterpriseUrl?: string;
}

const CREDENTIAL_PROVIDER = "github-copilot" as const;

export async function readCopilotCredential(): Promise<CopilotCredential | undefined> {
  return readOAuthCredential<CopilotCredential>(CREDENTIAL_PROVIDER);
}

export async function deleteCopilotCredential(): Promise<void> {
  await writeOAuthCredential(CREDENTIAL_PROVIDER, undefined);
  invalidateCopilotModelCache();
}

export async function loginWithDeviceCode(
  signal: AbortSignal,
  enterpriseUrl?: string,
  onUserCode?: (code: string, verificationUri: string) => void,
): Promise<CopilotCredential> {
  const channel = new Channel<{ userCode: string; verificationUri: string }>((event) => {
    void openUrl(event.verificationUri).catch(() => {});
    onUserCode?.(event.userCode, event.verificationUri);
  });
  const cancel = (): void => { void invoke("cancel_copilot_device_auth"); };
  if (signal.aborted) {
    cancel();
    throw new Error("ログインがキャンセルされました。");
  }
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await invoke("start_copilot_device_auth", { enterpriseUrl, onEvent: channel });
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  invalidateCopilotModelCache();
  const credential = await readCopilotCredential();
  if (!credential) throw new Error("認証後に credential が見つかりませんでした。");
  return credential;
}

export interface CopilotModelCacheEntry {
  id: string;
  endpoint: "chat" | "responses" | "messages";
  reasoningEffort?: string[];
  adaptiveThinking?: boolean;
  minThinkingBudget?: number;
  maxThinkingBudget?: number;
}

let cachedModels: Record<string, CopilotModelCacheEntry> | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 600_000;

export function invalidateCopilotModelCache(): void {
  cachedModels = null;
  cachedAt = 0;
}

export function cacheCopilotModels(models: Record<string, CopilotModelCacheEntry>): void {
  cachedModels = models;
  cachedAt = Date.now();
}

export function getCopilotModelCacheEntry(modelId: string): CopilotModelCacheEntry | undefined {
  if (Date.now() - cachedAt >= CACHE_TTL_MS) invalidateCopilotModelCache();
  return cachedModels?.[modelId];
}

export function getCopilotModelEndpoint(modelId: string): "chat" | "responses" | "messages" {
  const cached = getCopilotModelCacheEntry(modelId)?.endpoint;
  if (cached) return cached;
  if (modelId.startsWith("claude-")) return "messages";
  if (/^gpt-5(?:[.-]|$)/.test(modelId)) return "responses";
  return "chat";
}
