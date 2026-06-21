use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditResult {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_lines: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditRequest {
    pub project_id: String,
    pub episode_id: String,
    pub start_line: usize,
    pub end_line: usize,
    pub expected_text: String,
    pub replacement_text: String,
}

fn documents_dir() -> Result<PathBuf, String> {
    dirs::document_dir().ok_or_else(|| "Documents directory not found".to_string())
}

fn project_dir(project_id: &str) -> Result<PathBuf, String> {
    Ok(documents_dir()?.join("phenex/projects").join(project_id))
}

fn episodes_dir(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(project_id)?.join("episodes"))
}

fn episode_list_path(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(project_id)?.join("episodes.json"))
}

fn summary_file_path(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(project_id)?.join("summaries.json"))
}

fn read_json(path: &PathBuf) -> Result<serde_json::Value, String> {
    let text = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse {}: {}", path.display(), e))
}

fn find_episode_file_name(episodes: &serde_json::Value, episode_id: &str) -> Result<String, String> {
    episodes["episodes"]
        .as_array()
        .ok_or_else(|| "Invalid episodes list".to_string())?
        .iter()
        .find(|ep| ep["id"].as_str() == Some(episode_id))
        .and_then(|ep| ep["fileName"].as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("Episode {} not found", episode_id))
}

