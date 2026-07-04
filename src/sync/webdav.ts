import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface WebDavSyncConfig {
  enabled: boolean;
  baseUrl: string;
  username?: string;
  password?: string;
  remoteFolder: string;
}

export interface SyncSummary {
  filesProcessed: number;
  filesFailed: number;
  errors: string[];
}

export type SyncPhase = "pull" | "push";

export interface SyncProgressPayload {
  phase: SyncPhase;
  current: number;
  total: number;
  message: string;
}

export async function loadWebDavSyncConfig(): Promise<WebDavSyncConfig> {
  return await invoke<WebDavSyncConfig>("load_webdav_sync_config");
}

export async function saveWebDavSyncConfig(config: WebDavSyncConfig): Promise<void> {
  await invoke("save_webdav_sync_config", { config });
}

export async function writeDocumentTextFile(path: string, contents: string): Promise<void> {
  await invoke("write_document_text_file", { path, contents });
}

export async function removeDocumentPath(
  path: string,
  options: { recursive?: boolean } = {},
): Promise<void> {
  await invoke("remove_document_path", { path, recursive: options.recursive ?? false });
}

/// WebDav から全ファイルをダウンロードし、ローカルを完全ミラー化する。
/// 無効設定時は空のサマリーを返す。
export async function pullWebDavAll(): Promise<SyncSummary> {
  return await invoke<SyncSummary>("pull_webdav_all");
}

/// ローカルの全ファイルを WebDav にアップロード（full push）する。
/// 無効設定時は空のサマリーを返す。
export async function pushWebDavAll(): Promise<SyncSummary> {
  return await invoke<SyncSummary>("push_webdav_all");
}

/// 同期進捗イベントを購読する。リスナー解除用の関数を返す。
export function onSyncProgress(
  callback: (payload: SyncProgressPayload) => void,
): Promise<UnlistenFn> {
  return listen<SyncProgressPayload>("webdav-sync-progress", (event) => {
    callback(event.payload);
  });
}
