use std::fs;
use std::path::PathBuf;

fn documents_dir() -> Result<PathBuf, String> {
    dirs::document_dir().ok_or_else(|| "Documents directory not found".to_string())
}

fn project_dir(project_id: &str) -> Result<PathBuf, String> {
    Ok(documents_dir()?.join("phenex/projects").join(project_id))
}

fn project_memo_path(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(project_id)?.join("project-memo.md"))
}

#[tauri::command]
pub fn load_project_memo(project_id: String) -> Result<String, String> {
    let path = project_memo_path(&project_id)?;
    if !path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {}", path.display(), e))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProjectMemoRequest {
    pub project_id: String,
    pub content: String,
}

#[tauri::command]
pub fn save_project_memo(req: SaveProjectMemoRequest) -> Result<(), String> {
    let path = project_memo_path(&req.project_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory {}: {}", parent.display(), e))?;
    }
    fs::write(&path, req.content)
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}
