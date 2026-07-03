import {
  BaseDirectory,
  exists,
  mkdir,
  readDir,
  readTextFile,
  remove,
  writeTextFile,
} from "@tauri-apps/plugin-fs";

const PROJECTS_ROOT = "phenex/projects";

export interface Project {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary {
  id: string;
  title: string;
  updatedAt: string;
}

function projectDir(projectId: string): string {
  return `${PROJECTS_ROOT}/${projectId}`;
}

function projectJsonPath(projectId: string): string {
  return `${projectDir(projectId)}/project.json`;
}

async function ensureProjectsRoot(): Promise<void> {
  const rootExists = await exists(PROJECTS_ROOT, { baseDir: BaseDirectory.Document });
  if (!rootExists) {
    await mkdir(PROJECTS_ROOT, { baseDir: BaseDirectory.Document, recursive: true });
  }
}

function isProject(value: unknown): value is Project {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Partial<Project>;
  return (
    typeof p.id === "string" &&
    typeof p.title === "string" &&
    typeof p.createdAt === "string" &&
    typeof p.updatedAt === "string"
  );
}

export async function listProjects(): Promise<ProjectSummary[]> {
  await ensureProjectsRoot();
  const entries = await readDir(PROJECTS_ROOT, { baseDir: BaseDirectory.Document });
  const projects: ProjectSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    try {
      const project = await loadProject(entry.name);
      projects.push({
        id: project.id,
        title: project.title,
        updatedAt: project.updatedAt,
      });
    } catch {
      // project.json がない・壊れているディレクトリは無視
    }
  }

  return projects.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

export async function createProject(title: string): Promise<Project> {
  await ensureProjectsRoot();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const project: Project = { id, title, createdAt: now, updatedAt: now };
  const dir = projectDir(id);

  await mkdir(dir, { baseDir: BaseDirectory.Document, recursive: true });
  await mkdir(`${dir}/episodes`, { baseDir: BaseDirectory.Document, recursive: true });
  await mkdir(`${dir}/settings`, { baseDir: BaseDirectory.Document, recursive: true });

  await writeTextFile(projectJsonPath(id), JSON.stringify(project, null, 2), {
    baseDir: BaseDirectory.Document,
  });
  await writeTextFile(`${dir}/episodes.json`, JSON.stringify({ episodes: [] }, null, 2), {
    baseDir: BaseDirectory.Document,
  });
  await writeTextFile(`${dir}/settings/characters.json`, JSON.stringify({ characters: [] }, null, 2), {
    baseDir: BaseDirectory.Document,
  });
  await writeTextFile(`${dir}/settings/world.json`, JSON.stringify({ entries: [] }, null, 2), {
    baseDir: BaseDirectory.Document,
  });
  await writeTextFile(`${dir}/chat.json`, JSON.stringify([]), {
    baseDir: BaseDirectory.Document,
  });
  await writeTextFile(`${dir}/summaries.json`, JSON.stringify({ summaries: {} }, null, 2), {
    baseDir: BaseDirectory.Document,
  });
  await writeTextFile(`${dir}/memos.json`, JSON.stringify({ memos: {} }, null, 2), {
    baseDir: BaseDirectory.Document,
  });

  return project;
}

export async function loadProject(projectId: string): Promise<Project> {
  const text = await readTextFile(projectJsonPath(projectId), {
    baseDir: BaseDirectory.Document,
  });
  const parsed: unknown = JSON.parse(text);
  if (!isProject(parsed)) {
    throw new Error(`プロジェクト ${projectId} のメタデータが不正です。`);
  }
  return parsed;
}

export async function saveProject(project: Project): Promise<void> {
  const updated: Project = { ...project, updatedAt: new Date().toISOString() };
  await writeTextFile(projectJsonPath(project.id), JSON.stringify(updated, null, 2), {
    baseDir: BaseDirectory.Document,
  });
}

export async function deleteProject(projectId: string): Promise<void> {
  await remove(projectDir(projectId), { baseDir: BaseDirectory.Document, recursive: true });
}
