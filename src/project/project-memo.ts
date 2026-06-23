import { invoke } from "@tauri-apps/api/core";

export interface ProjectMemo {
  id: string;
  title: string;
  content: string;
  updatedAt: string;
}

export async function listProjectMemos(projectId: string): Promise<ProjectMemo[]> {
  return await invoke<ProjectMemo[]>("list_project_memos", { projectId });
}

export async function createProjectMemo(projectId: string, title: string): Promise<ProjectMemo> {
  return await invoke<ProjectMemo>("create_project_memo", { projectId, title });
}

export async function updateProjectMemo(
  projectId: string,
  memoId: string,
  updates: { title?: string; content?: string },
): Promise<ProjectMemo> {
  return await invoke<ProjectMemo>("update_project_memo", {
    projectId,
    memoId,
    title: updates.title,
    content: updates.content,
  });
}

export async function deleteProjectMemo(projectId: string, memoId: string): Promise<void> {
  await invoke("delete_project_memo", { projectId, memoId });
}
