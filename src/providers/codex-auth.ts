import { invoke } from "@tauri-apps/api/core";
import { readOAuthCredential, writeOAuthCredential } from "../secrets.ts";

export interface CodexCredential {
  [key: string]: unknown;
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
}

const CREDENTIAL_PROVIDER = "codex" as const;

export async function readCodexCredential(): Promise<CodexCredential | undefined> {
  return readOAuthCredential<CodexCredential>(CREDENTIAL_PROVIDER);
}

export async function deleteCodexCredential(): Promise<void> {
  await writeOAuthCredential(CREDENTIAL_PROVIDER, undefined);
}

export async function loginWithBrowserCode(signal: AbortSignal): Promise<CodexCredential> {
  const pending = invoke<{ success: boolean; message: string }>("start_codex_browser_auth");
  const cancel = (): void => { void invoke("cancel_codex_browser_auth"); };
  if (signal.aborted) {
    cancel();
    throw new Error("ログインがキャンセルされました。");
  }
  signal.addEventListener("abort", cancel, { once: true });
  let result: { success: boolean; message: string };
  try {
    result = await pending;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  if (!result.success) throw new Error(result.message);
  const credential = await readCodexCredential();
  if (!credential) throw new Error("認証後に credential が見つかりませんでした。");
  return credential;
}
