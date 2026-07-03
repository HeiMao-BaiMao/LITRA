import { invoke } from "@tauri-apps/api/core";

export interface WebDavSyncConfig {
  enabled: boolean;
  baseUrl: string;
  username?: string;
  password?: string;
  remoteFolder: string;
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
