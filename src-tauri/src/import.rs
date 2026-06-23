use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRelationshipInput {
    pub episode_title: String,
    pub character_a_name: String,
    pub character_b_name: String,
    pub direction: String,
    pub description: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct ImportFileInput {
    pub path: String,
    pub filename: String,
    #[serde(rename = "type")]
    pub file_type: String,
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub fields: HashMap<String, String>,
    pub episode_title: Option<String>,
    #[serde(default)]
    pub relationships: Vec<ImportRelationshipInput>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub characters: usize,
    pub world_entries: usize,
    pub episodes: usize,
    pub memos: usize,
    pub skipped_memos: usize,
    pub project_memos: usize,
    pub relationships: usize,
    pub skipped_relationships: usize,
}

fn documents_dir() -> Result<PathBuf, String> {
    dirs::document_dir().ok_or_else(|| "Documents directory not found".to_string())
}

fn project_dir(project_id: &str) -> Result<PathBuf, String> {
    Ok(documents_dir()?.join("phenex/projects").join(project_id))
}

fn settings_dir(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(project_id)?.join("settings"))
}

fn episodes_dir(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(project_id)?.join("episodes"))
}

fn characters_path(project_id: &str) -> Result<PathBuf, String> {
    Ok(settings_dir(project_id)?.join("characters.json"))
}

fn world_path(project_id: &str) -> Result<PathBuf, String> {
    Ok(settings_dir(project_id)?.join("world.json"))
}

fn episodes_list_path(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(project_id)?.join("episodes.json"))
}

fn memos_path(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(project_id)?.join("memos.json"))
}

fn project_memos_path(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(project_id)?.join("project-memos.json"))
}

fn relationships_path(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(project_id)?.join("relationships.json"))
}

fn ensure_parent_dir(path: &PathBuf) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory {}: {}", parent.display(), e))?;
    }
    Ok(())
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
    ensure_parent_dir(path).map_err(|e| format!("Failed to prepare {}: {}", path.display(), e))?;
    fs::write(path, serde_json::to_string_pretty(value).unwrap())
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

fn write_text(path: &PathBuf, content: &str) -> Result<(), String> {
    ensure_parent_dir(path).map_err(|e| format!("Failed to prepare {}: {}", path.display(), e))?;
    fs::write(path, content)
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

fn extract_custom_fields(
    fields: &HashMap<String, String>,
    known_keys: &[&str],
) -> Vec<Value> {
    let known_lower: Vec<String> = known_keys.iter().map(|k| k.to_lowercase()).collect();
    fields
        .iter()
        .filter(|(key, _)| !known_lower.contains(&key.to_lowercase()))
        .map(|(label, value)| json!({ "label": label, "value": value }))
        .collect()
}

fn build_character(fields: &HashMap<String, String>, body: &str, title: &str) -> Value {
    let known_keys = [
        "name", "alias", "role", "gender", "age", "birthday", "bloodtype", "height", "weight",
        "appearance", "personality", "individuality", "skills", "specialskills", "upbringing",
        "background", "notes",
    ];

    let get = |key: &str| -> String {
        fields
            .get(key)
            .cloned()
            .or_else(|| fields.get(&key.to_lowercase()).cloned())
            .unwrap_or_default()
    };

    json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "name": get("name").is_empty().then(|| title.to_string()).unwrap_or_else(|| get("name")),
        "alias": get("alias"),
        "role": get("role"),
        "gender": get("gender"),
        "age": get("age"),
        "birthday": get("birthday"),
        "bloodType": get("bloodtype"),
        "height": get("height"),
        "weight": get("weight"),
        "appearance": get("appearance"),
        "personality": get("personality"),
        "individuality": get("individuality"),
        "skills": get("skills"),
        "specialSkills": get("specialskills"),
        "upbringing": get("upbringing"),
        "background": get("background"),
        "notes": get("notes").is_empty().then(|| body.to_string()).unwrap_or_else(|| get("notes")),
        "customFields": extract_custom_fields(fields, &known_keys),
    })
}

