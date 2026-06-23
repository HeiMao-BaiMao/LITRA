import { invoke } from "@tauri-apps/api/core";

export async function loadProjectMemo(projectId: string): Promise<string> {
  return await invoke<string>("load_project_memo", { projectId });
}

export async function saveProjectMemo(projectId: string, content: string): Promise<void> {
  await invoke("save_project_memo", { projectId, content });
}
