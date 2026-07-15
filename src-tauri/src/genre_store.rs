use std::fs;

use serde::Serialize;

use crate::storage::{genre_dir, write_text};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenrePathEntry {
    name: String,
    is_directory: bool,
}

fn validate_segment(value: &str, label: &str) -> Result<(), String> {
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

fn resolve_path(genre_id: &str, relative_path: &str) -> Result<std::path::PathBuf, String> {
    validate_segment(genre_id, "genre ID")?;
    if relative_path.is_empty() || relative_path.contains('\\') {
        return Err("Invalid empty or backslash genre path".to_owned());
    }
    let mut path = genre_dir(genre_id)?;
    for segment in relative_path.split('/') {
        validate_segment(segment, "genre path segment")?;
        path.push(segment);
    }
    Ok(path)
}

#[tauri::command]
pub fn genre_read_text(genre_id: String, relative_path: String) -> Result<Option<String>, String> {
    let path = resolve_path(&genre_id, &relative_path)?;
    match fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Failed to read {}: {error}", path.display())),
    }
}

#[tauri::command]
pub fn genre_write_text(
    genre_id: String,
    relative_path: String,
    content: String,
) -> Result<(), String> {
    write_text(&resolve_path(&genre_id, &relative_path)?, &content)
}

#[tauri::command]
pub fn genre_list_path(
    genre_id: String,
    relative_path: String,
) -> Result<Vec<GenrePathEntry>, String> {
    let path = resolve_path(&genre_id, &relative_path)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(&path)
        .map_err(|error| format!("Failed to list {}: {error}", path.display()))?
    {
        let entry = entry.map_err(|error| format!("Failed to read genre entry: {error}"))?;
        entries.push(GenrePathEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            is_directory: entry
                .file_type()
                .map_err(|error| format!("Failed to inspect genre entry: {error}"))?
                .is_dir(),
        });
    }
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(entries)
}

#[tauri::command]
pub fn genre_remove_path(
    genre_id: String,
    relative_path: String,
    recursive: Option<bool>,
) -> Result<(), String> {
    resolve_path(&genre_id, &relative_path)?;
    crate::webdav_sync::remove_document_path(
        format!("litra/genres/{genre_id}/{relative_path}"),
        recursive,
    )
}

#[cfg(test)]
mod tests {
    use super::resolve_path;

    #[test]
    fn rejects_genre_path_traversal() {
        assert!(resolve_path("../project", "genre.json").is_err());
        assert!(resolve_path("genre", "../project.json").is_err());
        assert!(resolve_path("genre", r"sources\secret.json").is_err());
        assert!(resolve_path("genre", "sources//index.json").is_err());
    }
}