fn build_world_entry(fields: &HashMap<String, String>, body: &str, title: &str) -> Value {
    let known_keys = [
        "name", "category", "era", "geography", "climate", "population", "politics", "laws",
        "economy", "military", "religion", "language", "culture", "history", "technology", "notes",
    ];

    let get = |key: &str| -> String {
        fields
            .get(key)
            .cloned()
            .or_else(|| fields.get(&key.to_lowercase()).cloned())
            .unwrap_or_default()
    };

    json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "name": get("name").is_empty().then(|| title.to_string()).unwrap_or_else(|| get("name")),
        "category": get("category"),
        "era": get("era"),
        "geography": get("geography"),
        "climate": get("climate"),
        "population": get("population"),
        "politics": get("politics"),
        "laws": get("laws"),
        "economy": get("economy"),
        "military": get("military"),
        "religion": get("religion"),
        "language": get("language"),
        "culture": get("culture"),
        "history": get("history"),
        "technology": get("technology"),
        "notes": get("notes").is_empty().then(|| body.to_string()).unwrap_or_else(|| get("notes")),
        "customFields": extract_custom_fields(fields, &known_keys),
    })
}

fn load_characters(project_id: &str) -> Result<Value, String> {
    let path = characters_path(project_id)?;
    Ok(read_or_empty(&path, json!({ "characters": [] })))
}

fn save_characters(project_id: &str, data: &Value) -> Result<(), String> {
    write_json(&characters_path(project_id)?, data)
}

fn load_world_entries(project_id: &str) -> Result<Value, String> {
    let path = world_path(project_id)?;
    Ok(read_or_empty(&path, json!({ "entries": [] })))
}

fn save_world_entries(project_id: &str, data: &Value) -> Result<(), String> {
    write_json(&world_path(project_id)?, data)
}

fn load_episodes(project_id: &str) -> Result<Value, String> {
    let path = episodes_list_path(project_id)?;
    Ok(read_or_empty(&path, json!({ "episodes": [] })))
}

fn save_episodes(project_id: &str, data: &Value) -> Result<(), String> {
    write_json(&episodes_list_path(project_id)?, data)
}

fn load_memos(project_id: &str) -> Result<Value, String> {
    let path = memos_path(project_id)?;
    Ok(read_or_empty(&path, json!({ "memos": {} })))
}

fn save_memos(project_id: &str, data: &Value) -> Result<(), String> {
    write_json(&memos_path(project_id)?, data)
}

fn load_project_memos(project_id: &str) -> Result<Value, String> {
    let path = project_memos_path(project_id)?;
    Ok(read_or_empty(&path, json!({ "memos": [] })))
}

fn save_project_memos(project_id: &str, data: &Value) -> Result<(), String> {
    write_json(&project_memos_path(project_id)?, data)
}

fn create_project_memo_entry(project_id: &str, title: &str, content: &str) -> Result<(), String> {
    let mut data = load_project_memos(project_id)?;
    let memos = data["memos"]
        .as_array_mut()
        .ok_or_else(|| "Invalid project memos structure".to_string())?;

    memos.push(json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "title": title,
        "content": content,
        "updatedAt": chrono::Utc::now().to_rfc3339(),
    }));

    save_project_memos(project_id, &data)
}

fn create_episode_entry(project_id: &str, title: &str, body: &str) -> Result<(String, String), String> {
    let mut episodes = load_episodes(project_id)?;
    let id = uuid::Uuid::new_v4().to_string();
    let order = episodes["episodes"].as_array().map(|arr| arr.len() as i64).unwrap_or(0);
    let file_name = format!("{}.md", id);

    let episode = json!({
        "id": id.clone(),
        "title": title,
        "order": order,
        "fileName": file_name,
    });

    episodes["episodes"]
        .as_array_mut()
        .ok_or_else(|| "Invalid episodes structure".to_string())?
        .push(episode);

    let file_path = episodes_dir(project_id)?.join(&file_name);
    write_text(&file_path, body)?;
    save_episodes(project_id, &episodes)?;

    Ok((id, title.to_string()))
}

fn save_episode_memo(project_id: &str, episode_id: &str, content: &str) -> Result<(), String> {
    let mut memos = load_memos(project_id)?;
    let entry = json!({
        "content": content,
        "updatedAt": chrono::Utc::now().to_rfc3339(),
    });

    memos["memos"]
        .as_object_mut()
        .ok_or_else(|| "Invalid memos structure".to_string())?
        .insert(episode_id.to_string(), entry);

    save_memos(project_id, &memos)
}

