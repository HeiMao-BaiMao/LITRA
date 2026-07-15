use std::fs;

use crate::storage::{project_episodes_dir, project_episodes_list_path, write_json, write_text};

use super::{
    types::{Episode, EpisodeList},
    validate_id,
};

fn load_list(project_id: &str) -> Result<EpisodeList, String> {
    validate_id(project_id, "project ID")?;
    let path = project_episodes_list_path(project_id)?;
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|error| format!("Invalid {}: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(EpisodeList::default()),
        Err(error) => Err(format!("Failed to read {}: {error}", path.display())),
    }
}

fn save_list(project_id: &str, list: &EpisodeList) -> Result<(), String> {
    let value = serde_json::to_value(list).map_err(|error| error.to_string())?;
    write_json(&project_episodes_list_path(project_id)?, &value)
}

fn episode_path(project_id: &str, file_name: &str) -> Result<std::path::PathBuf, String> {
    validate_id(project_id, "project ID")?;
    validate_id(file_name, "episode filename")?;
    if !file_name.ends_with(".md") {
        return Err("Episode filename must end with .md".into());
    }
    Ok(project_episodes_dir(project_id)?.join(file_name))
}

pub fn list(project_id: &str) -> Result<Vec<Episode>, String> {
    let mut list = load_list(project_id)?.episodes;
    list.sort_by_key(|episode| episode.order);
    Ok(list)
}

pub fn create(project_id: &str, title: String) -> Result<Episode, String> {
    let mut list = load_list(project_id)?;
    let id = uuid::Uuid::new_v4().to_string();
    let file_name = format!("{id}.md");
    let episode = Episode {
        id,
        title,
        order: list.episodes.len(),
        file_name: file_name.clone(),
    };
    write_text(&episode_path(project_id, &file_name)?, "")?;
    list.episodes.push(episode.clone());
    save_list(project_id, &list)?;
    Ok(episode)
}

pub fn read(project_id: &str, file_name: &str) -> Result<String, String> {
    let path = episode_path(project_id, file_name)?;
    match fs::read_to_string(&path) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(format!("Failed to read {}: {error}", path.display())),
    }
}
pub fn write(project_id: &str, file_name: &str, content: &str) -> Result<(), String> {
    write_text(&episode_path(project_id, file_name)?, content)
}

pub fn update_title(project_id: &str, episode_id: &str, title: String) -> Result<(), String> {
    validate_id(episode_id, "episode ID")?;
    let mut list = load_list(project_id)?;
    let episode = list
        .episodes
        .iter_mut()
        .find(|episode| episode.id == episode_id)
        .ok_or_else(|| "Episode not found".to_string())?;
    episode.title = title;
    save_list(project_id, &list)
}

pub fn remove(project_id: &str, episode_id: &str) -> Result<(), String> {
    validate_id(episode_id, "episode ID")?;
    let mut list = load_list(project_id)?;
    let Some(index) = list
        .episodes
        .iter()
        .position(|episode| episode.id == episode_id)
    else {
        return Ok(());
    };
    let episode = list.episodes.remove(index);
    crate::webdav_sync::remove_document_path(
        format!("litra/projects/{project_id}/episodes/{}", episode.file_name),
        Some(false),
    )?;
    for (order, episode) in list.episodes.iter_mut().enumerate() {
        episode.order = order;
    }
    save_list(project_id, &list)
}

pub fn reorder(project_id: &str, ordered_ids: Vec<String>) -> Result<(), String> {
    let list = load_list(project_id)?;
    if ordered_ids.len() != list.episodes.len() {
        return Err("Episode reorder list length mismatch".into());
    }
    let mut reordered = Vec::with_capacity(list.episodes.len());
    for id in ordered_ids {
        validate_id(&id, "episode ID")?;
        let mut episode = list
            .episodes
            .iter()
            .find(|episode| episode.id == id)
            .cloned()
            .ok_or_else(|| format!("Episode not found: {id}"))?;
        if reordered.iter().any(|existing: &Episode| existing.id == id) {
            return Err(format!("Duplicate episode ID: {id}"));
        }
        episode.order = reordered.len();
        reordered.push(episode);
    }
    save_list(
        project_id,
        &EpisodeList {
            episodes: reordered,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::episode_path;
    #[test]
    fn rejects_unsafe_episode_paths() {
        assert!(episode_path("../bad", "episode.md").is_err());
        assert!(episode_path("project", "../episode.md").is_err());
        assert!(episode_path("project", r"nested\episode.md").is_err());
        assert!(episode_path("project", "episode.txt").is_err());
    }
}
