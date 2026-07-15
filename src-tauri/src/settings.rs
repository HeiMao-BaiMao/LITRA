use crate::storage::{
    project_characters_path as characters_path, project_world_path as world_path, read_or_empty,
    write_json,
};
use serde_json::{json, Map, Value};

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
    #[serde(default)]
    pub reading: Option<String>,
    #[serde(default)]
    pub alias: Option<String>,
}

#[tauri::command]
pub fn create_character(req: CreateCharacterRequest) -> Result<Value, String> {
    let path = characters_path(&req.project_id)?;
    let mut data = read_or_empty(&path, json!({ "characters": [] }));
    let new_id = uuid::Uuid::new_v4().to_string();

    let new_character = json!({
        "id": new_id,
        "name": req.name,
        "reading": req.reading.unwrap_or_default(),
        "alias": req.alias.unwrap_or_default(),
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

#[cfg(test)]
mod tests {
    use crate::storage::project_dir;
    use std::fs;

    use super::*;

    fn test_project_id() -> String {
        format!("test-{}", uuid::Uuid::new_v4())
    }

    fn cleanup(project_id: &str) {
        if let Ok(path) = project_dir(project_id) {
            let _ = fs::remove_dir_all(&path);
        }
    }

    #[test]
    fn character_crud_works() {
        let project_id = test_project_id();

        // create
        let created = create_character(CreateCharacterRequest {
            project_id: project_id.clone(),
            name: "猫田".to_string(),
            reading: Some("ねこた".to_string()),
            alias: None,
        })
        .expect("create_character failed");
        let characters = created["characters"].as_array().expect("characters array");
        assert_eq!(characters.len(), 1);
        let id = characters[0]["id"].as_str().unwrap().to_string();
        assert_eq!(characters[0]["reading"].as_str().unwrap(), "ねこた");

        // update birthday
        let updated = update_character(UpdateCharacterRequest {
            project_id: project_id.clone(),
            character_id: id.clone(),
            updates: {
                let mut map = Map::new();
                map.insert("birthday".to_string(), Value::String("2月23日".to_string()));
                map.insert("notes".to_string(), Value::String("雨が好き".to_string()));
                map
            },
        })
        .expect("update_character failed");
        let characters = updated["characters"].as_array().unwrap();
        let target = characters
            .iter()
            .find(|c| c["id"].as_str() == Some(&id))
            .unwrap();
        assert_eq!(target["birthday"].as_str().unwrap(), "2月23日");
        assert_eq!(target["notes"].as_str().unwrap(), "雨が好き");

        // persisted correctly
        let list = list_characters(project_id.clone()).expect("list_characters failed");
        let target = list["characters"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"].as_str() == Some(&id))
            .unwrap()
            .clone();
        assert_eq!(target["birthday"].as_str().unwrap(), "2月23日");
        assert_eq!(target["notes"].as_str().unwrap(), "雨が好き");

        cleanup(&project_id);
    }

    #[test]
    fn world_entry_crud_works() {
        let project_id = test_project_id();

        let created = create_world_entry(CreateWorldEntryRequest {
            project_id: project_id.clone(),
            name: "中央駅".to_string(),
            category: "場所".to_string(),
        })
        .expect("create_world_entry failed");
        let entries = created["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        let id = entries[0]["id"].as_str().unwrap().to_string();

        let updated = update_world_entry(UpdateWorldEntryRequest {
            project_id: project_id.clone(),
            entry_id: id.clone(),
            updates: {
                let mut map = Map::new();
                map.insert(
                    "geography".to_string(),
                    Value::String("北側の高地".to_string()),
                );
                map.insert("notes".to_string(), Value::String("深夜も営業".to_string()));
                map
            },
        })
        .expect("update_world_entry failed");
        let target = updated["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["id"].as_str() == Some(&id))
            .unwrap();
        assert_eq!(target["geography"].as_str().unwrap(), "北側の高地");
        assert_eq!(target["notes"].as_str().unwrap(), "深夜も営業");

        cleanup(&project_id);
    }
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

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteCharacterRequest {
    pub project_id: String,
    pub character_id: String,
}

#[tauri::command]
pub fn delete_character(req: DeleteCharacterRequest) -> Result<Value, String> {
    let path = characters_path(&req.project_id)?;
    let mut data = read_or_empty(&path, json!({ "characters": [] }));
    let characters = data["characters"]
        .as_array_mut()
        .ok_or_else(|| "Invalid characters structure".to_string())?;
    characters.retain(|character| character["id"].as_str() != Some(&req.character_id));
    write_json(&path, &data)?;
    Ok(data)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteWorldEntryRequest {
    pub project_id: String,
    pub entry_id: String,
}

#[tauri::command]
pub fn delete_world_entry(req: DeleteWorldEntryRequest) -> Result<Value, String> {
    let path = world_path(&req.project_id)?;
    let mut data = read_or_empty(&path, json!({ "entries": [] }));
    let entries = data["entries"]
        .as_array_mut()
        .ok_or_else(|| "Invalid world entries structure".to_string())?;
    entries.retain(|entry| entry["id"].as_str() != Some(&req.entry_id));
    write_json(&path, &data)?;
    Ok(data)
}
