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
    let mut list = load_list(project_id)?;
    let mut new_episodes = Vec::with_capacity(list.episodes.len());
    for (new_order, id) in ordered_ids.iter().enumerate() {
        if let Some(mut ep) = list.episodes.iter().find(|e| &e.id == id).cloned() {
            ep.order = new_order;
            new_episodes.push(ep);
        }
    }
    for ep in list.episodes.drain(..) {
        if !ordered_ids.contains(&ep.id) {
            new_episodes.push(ep);
        }
    }
    list.episodes = new_episodes;
    save_list(project_id, &list)
}

/// 単一エピソードを `target_index` の位置へ移動する。
/// 旧TS `moveEpisodeToIndex` の移植。
pub fn move_to_index(project_id: &str, episode_id: &str, target_index: usize) -> Result<(), String> {
    let mut list = load_list(project_id)?;
    let pos = list
        .episodes
        .iter()
        .position(|e| e.id == episode_id)
        .ok_or_else(|| format!("Episode not found: {episode_id}"))?;
    let item = list.episodes.remove(pos);
    let target = target_index.min(list.episodes.len());
    list.episodes.insert(target, item);
    for (i, ep) in list.episodes.iter_mut().enumerate() {
        ep.order = i;
    }
    save_list(project_id, &list)
}

/// 単一エピソードを1つ上へ移動する。
/// 旧TS `moveEpisode` の移植。
pub fn move_up(project_id: &str, episode_id: &str) -> Result<(), String> {
    let list = load_list(project_id)?;
    let pos = list
        .episodes
        .iter()
        .position(|e| e.id == episode_id)
        .ok_or_else(|| format!("Episode not found: {episode_id}"))?;
    if pos == 0 {
        return Ok(());
    }
    move_to_index(project_id, episode_id, pos - 1)
}

pub fn move_down(project_id: &str, episode_id: &str) -> Result<(), String> {
    let list = load_list(project_id)?;
    let pos = list
        .episodes
        .iter()
        .position(|e| e.id == episode_id)
        .ok_or_else(|| format!("Episode not found: {episode_id}"))?;
    if pos + 1 >= list.episodes.len() {
        return Ok(());
    }
    move_to_index(project_id, episode_id, pos + 1)
}

/// 旧「単一manuscript」形式から分割してエピソード化する。
/// 旧TS `migrateFromManuscript` の移植。
/// `documents_dir()/litra/projects/{project_id}/manuscript.md` を読み込み、
/// 見出し（`# ` または `## `）で分割してエピソードにする。
pub fn migrate_from_manuscript(project_id: &str) -> Result<usize, String> {
    validate_id(project_id, "project ID")?;
    let manuscript_path = crate::storage::project_dir(project_id)?.join("manuscript.md");
    if !manuscript_path.exists() {
        return Ok(0);
    }
    let content = std::fs::read_to_string(&manuscript_path)
        .map_err(|e| format!("Failed to read manuscript: {e}"))?;
    let sections = split_manuscript(&content);
    if sections.is_empty() {
        return Ok(0);
    }
    let mut list = load_list(project_id)?;
    let next_order = list.episodes.len();
    for (i, (title, body)) in sections.into_iter().enumerate() {
        let id = uuid::Uuid::new_v4().to_string();
        let safe_title: String = title
            .chars()
            .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | ' ' | '　'))
            .take(60)
            .collect();
        let file_name = format!("{}.md", if safe_title.is_empty() {
            id.clone()
        } else {
            safe_title.replace(' ', "_")
        });
        let episode = Episode {
            id: id.clone(),
            title: title.clone(),
            order: next_order + i,
            file_name: file_name.clone(),
        };
        let path = project_episodes_dir(project_id)?.join(&file_name);
        crate::storage::ensure_parent_dir(&path)?;
        std::fs::write(&path, body)
            .map_err(|e| format!("Failed to write episode: {e}"))?;
        list.episodes.push(episode);
    }
    save_list(project_id, &list)?;
    // 移行成功後は旧manuscriptをバックアップとして残す
    let backup = crate::storage::project_dir(project_id)?.join("manuscript.migrated.md");
    let _ = std::fs::rename(&manuscript_path, &backup);
    Ok(list.episodes.len())
}

/// 単一原稿を `# ` または `## ` で見出し分割する。
/// 旧TS `migrateFromManuscript` の分割ロジック。
fn split_manuscript(content: &str) -> Vec<(String, String)> {
    let mut sections: Vec<(String, String)> = Vec::new();
    let mut current_title: Option<String> = None;
    let mut current_body = String::new();
    for line in content.lines() {
        if let Some(stripped) = line.strip_prefix("# ") {
            if let Some(prev_title) = current_title.take() {
                sections.push((prev_title, std::mem::take(&mut current_body)));
            }
            current_title = Some(stripped.trim().to_string());
        } else if let Some(stripped) = line.strip_prefix("## ") {
            if let Some(prev_title) = current_title.take() {
                sections.push((prev_title, std::mem::take(&mut current_body)));
            }
            current_title = Some(stripped.trim().to_string());
        } else {
            current_body.push_str(line);
            current_body.push('\n');
        }
    }
    if let Some(title) = current_title {
        sections.push((title, current_body));
    } else if !current_body.trim().is_empty() {
        sections.push(("無題".to_string(), current_body));
    }
    sections
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
