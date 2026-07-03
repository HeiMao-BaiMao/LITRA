use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

const APP_DATA_DIR: &str = "litra";
const LEGACY_APP_DATA_DIR: &str = "phenex";

pub fn documents_dir() -> Result<PathBuf, String> {
    dirs::document_dir().ok_or_else(|| "Documents directory not found".to_string())
}

pub fn data_or_documents_dir() -> Result<PathBuf, String> {
    dirs::data_dir()
        .or_else(dirs::document_dir)
        .ok_or_else(|| "App data directory not found".to_string())
}

pub fn project_dir(project_id: &str) -> Result<PathBuf, String> {
    Ok(documents_dir()?
        .join(APP_DATA_DIR)
        .join("projects")
        .join(project_id))
}

pub fn project_settings_dir(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(project_id)?.join("settings"))
}

pub fn project_episodes_dir(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(project_id)?.join("episodes"))
}

pub fn project_characters_path(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_settings_dir(project_id)?.join("characters.json"))
}

pub fn project_world_path(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_settings_dir(project_id)?.join("world.json"))
}

pub fn project_episodes_list_path(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(project_id)?.join("episodes.json"))
}

pub fn project_memos_path(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(project_id)?.join("memos.json"))
}

pub fn project_memos_list_path(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(project_id)?.join("project-memos.json"))
}

pub fn project_relationships_path(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(project_id)?.join("relationships.json"))
}

pub fn project_summaries_path(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(project_id)?.join("summaries.json"))
}

pub fn project_search_index_dir(project_id: &str) -> Result<PathBuf, String> {
    Ok(data_or_documents_dir()?
        .join(APP_DATA_DIR)
        .join("index")
        .join(project_id))
}

pub fn genre_dir(genre_id: &str) -> Result<PathBuf, String> {
    Ok(documents_dir()?
        .join(APP_DATA_DIR)
        .join("genres")
        .join(genre_id))
}

pub fn genre_search_index_dir(genre_id: &str) -> Result<PathBuf, String> {
    Ok(data_or_documents_dir()?
        .join(APP_DATA_DIR)
        .join("genre-index")
        .join(genre_id))
}

fn copy_dir_recursive(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target)
        .map_err(|e| format!("Failed to create directory {}: {}", target.display(), e))?;

    for entry in fs::read_dir(source)
        .map_err(|e| format!("Failed to read directory {}: {}", source.display(), e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());

        if target_path.exists() {
            continue;
        }

        let file_type = entry
            .file_type()
            .map_err(|e| format!("Failed to read file type {}: {}", source_path.display(), e))?;
        if file_type.is_dir() {
            copy_dir_recursive(&source_path, &target_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &target_path).map_err(|e| {
                format!(
                    "Failed to copy {} to {}: {}",
                    source_path.display(),
                    target_path.display(),
                    e
                )
            })?;
        }
    }

    Ok(())
}

fn read_json_if_valid(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn has_string(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_str).is_some()
}

fn has_array(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_array).is_some()
}

fn has_object(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_object).is_some()
}

fn json_is_array(path: &Path) -> bool {
    read_json_if_valid(path)
        .as_ref()
        .is_some_and(Value::is_array)
}

fn json_field_is_array(path: &Path, key: &str) -> bool {
    read_json_if_valid(path)
        .as_ref()
        .is_some_and(|value| has_array(value, key))
}

fn json_field_is_object(path: &Path, key: &str) -> bool {
    read_json_if_valid(path)
        .as_ref()
        .is_some_and(|value| has_object(value, key))
}

fn schema_json_field_is_array(path: &Path, key: &str) -> bool {
    read_json_if_valid(path).as_ref().is_some_and(|value| {
        value.get("schemaVersion").and_then(Value::as_i64) == Some(1) && has_array(value, key)
    })
}

fn is_valid_legacy_project_dir(path: &Path, dir_name: &str) -> bool {
    let Some(project) = read_json_if_valid(&path.join("project.json")) else {
        return false;
    };

    project.get("id").and_then(Value::as_str) == Some(dir_name)
        && has_string(&project, "title")
        && has_string(&project, "createdAt")
        && has_string(&project, "updatedAt")
        && json_field_is_array(&path.join("episodes.json"), "episodes")
        && json_field_is_array(&path.join("settings").join("characters.json"), "characters")
        && json_field_is_array(&path.join("settings").join("world.json"), "entries")
        && json_is_array(&path.join("chat.json"))
        && json_field_is_object(&path.join("summaries.json"), "summaries")
        && json_field_is_object(&path.join("memos.json"), "memos")
}