fn find_episode_id_by_title(episodes: &Value, title: &str) -> Option<String> {
    episodes["episodes"]
        .as_array()
        .and_then(|arr| {
            arr.iter().find_map(|ep| {
                let ep_title = ep["title"].as_str().unwrap_or_default();
                if ep_title == title {
                    ep["id"].as_str().map(|s| s.to_string())
                } else {
                    None
                }
            })
        })
}

fn load_relationships(project_id: &str) -> Result<Value, String> {
    let path = relationships_path(project_id)?;
    Ok(read_or_empty(&path, json!({ "groups": [] })))
}

fn save_relationships(project_id: &str, data: &Value) -> Result<(), String> {
    write_json(&relationships_path(project_id)?, data)
}

fn build_character_name_to_id_map(characters: &Value) -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Some(arr) = characters["characters"].as_array() {
        for character in arr {
            let id = character["id"].as_str().unwrap_or_default().to_string();
            let name = character["name"].as_str().unwrap_or_default().to_string();
            if !id.is_empty() && !name.is_empty() {
                map.insert(name.to_lowercase(), id);
            }
        }
    }
    map
}

fn normalize_direction(raw: &str) -> Option<&str> {
    match raw.trim().to_lowercase().as_str() {
        "a-to-b" | "atob" | "a→b" | "a->b" => Some("a-to-b"),
        "b-to-a" | "btoa" | "b→a" | "b->a" => Some("b-to-a"),
        "mutual" | "both" | "↔" | "<->" => Some("mutual"),
        _ => None,
    }
}

fn find_or_create_relationship_group<'a>(data: &'a mut Value, episode_id: &str) -> &'a mut Value {
    let groups = data["groups"]
        .as_array_mut()
        .expect("relationships groups must be an array");
    if let Some(index) = groups.iter().position(|g| g["episodeId"].as_str() == Some(episode_id)) {
        &mut groups[index]
    } else {
        groups.push(json!({
            "episodeId": episode_id,
            "relationships": []
        }));
        groups.last_mut().unwrap()
    }
}

fn import_relationships(
    project_id: &str,
    files: &[ImportFileInput],
    character_map: &HashMap<String, String>,
    episode_title_to_id: &HashMap<String, String>,
    episodes: &Value,
) -> Result<(usize, usize), String> {
    let mut data = load_relationships(project_id)?;
    let mut imported = 0;
    let mut skipped = 0;

    for file in files {
        if file.file_type != "relationship" {
            continue;
        }
        for rel in &file.relationships {
            let a_id = character_map.get(&rel.character_a_name.to_lowercase()).cloned();
            let b_id = character_map.get(&rel.character_b_name.to_lowercase()).cloned();
            let Some(a_id) = a_id else {
                skipped += 1;
                continue;
            };
            let Some(b_id) = b_id else {
                skipped += 1;
                continue;
            };
            let Some(direction) = normalize_direction(&rel.direction) else {
                skipped += 1;
                continue;
            };

            let episode_id = if rel.episode_title.is_empty() {
                "".to_string()
            } else {
                episode_title_to_id
                    .get(&rel.episode_title)
                    .cloned()
                    .or_else(|| find_episode_id_by_title(episodes, &rel.episode_title))
                    .unwrap_or_default()
            };

            let group = find_or_create_relationship_group(&mut data, &episode_id);
            group["relationships"]
                .as_array_mut()
                .expect("relationships array must exist")
                .push(json!({
                    "id": uuid::Uuid::new_v4().to_string(),
                    "characterAId": a_id,
                    "characterBId": b_id,
                    "direction": direction,
                    "description": rel.description,
                }));
            imported += 1;
        }
    }

    save_relationships(project_id, &data)?;
    Ok((imported, skipped))
}

#[tauri::command]
pub async fn import_files(project_id: String, files: Vec<ImportFileInput>) -> Result<ImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || do_import(&project_id, &files)).await.map_err(|e| e.to_string())?
}