#[tauri::command]
pub fn edit_episode_text(req: EditRequest) -> Result<EditResult, String> {
    let episodes_path = episode_list_path(&req.project_id)?;
    let episodes = read_json(&episodes_path)?;
    let file_name = find_episode_file_name(&episodes, &req.episode_id)?;
    let file_path = episodes_dir(&req.project_id)?.join(&file_name);

    let current_text = fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read episode {}: {}", file_name, e))?
        .replace("\r\n", "\n");
    let lines: Vec<&str> = current_text.split('\n').collect();

    let start = req.start_line.saturating_sub(1);
    let end = req.end_line;

    if start >= lines.len() || end > lines.len() || end < start {
        return Ok(EditResult {
            success: false,
            message: "指定された行範囲が無効です。".to_string(),
            new_text: None,
            actual_text: None,
            total_lines: Some(lines.len()),
        });
    }

    let actual_text = lines[start..end].join("\n");
    if actual_text != req.expected_text {
        return Ok(EditResult {
            success: false,
            message: "指定した行範囲の内容が一致しませんでした。".to_string(),
            new_text: None,
            actual_text: Some(actual_text),
            total_lines: Some(lines.len()),
        });
    }

    let mut new_lines: Vec<String> = lines[..start].iter().map(|s| s.to_string()).collect();
    for line in req.replacement_text.split('\n') {
        new_lines.push(line.to_string());
    }
    new_lines.extend(lines[end..].iter().map(|s| s.to_string()));
    let new_text = new_lines.join("\n");

    fs::write(&file_path, &new_text)
        .map_err(|e| format!("Failed to write episode {}: {}", file_name, e))?;

    Ok(EditResult {
        success: true,
        message: format!("{}行目から{}行目を編集しました。", req.start_line, req.end_line),
        new_text: Some(new_text),
        actual_text: None,
        total_lines: Some(lines.len()),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeListItem {
    pub episode_id: String,
    pub order: i64,
    pub title: String,
    pub one_line_summary: String,
}

#[tauri::command]
pub fn list_episodes_with_summaries(project_id: String) -> Result<Vec<EpisodeListItem>, String> {
    let episodes_path = episode_list_path(&project_id)?;
    let episodes = read_json(&episodes_path)?;

    let summaries_path = summary_file_path(&project_id)?;
    let summaries = if summaries_path.exists() {
        read_json(&summaries_path).unwrap_or_else(|_| json!({ "summaries": {} }))
    } else {
        json!({ "summaries": {} })
    };

    let mut items = Vec::new();
    if let Some(arr) = episodes["episodes"].as_array() {
        for ep in arr {
            let id = ep["id"].as_str().unwrap_or_default().to_string();
            let title = ep["title"].as_str().unwrap_or_default().to_string();
            let order = ep["order"].as_i64().unwrap_or(0);
            let summary_entry = &summaries["summaries"][&id];
            let one_line = summary_entry["oneLiner"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(|s| s.chars().take(120).collect())
                .or_else(|| {
                    summary_entry["content"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .map(|s| s.lines().next().unwrap_or(s).chars().take(120).collect())
                })
                .unwrap_or_else(|| "（要約未登録）".to_string());
            items.push(EpisodeListItem {
                episode_id: id,
                order,
                title,
                one_line_summary: one_line,
            });
        }
    }

    items.sort_by_key(|item| item.order);
    Ok(items)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeContent {
    pub episode_id: String,
    pub title: String,
    pub order: i64,
    pub content_type: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrieveRequest {
    pub project_id: String,
    pub episode_id: String,
    pub content_type: String,
}

#[tauri::command]
pub fn retrieve_episode_content(req: RetrieveRequest) -> Result<EpisodeContent, String> {
    let episodes_path = episode_list_path(&req.project_id)?;
    let episodes = read_json(&episodes_path)?;

    let episode = episodes["episodes"]
        .as_array()
        .ok_or_else(|| "Invalid episodes list".to_string())?
        .iter()
        .find(|ep| ep["id"].as_str() == Some(&req.episode_id))
        .ok_or_else(|| format!("Episode {} not found", req.episode_id))?;

    let title = episode["title"].as_str().unwrap_or_default().to_string();
    let order = episode["order"].as_i64().unwrap_or(0);

    let content = match req.content_type.as_str() {
        "summary" => {
            let summaries_path = summary_file_path(&req.project_id)?;
            if summaries_path.exists() {
                let summaries = read_json(&summaries_path)?;
                summaries["summaries"][&req.episode_id]["content"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string()
            } else {
                String::new()
            }
        }
        "fullText" => {
            let file_name = episode["fileName"]
                .as_str()
                .ok_or_else(|| "Episode fileName missing".to_string())?;
            let file_path = episodes_dir(&req.project_id)?.join(file_name);
            fs::read_to_string(&file_path)
                .map_err(|e| format!("Failed to read episode {}: {}", file_name, e))?
        }
        _ => return Err(format!("Unknown content type: {}", req.content_type)),
    };

    Ok(EpisodeContent {
        episode_id: req.episode_id,
        title,
        order,
        content_type: req.content_type,
        content,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSummaryRequest {
    pub project_id: String,
    pub episode_id: String,
    pub content: String,
}

#[tauri::command]
pub fn save_episode_summary(req: SaveSummaryRequest) -> Result<(), String> {
    let path = summary_file_path(&req.project_id)?;
    let mut summaries = if path.exists() {
        read_json(&path).unwrap_or_else(|_| json!({ "summaries": {} }))
    } else {
        json!({ "summaries": {} })
    };

    let existing_one_liner = summaries["summaries"][&req.episode_id]["oneLiner"]
        .as_str()
        .unwrap_or_default()
        .to_string();

    summaries["summaries"][&req.episode_id] = json!({
        "content": req.content,
        "oneLiner": existing_one_liner,
        "updatedAt": chrono::Utc::now().to_rfc3339(),
    });

    fs::write(&path, serde_json::to_string_pretty(&summaries).unwrap())
        .map_err(|e| format!("Failed to write summaries.json: {}", e))?;

    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOneLinerRequest {
    pub project_id: String,
    pub episode_id: String,
    pub one_liner: String,
}

#[tauri::command]
pub fn save_episode_one_liner(req: SaveOneLinerRequest) -> Result<(), String> {
    let path = summary_file_path(&req.project_id)?;
    let mut summaries = if path.exists() {
        read_json(&path).unwrap_or_else(|_| json!({ "summaries": {} }))
    } else {
        json!({ "summaries": {} })
    };

    let existing_content = summaries["summaries"][&req.episode_id]["content"]
        .as_str()
        .unwrap_or_default()
        .to_string();

    summaries["summaries"][&req.episode_id] = json!({
        "content": existing_content,
        "oneLiner": req.one_liner,
        "updatedAt": chrono::Utc::now().to_rfc3339(),
    });

    fs::write(&path, serde_json::to_string_pretty(&summaries).unwrap())
        .map_err(|e| format!("Failed to write summaries.json: {}", e))?;

    Ok(())
}
