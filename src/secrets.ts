import { invoke } from "@tauri-apps/api/core";
import type { Provider } from "./settings.ts";

export function apiKeySecretKey(provider: Provider): string {
  return `apikey:${provider}`;
}

/** OAuth クレデンシャルを OS キーリングに保存するためのキー */
export function oauthCredentialKey(provider: Provider): string {
  return `oauth:${provider}`;
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

// Windows Credential Manager has a 2560 UTF-16 code-unit password limit.
// OAuth JWTs can exceed it, so store JSON in conservative chunks and keep only
// a small manifest at the historical base key.
// keyring's Windows backend reports a 2560-byte UTF-16 limit, so stay well
// below 1280 UTF-16 code units (including backend overhead).
const OAUTH_CHUNK_SIZE = 1000;
const OAUTH_CHUNK_PREFIX = "chunks:v1:";

function oauthChunkKey(provider: Provider, index: number): string {
  return `${oauthCredentialKey(provider)}:${index}`;
}

function chunkCount(manifest: string | undefined): number {
  if (!manifest?.startsWith(OAUTH_CHUNK_PREFIX)) return 0;
  const count = Number(manifest.slice(OAUTH_CHUNK_PREFIX.length));
  return Number.isSafeInteger(count) && count > 0 && count <= 32 ? count : 0;
}

async function deleteOAuthChunks(provider: Provider, manifest?: string): Promise<void> {
  const count = chunkCount(manifest ?? await secretGet(oauthCredentialKey(provider)));
  await Promise.all(Array.from({ length: count }, (_, i) => secretDelete(oauthChunkKey(provider, i))));
}

/** OAuth クレデンシャル JSON を安全に読み取る。解析不能または空なら undefined を返す。 */
export async function readOAuthCredential<T extends Record<string, unknown>>(
  provider: Provider,
): Promise<T | undefined> {
  const manifest = await secretGet(oauthCredentialKey(provider));
  if (!manifest) return undefined;
  const count = chunkCount(manifest);
  const raw = count > 0
    ? (await Promise.all(Array.from({ length: count }, (_, i) => secretGet(oauthChunkKey(provider, i))))).join("")
    : manifest; // backward compatibility with short, unchunked credentials
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** OAuth クレデンシャル JSON をキーリングに書き込む。undefined の場合は削除する。 */
export async function writeOAuthCredential<T extends Record<string, unknown>>(
  provider: Provider,
  credential: T | undefined,
): Promise<void> {
  const key = oauthCredentialKey(provider);
  const previous = await secretGet(key);
  await deleteOAuthChunks(provider, previous);
  if (!credential) {
    await secretDelete(key);
    return;
  }
  const characters = Array.from(JSON.stringify(credential));
  const chunks: string[] = [];
  for (let i = 0; i < characters.length; i += OAUTH_CHUNK_SIZE) {
    chunks.push(characters.slice(i, i + OAUTH_CHUNK_SIZE).join(""));
  }
  for (let i = 0; i < chunks.length; i++) await secretSet(oauthChunkKey(provider, i), chunks[i]);
  await secretSet(key, `${OAUTH_CHUNK_PREFIX}${chunks.length}`);
}

/** OAuth プロバイダーのリセット（ログアウト） */
export async function deleteOAuthCredential(provider: Provider): Promise<void> {
  await writeOAuthCredential(provider, undefined);
}