fn do_import(project_id: &str, files: &[ImportFileInput]) -> Result<ImportResult, String> {
    let mut result = ImportResult {
        characters: 0,
        world_entries: 0,
        episodes: 0,
        memos: 0,
        skipped_memos: 0,
        project_memos: 0,
        relationships: 0,
        skipped_relationships: 0,
    };

    let mut characters = load_characters(project_id)?;
    let mut world_entries = load_world_entries(project_id)?;
    let episodes = load_episodes(project_id)?;
    let mut episode_title_to_id: HashMap<String, String> = HashMap::new();
    if let Some(arr) = episodes["episodes"].as_array() {
        for ep in arr {
            if let (Some(id), Some(title)) = (ep["id"].as_str(), ep["title"].as_str()) {
                episode_title_to_id.insert(title.to_string(), id.to_string());
            }
        }
    }

    // 1st pass: characters and world entries
    for file in files {
        match file.file_type.as_str() {
            "character" => {
                let character = build_character(&file.fields, &file.content, &file.title);
                characters["characters"]
                    .as_array_mut()
                    .ok_or_else(|| "Invalid characters structure".to_string())?
                    .push(character);
                result.characters += 1;
            }
            "world" => {
                let entry = build_world_entry(&file.fields, &file.content, &file.title);
                world_entries["entries"]
                    .as_array_mut()
                    .ok_or_else(|| "Invalid world entries structure".to_string())?
                    .push(entry);
                result.world_entries += 1;
            }
            _ => {}
        }
    }

    save_characters(project_id, &characters)?;
    save_world_entries(project_id, &world_entries)?;

    // 2nd pass: episodes
    for file in files {
        if file.file_type != "episode" {
            continue;
        }
        let (id, created_title) = create_episode_entry(project_id, &file.title, &file.content)?;
        episode_title_to_id.insert(created_title, id);
        result.episodes += 1;
    }

    // 3rd pass: memos
    for file in files {
        if file.file_type != "memo" {
            continue;
        }
        let target_title = file.episode_title.as_ref().unwrap_or(&file.title);
        let episode_id = episode_title_to_id
            .get(target_title)
            .cloned()
            .or_else(|| find_episode_id_by_title(&episodes, target_title));

        if let Some(episode_id) = episode_id {
            save_episode_memo(project_id, &episode_id, &file.content)?;
            result.memos += 1;
        } else {
            result.skipped_memos += 1;
        }
    }

    // 4th pass: project memos
    for file in files {
        if file.file_type != "projectMemo" {
            continue;
        }
        create_project_memo_entry(project_id, &file.title, &file.content)?;
        result.project_memos += 1;
    }

    // 5th pass: relationships
    let character_map = build_character_name_to_id_map(&characters);
    let (imported_relationships, skipped_relationships) = import_relationships(
        project_id,
        files,
        &character_map,
        &episode_title_to_id,
        &episodes,
    )?;
    result.relationships = imported_relationships;
    result.skipped_relationships = skipped_relationships;

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_project_id() -> String {
        format!("test-import-{}", uuid::Uuid::new_v4())
    }

    fn cleanup(project_id: &str) {
        if let Ok(path) = project_dir(project_id) {
            let _ = fs::remove_dir_all(&path);
        }
    }

    #[test]
    fn import_creates_character_and_episode() {
        let project_id = test_project_id();

        let files = vec![
            ImportFileInput {
                path: "chars/hero.md".to_string(),
                filename: "hero.md".to_string(),
                file_type: "character".to_string(),
                title: "主人公".to_string(),
                content: "名前: 太郎\n年齢: 20\n\n性格は明るい。".to_string(),
                fields: {
                    let mut map = HashMap::new();
                    map.insert("name".to_string(), "太郎".to_string());
                    map.insert("age".to_string(), "20".to_string());
                    map.insert("personality".to_string(), "明るい".to_string());
                    map
                },
                episode_title: None,
                relationships: Vec::new(),
            },
            ImportFileInput {
                path: "episodes/01.md".to_string(),
                filename: "01.md".to_string(),
                file_type: "episode".to_string(),
                title: "第一話".to_string(),
                content: "# 第一話\n\n本文".to_string(),
                fields: HashMap::new(),
                episode_title: None,
                relationships: Vec::new(),
            },
            ImportFileInput {
                path: "memos/01.md".to_string(),
                filename: "01.md".to_string(),
                file_type: "memo".to_string(),
                title: "第一話".to_string(),
                content: "覚え書き".to_string(),
                fields: HashMap::new(),
                episode_title: Some("第一話".to_string()),
                relationships: Vec::new(),
            },
        ];

        let result = do_import(&project_id, &files).expect("import failed");
        assert_eq!(result.characters, 1);
        assert_eq!(result.episodes, 1);
        assert_eq!(result.memos, 1);
        assert_eq!(result.skipped_memos, 0);

        let chars = load_characters(&project_id).unwrap();
        let char_array = chars["characters"].as_array().unwrap();
        assert_eq!(char_array[0]["name"].as_str().unwrap(), "太郎");
        assert_eq!(char_array[0]["age"].as_str().unwrap(), "20");

        let eps = load_episodes(&project_id).unwrap();
        let ep_array = eps["episodes"].as_array().unwrap();
        assert_eq!(ep_array[0]["title"].as_str().unwrap(), "第一話");

        cleanup(&project_id);
    }

    #[test]
    fn import_creates_project_memo() {
        let project_id = test_project_id();

        let files = vec![ImportFileInput {
            path: "memos/project-memo.md".to_string(),
            filename: "project-memo.md".to_string(),
            file_type: "projectMemo".to_string(),
            title: "世界観覚書".to_string(),
            content: "この世界では魔法は日常である。".to_string(),
            fields: HashMap::new(),
            episode_title: None,
            relationships: Vec::new(),
        }];

        let result = do_import(&project_id, &files).expect("import failed");
        assert_eq!(result.project_memos, 1);

        let memos = load_project_memos(&project_id).unwrap();
        let memo_array = memos["memos"].as_array().unwrap();
        assert_eq!(memo_array.len(), 1);
        assert_eq!(memo_array[0]["title"].as_str().unwrap(), "世界観覚書");
        assert_eq!(memo_array[0]["content"].as_str().unwrap(), "この世界では魔法は日常である。");

        cleanup(&project_id);
    }

    #[test]
    fn import_creates_relationships() {
        let project_id = test_project_id();

        let files = vec![
            ImportFileInput {
                path: "chars/hero.md".to_string(),
                filename: "hero.md".to_string(),
                file_type: "character".to_string(),
                title: "主人公".to_string(),
                content: "名前: 太郎".to_string(),
                fields: {
                    let mut map = HashMap::new();
                    map.insert("name".to_string(), "太郎".to_string());
                    map
                },
                episode_title: None,
                relationships: Vec::new(),
            },
            ImportFileInput {
                path: "chars/heroine.md".to_string(),
                filename: "heroine.md".to_string(),
                file_type: "character".to_string(),
                title: "ヒロイン".to_string(),
                content: "名前: 花子".to_string(),
                fields: {
                    let mut map = HashMap::new();
                    map.insert("name".to_string(), "花子".to_string());
                    map
                },
                episode_title: None,
                relationships: Vec::new(),
            },
            ImportFileInput {
                path: "relations/main.md".to_string(),
                filename: "main.md".to_string(),
                file_type: "relationship".to_string(),
                title: "相関図".to_string(),
                content: "太郎と花子は幼馴染".to_string(),
                fields: HashMap::new(),
                episode_title: None,
                relationships: vec![ImportRelationshipInput {
                    episode_title: "".to_string(),
                    character_a_name: "太郎".to_string(),
                    character_b_name: "花子".to_string(),
                    direction: "mutual".to_string(),
                    description: "幼馴染".to_string(),
                }],
            },
        ];

        let result = do_import(&project_id, &files).expect("import failed");
        assert_eq!(result.characters, 2);
        assert_eq!(result.relationships, 1);
        assert_eq!(result.skipped_relationships, 0);

        let rels = load_relationships(&project_id).unwrap();
        let groups = rels["groups"].as_array().unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0]["episodeId"].as_str().unwrap(), "");
        let relationships = groups[0]["relationships"].as_array().unwrap();
        assert_eq!(relationships.len(), 1);
        assert_eq!(relationships[0]["direction"].as_str().unwrap(), "mutual");
        assert_eq!(relationships[0]["description"].as_str().unwrap(), "幼馴染");

        cleanup(&project_id);
    }
}
