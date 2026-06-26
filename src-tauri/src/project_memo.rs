use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

fn documents_dir() -> Result<PathBuf, String> {
    dirs::document_dir().ok_or_else(|| "Documents directory not found".to_string())
}

fn project_dir(project_id: &str) -> Result<PathBuf, String> {
    Ok(documents_dir()?.join("phenex/projects").join(project_id))
}

fn project_memos_path(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(project_id)?.join("project-memos.json"))
}

fn read_json(path: &PathBuf) -> Result<Value, String> {
    let text = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    serde_json::from_str(&text).map_err(|e| format!("Failed to parse {}: {}", path.display(), e))
}

fn read_or_empty(path: &PathBuf, empty: Value) -> Value {
    if path.exists() {
        read_json(path).unwrap_or(empty)
    } else {
        empty
    }
}

fn write_json(path: &PathBuf, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory {}: {}", parent.display(), e))?;
    }
    fs::write(path, serde_json::to_string_pretty(value).unwrap())
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

fn load_memos_value(project_id: &str) -> Result<Value, String> {
    let path = project_memos_path(project_id)?;
    Ok(read_or_empty(&path, json!({ "memos": [] })))
}

fn save_memos_value(project_id: &str, value: &Value) -> Result<(), String> {
    write_json(&project_memos_path(project_id)?, value)
}

fn ensure_memos_array(data: &mut Value) -> &mut Vec<Value> {
    if !data.get("memos").map(|v| v.is_array()).unwrap_or(false) {
        data["memos"] = json!([]);
    }
    data["memos"]
        .as_array_mut()
        .expect("memos must be an array after ensure")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMemo {
    pub id: String,
    pub title: String,
    pub content: String,
    pub updated_at: String,
}

#[tauri::command]
pub fn list_project_memos(project_id: String) -> Result<Vec<ProjectMemo>, String> {
    let data = load_memos_value(&project_id)?;
    let memos = data["memos"].as_array().cloned().unwrap_or_default();

    let mut result = Vec::new();
    for memo in memos {
        let id = memo["id"].as_str().unwrap_or_default().to_string();
        let title = memo["title"].as_str().unwrap_or_default().to_string();
        let content = memo["content"].as_str().unwrap_or_default().to_string();
        let updated_at = memo["updatedAt"]
            .as_str()
            .unwrap_or(&Utc::now().to_rfc3339())
            .to_string();
        result.push(ProjectMemo {
            id,
            title,
            content,
            updated_at,
        });
    }

    Ok(result)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectMemoRequest {
    pub project_id: String,
    pub title: String,
}

#[tauri::command]
pub fn create_project_memo(req: CreateProjectMemoRequest) -> Result<ProjectMemo, String> {
    let mut data = load_memos_value(&req.project_id)?;
    let memos = ensure_memos_array(&mut data);

    let memo = ProjectMemo {
        id: uuid::Uuid::new_v4().to_string(),
        title: req.title,
        content: String::new(),
        updated_at: Utc::now().to_rfc3339(),
    };

    memos.push(json!({
        "id": memo.id,
        "title": memo.title,
        "content": memo.content,
        "updatedAt": memo.updated_at,
    }));

    save_memos_value(&req.project_id, &data)?;
    Ok(memo)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProjectMemoRequest {
    pub project_id: String,
    pub memo_id: String,
    pub title: Option<String>,
    pub content: Option<String>,
}

#[tauri::command]
pub fn update_project_memo(req: UpdateProjectMemoRequest) -> Result<ProjectMemo, String> {
    let mut data = load_memos_value(&req.project_id)?;
    let memos = ensure_memos_array(&mut data);

    let result = {
        let target = memos
            .iter_mut()
            .find(|m| m["id"].as_str() == Some(&req.memo_id))
            .ok_or_else(|| format!("Memo {} not found", req.memo_id))?;

        if let Some(title) = req.title {
            target["title"] = json!(title);
        }
        if let Some(content) = req.content {
            target["content"] = json!(content);
        }
        target["updatedAt"] = json!(Utc::now().to_rfc3339());

        ProjectMemo {
            id: target["id"].as_str().unwrap_or_default().to_string(),
            title: target["title"].as_str().unwrap_or_default().to_string(),
            content: target["content"].as_str().unwrap_or_default().to_string(),
            updated_at: target["updatedAt"].as_str().unwrap_or_default().to_string(),
        }
    };

    save_memos_value(&req.project_id, &data)?;

    Ok(result)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteProjectMemoRequest {
    pub project_id: String,
    pub memo_id: String,
}

#[tauri::command]
pub fn delete_project_memo(req: DeleteProjectMemoRequest) -> Result<(), String> {
    let mut data = load_memos_value(&req.project_id)?;
    let memos = ensure_memos_array(&mut data);

    memos.retain(|m| m["id"].as_str() != Some(&req.memo_id));

    save_memos_value(&req.project_id, &data)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_project_id() -> String {
        format!("test-project-memos-{}", uuid::Uuid::new_v4())
    }

    fn cleanup(project_id: &str) {
        if let Ok(path) = project_dir(project_id) {
            let _ = fs::remove_dir_all(&path);
        }
    }

    #[test]
    fn project_memo_crud_works() {
        let project_id = test_project_id();

        let created = create_project_memo(CreateProjectMemoRequest {
            project_id: project_id.clone(),
            title: "設定メモ".to_string(),
        })
        .expect("create failed");
        assert_eq!(created.title, "設定メモ");

        let updated = update_project_memo(UpdateProjectMemoRequest {
            project_id: project_id.clone(),
            memo_id: created.id.clone(),
            title: None,
            content: Some("内容".to_string()),
        })
        .expect("update failed");
        assert_eq!(updated.content, "内容");

        let list = list_project_memos(project_id.clone()).expect("list failed");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].content, "内容");

        delete_project_memo(DeleteProjectMemoRequest {
            project_id: project_id.clone(),
            memo_id: created.id,
        })
        .expect("delete failed");
        let list = list_project_memos(project_id.clone()).expect("list failed after delete");
        assert!(list.is_empty());

        cleanup(&project_id);
    }
}
