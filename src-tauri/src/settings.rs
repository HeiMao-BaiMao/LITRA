use serde_json::{json, Map, Value};
use std::fs;
use std::path::PathBuf;

fn documents_dir() -> Result<PathBuf, String> {
    dirs::document_dir().ok_or_else(|| "Documents directory not found".to_string())
}

fn project_dir(project_id: &str) -> Result<PathBuf, String> {
    Ok(documents_dir()?.join("phenex/projects").join(project_id))
}

fn settings_dir(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(project_id)?.join("settings"))
}

fn characters_path(project_id: &str) -> Result<PathBuf, String> {
    Ok(settings_dir(project_id)?.join("characters.json"))
}

fn world_path(project_id: &str) -> Result<PathBuf, String> {
    Ok(settings_dir(project_id)?.join("world.json"))
}

fn read_json(path: &PathBuf) -> Result<Value, String> {
    let text = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse {}: {}", path.display(), e))
}

fn read_or_empty(path: &PathBuf, empty: Value) -> Value {
    if path.exists() {
        read_json(path).unwrap_or(empty)
    } else {
        empty
    }
}

fn write_json(path: &PathBuf, value: &Value) -> Result<(), String> {
    fs::write(path, serde_json::to_string_pretty(value).unwrap())
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

fn merge_updates(target: &mut Value, updates: Map<String, Value>) {
    if let Some(obj) = target.as_object_mut() {
        for (key, value) in updates {
            obj.insert(key, value);
        }
    }
}

#[tauri::command]
pub fn list_characters(project_id: String) -> Result<Value, String> {
    let path = characters_path(&project_id)?;
    Ok(read_or_empty(&path, json!({ "characters": [] })))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCharacterRequest {
    pub project_id: String,
    pub name: String,
}

#[tauri::command]
pub fn create_character(req: CreateCharacterRequest) -> Result<Value, String> {
    let path = characters_path(&req.project_id)?;
    let mut data = read_or_empty(&path, json!({ "characters": [] }));
    let new_id = uuid::Uuid::new_v4().to_string();

    let new_character = json!({
        "id": new_id,
        "name": req.name,
        "alias": "",
        "role": "",
        "gender": "",
        "age": "",
        "birthday": "",
        "bloodType": "",
        "height": "",
        "weight": "",
        "appearance": "",
        "personality": "",
        "individuality": "",
        "skills": "",
        "specialSkills": "",
        "upbringing": "",
        "background": "",
        "notes": "",
        "customFields": [],
    });

    data["characters"]
        .as_array_mut()
        .ok_or_else(|| "Invalid characters structure".to_string())?
        .push(new_character);

    write_json(&path, &data)?;
    Ok(data)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCharacterRequest {
    pub project_id: String,
    pub character_id: String,
    pub updates: Map<String, Value>,
}

#[tauri::command]
pub fn update_character(req: UpdateCharacterRequest) -> Result<Value, String> {
    let path = characters_path(&req.project_id)?;
    let mut data = read_or_empty(&path, json!({ "characters": [] }));

    let characters = data["characters"]
        .as_array_mut()
        .ok_or_else(|| "Invalid characters structure".to_string())?;

    let target = characters
        .iter_mut()
        .find(|c| c["id"].as_str() == Some(&req.character_id))
        .ok_or_else(|| format!("Character {} not found", req.character_id))?;

    merge_updates(target, req.updates);
    write_json(&path, &data)?;
    Ok(data)
}

#[tauri::command]
pub fn list_world_entries(project_id: String) -> Result<Value, String> {
    let path = world_path(&project_id)?;
    Ok(read_or_empty(&path, json!({ "entries": [] })))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorldEntryRequest {
    pub project_id: String,
    pub name: String,
    pub category: String,
}

#[tauri::command]
pub fn create_world_entry(req: CreateWorldEntryRequest) -> Result<Value, String> {
    let path = world_path(&req.project_id)?;
    let mut data = read_or_empty(&path, json!({ "entries": [] }));
    let new_id = uuid::Uuid::new_v4().to_string();

    let new_entry = json!({
        "id": new_id,
        "name": req.name,
        "category": req.category,
        "era": "",
        "geography": "",
        "climate": "",
        "population": "",
        "politics": "",
        "laws": "",
        "economy": "",
        "military": "",
        "religion": "",
        "language": "",
        "culture": "",
        "history": "",
        "technology": "",
        "notes": "",
        "customFields": [],
    });

    data["entries"]
        .as_array_mut()
        .ok_or_else(|| "Invalid world entries structure".to_string())?
        .push(new_entry);

    write_json(&path, &data)?;
    Ok(data)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWorldEntryRequest {
    pub project_id: String,
    pub entry_id: String,
    pub updates: Map<String, Value>,
}

#[tauri::command]
pub fn update_world_entry(req: UpdateWorldEntryRequest) -> Result<Value, String> {
    let path = world_path(&req.project_id)?;
    let mut data = read_or_empty(&path, json!({ "entries": [] }));

    let entries = data["entries"]
        .as_array_mut()
        .ok_or_else(|| "Invalid world entries structure".to_string())?;

    let target = entries
        .iter_mut()
        .find(|e| e["id"].as_str() == Some(&req.entry_id))
        .ok_or_else(|| format!("World entry {} not found", req.entry_id))?;

    merge_updates(target, req.updates);
    write_json(&path, &data)?;
    Ok(data)
}