fn is_valid_legacy_genre_dir(path: &Path, dir_name: &str) -> bool {
    let Some(genre) = read_json_if_valid(&path.join("genre.json")) else {
        return false;
    };
    let Some(knowledge) = read_json_if_valid(&path.join("knowledge").join("current.json")) else {
        return false;
    };

    genre.get("schemaVersion").and_then(Value::as_i64) == Some(1)
        && genre.get("id").and_then(Value::as_str) == Some(dir_name)
        && has_string(&genre, "name")
        && has_array(&genre, "aliases")
        && has_string(&genre, "description")
        && has_string(&genre, "userDefinition")
        && has_string(&genre, "notes")
        && has_array(&genre, "tags")
        && has_string(&genre, "status")
        && genre.get("revision").and_then(Value::as_i64).is_some()
        && has_string(&genre, "createdAt")
        && has_string(&genre, "updatedAt")
        && schema_json_field_is_array(&path.join("sources").join("index.json"), "sources")
        && schema_json_field_is_array(&path.join("analyses").join("index.json"), "runs")
        && schema_json_field_is_array(&path.join("chats").join("index.json"), "threads")
        && knowledge.get("schemaVersion").and_then(Value::as_i64) == Some(1)
        && knowledge.get("genreId").and_then(Value::as_str) == Some(dir_name)
        && knowledge.get("revision").and_then(Value::as_i64).is_some()
        && has_array(&knowledge, "items")
        && has_array(&knowledge, "candidates")
        && has_string(&knowledge, "updatedAt")
}

fn migrate_valid_children(
    source_parent: &Path,
    target_parent: &Path,
    validator: fn(&Path, &str) -> bool,
) -> Result<(HashSet<String>, usize, usize), String> {
    let mut valid_ids = HashSet::new();
    let mut copied = 0;
    let mut skipped_invalid = 0;

    if !source_parent.exists() {
        return Ok((valid_ids, copied, skipped_invalid));
    }

    for entry in fs::read_dir(source_parent).map_err(|e| {
        format!(
            "Failed to read directory {}: {}",
            source_parent.display(),
            e
        )
    })? {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Failed to read file type: {}", e))?;
        if !file_type.is_dir() {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        let source_path = entry.path();
        if !validator(&source_path, &name) {
            skipped_invalid += 1;
            continue;
        }

        valid_ids.insert(name.clone());
        let target_path = target_parent.join(&name);
        if target_path.exists() {
            continue;
        }

        copy_dir_recursive(&source_path, &target_path)?;
        copied += 1;
    }

    Ok((valid_ids, copied, skipped_invalid))
}

fn copy_known_index_dirs(
    source_parent: &Path,
    target_parent: &Path,
    known_ids: &HashSet<String>,
) -> Result<usize, String> {
    if known_ids.is_empty() || !source_parent.exists() {
        return Ok(0);
    }

    let mut copied = 0;
    for id in known_ids {
        let source_path = source_parent.join(id);
        let target_path = target_parent.join(id);
        if !source_path.is_dir() || target_path.exists() {
            continue;
        }
        copy_dir_recursive(&source_path, &target_path)?;
        copied += 1;
    }

    Ok(copied)
}

#[tauri::command]
pub fn migrate_legacy_app_data() -> Result<Value, String> {
    // Do not rename or bulk-copy the legacy root by name alone. Only validated
    // legacy project and genre records are copied into the new namespace.
    let documents = documents_dir()?;
    let data = data_or_documents_dir()?;
    let legacy_documents = documents.join(LEGACY_APP_DATA_DIR);
    let current_documents = documents.join(APP_DATA_DIR);

    let (project_ids, projects_copied, invalid_projects_skipped) = migrate_valid_children(
        &legacy_documents.join("projects"),
        &current_documents.join("projects"),
        is_valid_legacy_project_dir,
    )?;
    let (genre_ids, genres_copied, invalid_genres_skipped) = migrate_valid_children(
        &legacy_documents.join("genres"),
        &current_documents.join("genres"),
        is_valid_legacy_genre_dir,
    )?;

    let mut project_indexes_copied = 0;
    let mut genre_indexes_copied = 0;
    let legacy_data = data.join(LEGACY_APP_DATA_DIR);
    let current_data = data.join(APP_DATA_DIR);
    if legacy_data.exists() {
        project_indexes_copied = copy_known_index_dirs(
            &legacy_data.join("index"),
            &current_data.join("index"),
            &project_ids,
        )?;
        genre_indexes_copied = copy_known_index_dirs(
            &legacy_data.join("genre-index"),
            &current_data.join("genre-index"),
            &genre_ids,
        )?;
    }

    Ok(json!({
        "projectsCopied": projects_copied,
        "genresCopied": genres_copied,
        "projectIndexesCopied": project_indexes_copied,
        "genreIndexesCopied": genre_indexes_copied,
        "invalidProjectsSkipped": invalid_projects_skipped,
        "invalidGenresSkipped": invalid_genres_skipped,
    }))
}

pub fn read_json(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    serde_json::from_str(&text).map_err(|e| format!("Failed to parse {}: {}", path.display(), e))
}

pub fn read_or_empty(path: &Path, empty: Value) -> Value {
    if path.exists() {
        read_json(path).unwrap_or(empty)
    } else {
        empty
    }
}

pub fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory {}: {}", parent.display(), e))?;
    }
    Ok(())
}

pub fn write_text(path: &Path, content: &str) -> Result<(), String> {
    ensure_parent_dir(path)?;
    fs::write(path, content).map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    crate::webdav_sync::enqueue_put_path(path, content.to_string());
    Ok(())
}

pub fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    write_text(path, &serde_json::to_string_pretty(value).unwrap())
}
