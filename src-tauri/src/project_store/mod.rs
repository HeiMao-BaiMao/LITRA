mod episodes;
mod types;

use std::fs;

use chrono::Utc;
use serde_json::Value;

use crate::storage::{documents_dir, project_dir, write_json, write_text};
pub use types::{Episode, Project, ProjectDocumentKind, ProjectSummary};

fn validate_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.contains('/')
        || value.contains('\\')
        || value.contains(':')
    {
        return Err(format!("Invalid {label}: {value}"));
    }
    Ok(())
}

fn projects_root() -> Result<std::path::PathBuf, String> {
    Ok(documents_dir()?.join("litra").join("projects"))
}

#[tauri::command]
pub fn project_list() -> Result<Vec<ProjectSummary>, String> {
    let root = projects_root()?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let mut projects = Vec::new();
    for entry in fs::read_dir(&root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            continue;
        }
        let path = entry.path().join("project.json");
        let Ok(text) = fs::read_to_string(path) else {
            continue;
        };
        let Ok(project) = serde_json::from_str::<Project>(&text) else {
            continue;
        };
        projects.push(ProjectSummary {
            id: project.id,
            title: project.title,
            updated_at: project.updated_at,
        });
    }
    projects.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(projects)
}

#[tauri::command]
pub fn project_create(title: String) -> Result<Project, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let project = Project {
        id: id.clone(),
        title,
        created_at: now.clone(),
        updated_at: now.clone(),
    };
    let dir = project_dir(&id)?;
    fs::create_dir_all(dir.join("episodes")).map_err(|error| error.to_string())?;
    fs::create_dir_all(dir.join("settings")).map_err(|error| error.to_string())?;
    write_json(
        &dir.join("project.json"),
        &serde_json::to_value(&project).map_err(|error| error.to_string())?,
    )?;
    write_json(
        &dir.join("episodes.json"),
        &serde_json::json!({"episodes":[]}),
    )?;
    write_json(
        &dir.join("settings/characters.json"),
        &serde_json::json!({"characters":[]}),
    )?;
    write_json(
        &dir.join("settings/world.json"),
        &serde_json::json!({"entries":[]}),
    )?;
    write_json(&dir.join("chat.json"), &serde_json::json!([]))?;
    write_json(
        &dir.join("summaries.json"),
        &serde_json::json!({"summaries":{}}),
    )?;
    write_json(&dir.join("memos.json"), &serde_json::json!({"memos":{}}))?;
    Ok(project)
}

#[tauri::command]
pub fn project_load(project_id: String) -> Result<Project, String> {
    validate_id(&project_id, "project ID")?;
    let path = project_dir(&project_id)?.join("project.json");
    let text = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    serde_json::from_str(&text).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn project_rename(project_id: String, new_title: String) -> Result<Project, String> {
    validate_id(&project_id, "project ID")?;
    let path = project_dir(&project_id)?.join("project.json");
    let text = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    let mut project: Project =
        serde_json::from_str(&text).map_err(|error| error.to_string())?;
    project.title = new_title;
    project.updated_at = Utc::now().to_rfc3339();
    write_json(
        &path,
        &serde_json::to_value(&project).map_err(|error| error.to_string())?,
    )?;
    Ok(project)
}

#[tauri::command]
pub fn project_touch(project_id: String) -> Result<Project, String> {
    validate_id(&project_id, "project ID")?;
    let path = project_dir(&project_id)?.join("project.json");
    let text = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    let mut project: Project =
        serde_json::from_str(&text).map_err(|error| error.to_string())?;
    project.updated_at = Utc::now().to_rfc3339();
    write_json(
        &path,
        &serde_json::to_value(&project).map_err(|error| error.to_string())?,
    )?;
    Ok(project)
}

#[tauri::command]
pub fn project_delete(project_id: String) -> Result<(), String> {
    validate_id(&project_id, "project ID")?;
    crate::webdav_sync::remove_document_path(format!("litra/projects/{project_id}"), Some(true))
}

#[tauri::command]
pub fn project_list_episodes(project_id: String) -> Result<Vec<Episode>, String> {
    episodes::list(&project_id)
}
#[tauri::command]
pub fn project_create_episode(project_id: String, title: String) -> Result<Episode, String> {
    episodes::create(&project_id, title)
}
#[tauri::command]
pub fn project_read_episode(project_id: String, file_name: String) -> Result<String, String> {
    episodes::read(&project_id, &file_name)
}
#[tauri::command]
pub fn project_write_episode(
    project_id: String,
    file_name: String,
    content: String,
) -> Result<(), String> {
    episodes::write(&project_id, &file_name, &content)
}
#[tauri::command]
pub fn project_update_episode_title(
    project_id: String,
    episode_id: String,
    title: String,
) -> Result<(), String> {
    episodes::update_title(&project_id, &episode_id, title)
}
#[tauri::command]
pub fn project_delete_episode(project_id: String, episode_id: String) -> Result<(), String> {
    episodes::remove(&project_id, &episode_id)
}
#[tauri::command]
pub fn project_reorder_episodes(
    project_id: String,
    ordered_ids: Vec<String>,
) -> Result<(), String> {
    episodes::reorder(&project_id, ordered_ids)
}

#[tauri::command]
pub fn project_read_document(
    project_id: String,
    kind: ProjectDocumentKind,
) -> Result<Option<Value>, String> {
    validate_id(&project_id, "project ID")?;
    let path = project_dir(&project_id)?.join(kind.file_name());
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub fn project_write_document(
    project_id: String,
    kind: ProjectDocumentKind,
    value: Value,
) -> Result<(), String> {
    validate_id(&project_id, "project ID")?;
    let path = project_dir(&project_id)?.join(kind.file_name());
    let content = serde_json::to_string_pretty(&value).map_err(|error| error.to_string())?;
    write_text(&path, &content)
}

#[cfg(test)]
mod tests {
    use super::validate_id;
    #[test]
    fn rejects_project_path_traversal() {
        for value in ["", ".", "..", "../secret", r"project\secret", "C:project"] {
            assert!(validate_id(value, "project ID").is_err());
        }
    }
}

#[tauri::command]
pub fn project_move_episode_to_index(
    project_id: String,
    episode_id: String,
    target_index: usize,
) -> Result<(), String> {
    episodes::move_to_index(&project_id, &episode_id, target_index)
}

#[tauri::command]
pub fn project_move_episode_up(
    project_id: String,
    episode_id: String,
) -> Result<(), String> {
    episodes::move_up(&project_id, &episode_id)
}

#[tauri::command]
pub fn project_move_episode_down(
    project_id: String,
    episode_id: String,
) -> Result<(), String> {
    episodes::move_down(&project_id, &episode_id)
}

#[tauri::command]
pub fn project_migrate_from_manuscript(project_id: String) -> Result<usize, String> {
    episodes::migrate_from_manuscript(&project_id)
}
