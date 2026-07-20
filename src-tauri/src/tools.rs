use crate::storage::{
    project_edit_log_path as edit_log_path, project_episodes_dir as episodes_dir,
    project_episodes_list_path as episode_list_path,
    project_summaries_path as summary_file_path, read_json, read_or_empty, write_json, write_text,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::borrow::Cow;
use std::fs;

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
    pub reason: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BatchEditItem {
    pub start_line: usize,
    pub end_line: usize,
    pub expected_text: String,
    pub replacement_text: String,
    pub reason: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EditLogEntry {
    pub id: String,
    pub episode_id: String,
    pub timestamp: String,
    pub start_line: usize,
    pub end_line: usize,
    pub before_text: String,
    pub after_text: String,
    pub reason: String,
}

const EDIT_LOG_MAX_ENTRIES: usize = 1000;

fn append_edit_log_entries(project_id: &str, new_entries: Vec<EditLogEntry>) -> Result<(), String> {
    if new_entries.is_empty() {
        return Ok(());
    }

    let path = edit_log_path(project_id)?;
    let mut document = read_or_empty(&path, json!({ "entries": [] }));

    let entries = document
        .get_mut("entries")
        .and_then(|v| v.as_array_mut());
    let entries = match entries {
        Some(entries) => entries,
        None => {
            document["entries"] = json!([]);
            document["entries"].as_array_mut().unwrap()
        }
    };

    for entry in new_entries {
        entries.push(serde_json::to_value(entry).map_err(|e| e.to_string())?);
    }

    if entries.len() > EDIT_LOG_MAX_ENTRIES {
        let overflow = entries.len() - EDIT_LOG_MAX_ENTRIES;
        entries.drain(0..overflow);
    }

    write_json(&path, &document)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchEditRequest {
    pub project_id: String,
    pub episode_id: String,
    pub edits: Vec<BatchEditItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchEditItemResult {
    pub index: usize,
    pub start_line: usize,
    pub end_line: usize,
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_text: Option<String>,
    pub replacement_line_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchEditResult {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_text: Option<String>,
    pub total_lines: usize,
    pub applied_edits: usize,
    pub edit_results: Vec<BatchEditItemResult>,
}

fn normalize_newlines(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

fn find_episode_file_name(
    episodes: &serde_json::Value,
    episode_id: &str,
) -> Result<String, String> {
    episodes["episodes"]
        .as_array()
        .ok_or_else(|| "Invalid episodes list".to_string())?
        .iter()
        .find(|ep| ep["id"].as_str() == Some(episode_id))
        .and_then(|ep| ep["fileName"].as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("Episode {} not found", episode_id))
}

fn find_episode_entry<'a>(
    episodes: &'a serde_json::Value,
    episode_id: &str,
) -> Result<&'a serde_json::Value, String> {
    episodes["episodes"]
        .as_array()
        .ok_or_else(|| "Invalid episodes list".to_string())?
        .iter()
        .find(|ep| ep["id"].as_str() == Some(episode_id))
        .ok_or_else(|| format!("Episode {} not found", episode_id))
}

fn read_episode_text_by_id(
    project_id: &str,
    episode_id: &str,
) -> Result<(String, String, i64, String), String> {
    let episodes_path = episode_list_path(project_id)?;
    let episodes = read_json(&episodes_path)?;
    let episode = find_episode_entry(&episodes, episode_id)?;
    let title = episode["title"].as_str().unwrap_or_default().to_string();
    let order = episode["order"].as_i64().unwrap_or(0);
    let file_name = episode["fileName"]
        .as_str()
        .ok_or_else(|| "Episode fileName missing".to_string())?
        .to_string();
    let file_path = episodes_dir(project_id)?.join(&file_name);
    let text = normalize_newlines(
        &fs::read_to_string(&file_path)
            .map_err(|e| format!("Failed to read episode {}: {}", file_name, e))?,
    );

    Ok((title, file_name, order, text))
}

fn line_numbered_text(lines: &[EpisodeLine]) -> String {
    lines
        .iter()
        .map(|line| format!("{}: {}", line.line_number, line.text))
        .collect::<Vec<_>>()
        .join("\n")
}

#[tauri::command]
pub fn edit_episode_text(req: EditRequest) -> Result<EditResult, String> {
    let episodes_path = episode_list_path(&req.project_id)?;
    let episodes = read_json(&episodes_path)?;
    let file_name = find_episode_file_name(&episodes, &req.episode_id)?;
    let file_path = episodes_dir(&req.project_id)?.join(&file_name);

    let current_text = normalize_newlines(
        &fs::read_to_string(&file_path)
            .map_err(|e| format!("Failed to read episode {}: {}", file_name, e))?,
    );
    let lines: Vec<&str> = current_text.split('\n').collect();

    let start = req.start_line.saturating_sub(1);
    let end = req.end_line;

    if req.start_line == 0
        || req.end_line < req.start_line
        || start >= lines.len()
        || end > lines.len()
    {
        return Ok(EditResult {
            success: false,
            message: "指定された行範囲が無効です。".to_string(),
            new_text: None,
            actual_text: None,
            total_lines: Some(lines.len()),
        });
    }

    let actual_text = lines[start..end].join("\n");
    let expected_text = normalize_newlines(&req.expected_text);
    if actual_text != expected_text {
        return Ok(EditResult {
            success: false,
            message: "指定した行範囲の内容が一致しませんでした。".to_string(),
            new_text: None,
            actual_text: Some(actual_text),
            total_lines: Some(lines.len()),
        });
    }

    let mut new_lines: Vec<String> = lines[..start].iter().map(|s| s.to_string()).collect();
    let replacement_text = normalize_newlines(&req.replacement_text);
    for line in replacement_text.split('\n') {
        new_lines.push(line.to_string());
    }
    new_lines.extend(lines[end..].iter().map(|s| s.to_string()));
    let new_text = new_lines.join("\n");

    write_text(&file_path, &new_text)
        .map_err(|e| format!("Failed to write episode {}: {}", file_name, e))?;

    append_edit_log_entries(
        &req.project_id,
        vec![EditLogEntry {
            id: uuid::Uuid::new_v4().to_string(),
            episode_id: req.episode_id.clone(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            start_line: req.start_line,
            end_line: req.end_line,
            before_text: expected_text,
            after_text: replacement_text,
            reason: req.reason.clone(),
        }],
    )?;

    Ok(EditResult {
        success: true,
        message: format!(
            "{}行目から{}行目を編集しました。",
            req.start_line, req.end_line
        ),
        new_text: Some(new_text),
        actual_text: None,
        total_lines: Some(lines.len()),
    })
}

#[tauri::command]
pub fn edit_episode_text_batch(req: BatchEditRequest) -> Result<BatchEditResult, String> {
    let episodes_path = episode_list_path(&req.project_id)?;
    let episodes = read_json(&episodes_path)?;
    let file_name = find_episode_file_name(&episodes, &req.episode_id)?;
    let file_path = episodes_dir(&req.project_id)?.join(&file_name);

    let current_text = normalize_newlines(
        &fs::read_to_string(&file_path)
            .map_err(|e| format!("Failed to read episode {}: {}", file_name, e))?,
    );
    let lines: Vec<&str> = current_text.split('\n').collect();
    let total_lines = lines.len();

    if req.edits.is_empty() {
        return Ok(BatchEditResult {
            success: false,
            message: "編集対象が指定されていません。".to_string(),
            new_text: None,
            total_lines,
            applied_edits: 0,
            edit_results: Vec::new(),
        });
    }

    let mut edit_results = Vec::new();
    let mut normalized_edits = Vec::new();

    for (index, edit) in req.edits.iter().enumerate() {
        let replacement_text = normalize_newlines(&edit.replacement_text);
        let replacement_line_count = replacement_text.split('\n').count();
        let start = edit.start_line.saturating_sub(1);
        let end = edit.end_line;

        if edit.start_line == 0
            || edit.end_line < edit.start_line
            || start >= total_lines
            || end > total_lines
        {
            edit_results.push(BatchEditItemResult {
                index,
                start_line: edit.start_line,
                end_line: edit.end_line,
                success: false,
                message: "指定された行範囲が無効です。".to_string(),
                actual_text: None,
                replacement_line_count,
            });
            continue;
        }

        let actual_text = lines[start..end].join("\n");
        let expected_text = normalize_newlines(&edit.expected_text);
        if actual_text != expected_text {
            edit_results.push(BatchEditItemResult {
                index,
                start_line: edit.start_line,
                end_line: edit.end_line,
                success: false,
                message: "指定した行範囲の内容が一致しませんでした。".to_string(),
                actual_text: Some(actual_text),
                replacement_line_count,
            });
            continue;
        }

        normalized_edits.push((
            index,
            edit.clone(),
            replacement_text,
            replacement_line_count,
        ));
    }

    let mut sorted_for_overlap = normalized_edits.clone();
    sorted_for_overlap.sort_by_key(|(_, edit, _, _)| edit.start_line);
    for pair in sorted_for_overlap.windows(2) {
        let (_, previous, _, _) = &pair[0];
        let (index, current, _, replacement_line_count) = &pair[1];
        if current.start_line <= previous.end_line {
            edit_results.push(BatchEditItemResult {
                index: *index,
                start_line: current.start_line,
                end_line: current.end_line,
                success: false,
                message: format!(
                    "編集範囲が重複しています: {}-{} と {}-{}",
                    previous.start_line, previous.end_line, current.start_line, current.end_line
                ),
                actual_text: None,
                replacement_line_count: *replacement_line_count,
            });
        }
    }

    if !edit_results.is_empty() {
        edit_results.sort_by_key(|result| result.index);
        return Ok(BatchEditResult {
            success: false,
            message: "一括編集は適用されませんでした。失敗した編集範囲を確認してください。"
                .to_string(),
            new_text: None,
            total_lines,
            applied_edits: 0,
            edit_results,
        });
    }

    let mut new_lines: Vec<String> = lines.iter().map(|line| (*line).to_string()).collect();
    normalized_edits.sort_by_key(|(_, edit, _, _)| std::cmp::Reverse(edit.start_line));

    let timestamp = chrono::Utc::now().to_rfc3339();
    let mut log_entries = Vec::new();

    for (index, edit, replacement_text, replacement_line_count) in normalized_edits {
        let start = edit.start_line - 1;
        let end = edit.end_line;
        let replacement_lines = replacement_text
            .split('\n')
            .map(|line| line.to_string())
            .collect::<Vec<_>>();
        new_lines.splice(start..end, replacement_lines.clone());
        edit_results.push(BatchEditItemResult {
            index,
            start_line: edit.start_line,
            end_line: edit.end_line,
            success: true,
            message: format!(
                "{}行目から{}行目を編集しました。",
                edit.start_line, edit.end_line
            ),
            actual_text: None,
            replacement_line_count,
        });
        log_entries.push(EditLogEntry {
            id: uuid::Uuid::new_v4().to_string(),
            episode_id: req.episode_id.clone(),
            timestamp: timestamp.clone(),
            start_line: edit.start_line,
            end_line: edit.end_line,
            before_text: normalize_newlines(&edit.expected_text),
            after_text: replacement_lines.join("\n"),
            reason: edit.reason.clone(),
        });
    }

    edit_results.sort_by_key(|result| result.index);
    let applied_edits = edit_results.len();
    let new_text = new_lines.join("\n");
    write_text(&file_path, &new_text)
        .map_err(|e| format!("Failed to write episode {}: {}", file_name, e))?;

    append_edit_log_entries(&req.project_id, log_entries)?;

    Ok(BatchEditResult {
        success: true,
        message: format!("{}件の編集を一括適用しました。", applied_edits),
        new_text: Some(new_text),
        total_lines,
        applied_edits,
        edit_results,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetEditLogRequest {
    pub project_id: String,
    pub episode_id: Option<String>,
    pub limit: Option<usize>,
}

#[tauri::command]
pub fn get_edit_log(req: GetEditLogRequest) -> Result<Vec<EditLogEntry>, String> {
    let path = edit_log_path(&req.project_id)?;
    let document = read_or_empty(&path, json!({ "entries": [] }));

    let mut entries: Vec<EditLogEntry> = document["entries"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| serde_json::from_value::<EditLogEntry>(v.clone()).ok())
                .collect()
        })
        .unwrap_or_default();

    if let Some(episode_id) = &req.episode_id {
        entries.retain(|entry| &entry.episode_id == episode_id);
    }

    entries.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

    let limit = req.limit.unwrap_or(20).clamp(1, 100);
    entries.truncate(limit);

    Ok(entries)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendEditLogRequest {
    pub project_id: String,
    pub entries: Vec<EditLogEntry>,
}

/// hashline 編集など、フロントエンドで適用した編集のログを追記する。
#[tauri::command]
pub fn append_edit_log(req: AppendEditLogRequest) -> Result<(), String> {
    append_edit_log_entries(&req.project_id, req.entries)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeLinesRequest {
    pub project_id: String,
    pub episode_id: String,
    pub start_line: Option<usize>,
    pub end_line: Option<usize>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeLine {
    pub line_number: usize,
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeLinesResult {
    pub episode_id: String,
    pub title: String,
    pub order: i64,
    pub total_lines: usize,
    pub start_line: usize,
    pub end_line: usize,
    pub lines: Vec<EpisodeLine>,
    pub line_numbered_text: String,
}

#[tauri::command]
pub fn get_episode_lines(req: EpisodeLinesRequest) -> Result<EpisodeLinesResult, String> {
    let (title, _file_name, order, text) =
        read_episode_text_by_id(&req.project_id, &req.episode_id)?;
    let raw_lines: Vec<&str> = text.split('\n').collect();
    let total_lines = raw_lines.len();
    let start_line = req.start_line.unwrap_or(1).max(1);
    let end_line = req.end_line.unwrap_or(total_lines).min(total_lines);

    if start_line > end_line || start_line > total_lines {
        return Err(format!(
            "Invalid line range: startLine={}, endLine={}, totalLines={}",
            start_line, end_line, total_lines
        ));
    }

    let lines = raw_lines[(start_line - 1)..end_line]
        .iter()
        .enumerate()
        .map(|(index, text)| EpisodeLine {
            line_number: start_line + index,
            text: (*text).to_string(),
        })
        .collect::<Vec<_>>();

    Ok(EpisodeLinesResult {
        episode_id: req.episode_id,
        title,
        order,
        total_lines,
        start_line,
        end_line,
        line_numbered_text: line_numbered_text(&lines),
        lines,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeLineSearchRequest {
    pub project_id: String,
    pub episode_id: String,
    pub query: String,
    pub context_lines: Option<usize>,
    pub max_matches: Option<usize>,
    pub case_sensitive: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeLineSearchMatch {
    pub start_line: usize,
    pub end_line: usize,
    pub expected_text: String,
    pub excerpt_start_line: usize,
    pub excerpt_end_line: usize,
    pub line_numbered_text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeLineSearchResult {
    pub episode_id: String,
    pub title: String,
    pub order: i64,
    pub total_lines: usize,
    pub query: String,
    pub matches: Vec<EpisodeLineSearchMatch>,
}

fn byte_offset_to_line(text: &str, byte_offset: usize) -> usize {
    let limit = byte_offset.min(text.len());
    text.as_bytes()[..limit]
        .iter()
        .filter(|b| **b == b'\n')
        .count()
        + 1
}

fn byte_span_end_to_line(text: &str, end_byte_offset: usize) -> usize {
    let limit = end_byte_offset.min(text.len());
    if limit == 0 {
        1
    } else {
        byte_offset_to_line(text, limit - 1)
    }
}

fn build_line_search_match(
    raw_lines: &[&str],
    start_line: usize,
    end_line: usize,
    context_lines: usize,
) -> EpisodeLineSearchMatch {
    let total_lines = raw_lines.len();
    let excerpt_start_line = start_line.saturating_sub(context_lines).max(1);
    let excerpt_end_line = (end_line + context_lines).min(total_lines);
    let excerpt_lines = raw_lines[(excerpt_start_line - 1)..excerpt_end_line]
        .iter()
        .enumerate()
        .map(|(index, text)| EpisodeLine {
            line_number: excerpt_start_line + index,
            text: (*text).to_string(),
        })
        .collect::<Vec<_>>();

    EpisodeLineSearchMatch {
        start_line,
        end_line,
        expected_text: raw_lines[(start_line - 1)..end_line].join("\n"),
        excerpt_start_line,
        excerpt_end_line,
        line_numbered_text: line_numbered_text(&excerpt_lines),
    }
}

fn find_line_search_matches(
    raw_lines: &[&str],
    text: &str,
    query: &str,
    case_sensitive: bool,
    context_lines: usize,
    max_matches: usize,
) -> Vec<EpisodeLineSearchMatch> {
    let (search_text, search_query): (Cow<'_, str>, Cow<'_, str>) = if case_sensitive {
        (Cow::Borrowed(text), Cow::Borrowed(query))
    } else {
        (
            Cow::Owned(text.to_lowercase()),
            Cow::Owned(query.to_lowercase()),
        )
    };

    let mut matches = Vec::new();
    for (byte_index, _) in search_text.match_indices(search_query.as_ref()) {
        let start_line = byte_offset_to_line(search_text.as_ref(), byte_index);
        let end_line = byte_span_end_to_line(search_text.as_ref(), byte_index + search_query.len());
        matches.push(build_line_search_match(
            raw_lines,
            start_line,
            end_line,
            context_lines,
        ));
        if matches.len() >= max_matches {
            break;
        }
    }
    matches
}

#[tauri::command]
pub fn find_episode_lines(
    req: EpisodeLineSearchRequest,
) -> Result<EpisodeLineSearchResult, String> {
    let raw_query = normalize_newlines(&req.query);
    let trimmed_query = raw_query.trim().to_string();
    if trimmed_query.is_empty() {
        return Err("query must not be empty".to_string());
    }

    let (title, _file_name, order, text) =
        read_episode_text_by_id(&req.project_id, &req.episode_id)?;
    let raw_lines: Vec<&str> = text.split('\n').collect();
    let total_lines = raw_lines.len();
    let context_lines = req.context_lines.unwrap_or(3).min(50);
    let max_matches = req.max_matches.unwrap_or(20).clamp(1, 200);
    let case_sensitive = req.case_sensitive.unwrap_or(true);

    let mut query = raw_query;
    let mut matches = find_line_search_matches(
        &raw_lines,
        &text,
        &query,
        case_sensitive,
        context_lines,
        max_matches,
    );

    if matches.is_empty() && query != trimmed_query {
        query = trimmed_query;
        matches = find_line_search_matches(
            &raw_lines,
            &text,
            &query,
            case_sensitive,
            context_lines,
            max_matches,
        );
    }

    Ok(EpisodeLineSearchResult {
        episode_id: req.episode_id,
        title,
        order,
        total_lines,
        query,
        matches,
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

    write_json(&path, &summaries).map_err(|e| format!("Failed to write summaries.json: {}", e))?;

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

    write_json(&path, &summaries).map_err(|e| format!("Failed to write summaries.json: {}", e))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::storage::project_dir;

    use super::*;
    use std::fs;

    fn test_project_id() -> String {
        format!("test-tools-{}", uuid::Uuid::new_v4())
    }

    fn cleanup(project_id: &str) {
        if let Ok(path) = project_dir(project_id) {
            let _ = fs::remove_dir_all(&path);
        }
    }

    #[test]
    fn edit_episode_writes_back_correctly() {
        let project_id = test_project_id();
        let base = project_dir(&project_id).unwrap();
        let episodes_dir_path = base.join("episodes");
        let _ = fs::create_dir_all(&episodes_dir_path);

        // episodes.json を手動で作成
        let episodes = json!({
            "episodes": [{
                "id": "ep-1",
                "title": "第一話",
                "order": 1,
                "fileName": "ep-1.txt"
            }]
        });
        fs::write(
            base.join("episodes.json"),
            serde_json::to_string_pretty(&episodes).unwrap(),
        )
        .unwrap();

        // 編集対象ファイルを用意
        fs::write(episodes_dir_path.join("ep-1.txt"), "旧テキスト\n次の行").unwrap();

        let result = edit_episode_text(EditRequest {
            project_id: project_id.clone(),
            episode_id: "ep-1".to_string(),
            start_line: 1,
            end_line: 1,
            expected_text: "旧テキスト".to_string(),
            replacement_text: "新テキスト".to_string(),
            reason: "テストのための書き換え".to_string(),
        });

        let result = result.unwrap();
        assert!(result.success, "edit should succeed: {:?}", result.message);
        let written = fs::read_to_string(episodes_dir_path.join("ep-1.txt")).unwrap();
        assert!(written.starts_with("新テキスト"));

        cleanup(&project_id);
    }

    #[test]
    fn edit_episode_records_edit_log_entry() {
        let project_id = test_project_id();
        let base = project_dir(&project_id).unwrap();
        let episodes_dir_path = base.join("episodes");
        let _ = fs::create_dir_all(&episodes_dir_path);

        let episodes = json!({
            "episodes": [{
                "id": "ep-1",
                "title": "第一話",
                "order": 1,
                "fileName": "ep-1.txt"
            }]
        });
        fs::write(
            base.join("episodes.json"),
            serde_json::to_string_pretty(&episodes).unwrap(),
        )
        .unwrap();
        fs::write(episodes_dir_path.join("ep-1.txt"), "旧テキスト\n次の行").unwrap();

        edit_episode_text(EditRequest {
            project_id: project_id.clone(),
            episode_id: "ep-1".to_string(),
            start_line: 1,
            end_line: 1,
            expected_text: "旧テキスト".to_string(),
            replacement_text: "新テキスト".to_string(),
            reason: "視点人物の一人称のブレを修正".to_string(),
        })
        .unwrap();

        let log = get_edit_log(GetEditLogRequest {
            project_id: project_id.clone(),
            episode_id: None,
            limit: None,
        })
        .unwrap();

        assert_eq!(log.len(), 1);
        assert_eq!(log[0].episode_id, "ep-1");
        assert_eq!(log[0].before_text, "旧テキスト");
        assert_eq!(log[0].after_text, "新テキスト");
        assert_eq!(log[0].reason, "視点人物の一人称のブレを修正");

        let filtered = get_edit_log(GetEditLogRequest {
            project_id: project_id.clone(),
            episode_id: Some("ep-2".to_string()),
            limit: None,
        })
        .unwrap();
        assert!(filtered.is_empty());

        cleanup(&project_id);
    }

    #[test]
    fn edit_episode_rejects_reversed_line_range() {
        let project_id = test_project_id();
        let base = project_dir(&project_id).unwrap();
        let episodes_dir_path = base.join("episodes");
        let _ = fs::create_dir_all(&episodes_dir_path);

        let episodes = json!({
            "episodes": [{
                "id": "ep-1",
                "title": "第一話",
                "order": 1,
                "fileName": "ep-1.txt"
            }]
        });
        fs::write(
            base.join("episodes.json"),
            serde_json::to_string_pretty(&episodes).unwrap(),
        )
        .unwrap();
        fs::write(episodes_dir_path.join("ep-1.txt"), "一行目\n二行目").unwrap();

        let result = edit_episode_text(EditRequest {
            project_id: project_id.clone(),
            episode_id: "ep-1".to_string(),
            start_line: 2,
            end_line: 1,
            expected_text: "".to_string(),
            replacement_text: "差し込み".to_string(),
            reason: "テストのための書き換え".to_string(),
        })
        .unwrap();

        assert!(!result.success, "reversed range should fail");
        let written = fs::read_to_string(episodes_dir_path.join("ep-1.txt")).unwrap();
        assert_eq!(written, "一行目\n二行目");

        cleanup(&project_id);
    }

    #[test]
    fn edit_episode_batch_applies_multiple_non_overlapping_ranges() {
        let project_id = test_project_id();
        let base = project_dir(&project_id).unwrap();
        let episodes_dir_path = base.join("episodes");
        let _ = fs::create_dir_all(&episodes_dir_path);

        let episodes = json!({
            "episodes": [{
                "id": "ep-1",
                "title": "第一話",
                "order": 1,
                "fileName": "ep-1.txt"
            }]
        });
        fs::write(
            base.join("episodes.json"),
            serde_json::to_string_pretty(&episodes).unwrap(),
        )
        .unwrap();
        fs::write(
            episodes_dir_path.join("ep-1.txt"),
            "一行目\n二行目\n三行目\n四行目\n五行目",
        )
        .unwrap();

        let result = edit_episode_text_batch(BatchEditRequest {
            project_id: project_id.clone(),
            episode_id: "ep-1".to_string(),
            edits: vec![
                BatchEditItem {
                    start_line: 2,
                    end_line: 2,
                    expected_text: "二行目".to_string(),
                    replacement_text: "二行目A\n二行目B".to_string(),
                    reason: "二行目を分割".to_string(),
                },
                BatchEditItem {
                    start_line: 5,
                    end_line: 5,
                    expected_text: "五行目".to_string(),
                    replacement_text: "五行目改".to_string(),
                    reason: "五行目を修正".to_string(),
                },
            ],
        })
        .unwrap();

        assert!(
            result.success,
            "batch edit should succeed: {:?}",
            result.message
        );
        assert_eq!(result.applied_edits, 2);
        let written = fs::read_to_string(episodes_dir_path.join("ep-1.txt")).unwrap();
        assert_eq!(
            written,
            "一行目\n二行目A\n二行目B\n三行目\n四行目\n五行目改"
        );

        let log = get_edit_log(GetEditLogRequest {
            project_id: project_id.clone(),
            episode_id: Some("ep-1".to_string()),
            limit: None,
        })
        .unwrap();
        assert_eq!(log.len(), 2);
        assert!(log.iter().any(|e| e.reason == "二行目を分割"));
        assert!(log.iter().any(|e| e.reason == "五行目を修正"));

        cleanup(&project_id);
    }

    #[test]
    fn edit_episode_batch_rejects_without_partial_write() {
        let project_id = test_project_id();
        let base = project_dir(&project_id).unwrap();
        let episodes_dir_path = base.join("episodes");
        let _ = fs::create_dir_all(&episodes_dir_path);

        let episodes = json!({
            "episodes": [{
                "id": "ep-1",
                "title": "第一話",
                "order": 1,
                "fileName": "ep-1.txt"
            }]
        });
        fs::write(
            base.join("episodes.json"),
            serde_json::to_string_pretty(&episodes).unwrap(),
        )
        .unwrap();
        fs::write(episodes_dir_path.join("ep-1.txt"), "一行目\n二行目\n三行目").unwrap();

        let result = edit_episode_text_batch(BatchEditRequest {
            project_id: project_id.clone(),
            episode_id: "ep-1".to_string(),
            edits: vec![
                BatchEditItem {
                    start_line: 1,
                    end_line: 1,
                    expected_text: "一行目".to_string(),
                    replacement_text: "一行目改".to_string(),
                    reason: "一行目を修正".to_string(),
                },
                BatchEditItem {
                    start_line: 3,
                    end_line: 3,
                    expected_text: "違う三行目".to_string(),
                    replacement_text: "三行目改".to_string(),
                    reason: "三行目を修正".to_string(),
                },
            ],
        })
        .unwrap();

        assert!(!result.success, "batch edit should reject mismatched text");
        assert_eq!(result.applied_edits, 0);
        assert_eq!(result.edit_results.len(), 1);
        assert_eq!(
            result.edit_results[0].actual_text.as_deref(),
            Some("三行目")
        );
        let written = fs::read_to_string(episodes_dir_path.join("ep-1.txt")).unwrap();
        assert_eq!(written, "一行目\n二行目\n三行目");

        cleanup(&project_id);
    }

    #[test]
    fn edit_episode_accepts_line_tool_text_from_crlf_file() {
        let project_id = test_project_id();
        let base = project_dir(&project_id).unwrap();
        let episodes_dir_path = base.join("episodes");
        let _ = fs::create_dir_all(&episodes_dir_path);

        let episodes = json!({
            "episodes": [{
                "id": "ep-1",
                "title": "第一話",
                "order": 1,
                "fileName": "ep-1.txt"
            }]
        });
        fs::write(
            base.join("episodes.json"),
            serde_json::to_string_pretty(&episodes).unwrap(),
        )
        .unwrap();
        fs::write(
            episodes_dir_path.join("ep-1.txt"),
            "一行目\r\n二行目\r\n三行目",
        )
        .unwrap();

        let found = find_episode_lines(EpisodeLineSearchRequest {
            project_id: project_id.clone(),
            episode_id: "ep-1".to_string(),
            query: "二行目".to_string(),
            context_lines: Some(0),
            max_matches: Some(1),
            case_sensitive: Some(true),
        })
        .unwrap();
        assert_eq!(found.matches[0].expected_text, "二行目");

        let result = edit_episode_text(EditRequest {
            project_id: project_id.clone(),
            episode_id: "ep-1".to_string(),
            start_line: found.matches[0].start_line,
            end_line: found.matches[0].end_line,
            expected_text: found.matches[0].expected_text.clone(),
            replacement_text: "差し替え".to_string(),
            reason: "テストのための書き換え".to_string(),
        })
        .unwrap();

        assert!(
            result.success,
            "edit should accept text returned by line search"
        );
        let written = fs::read_to_string(episodes_dir_path.join("ep-1.txt")).unwrap();
        assert_eq!(written, "一行目\n差し替え\n三行目");

        cleanup(&project_id);
    }

    #[test]
    fn episode_line_tools_return_line_numbers_and_expected_text() {
        let project_id = test_project_id();
        let base = project_dir(&project_id).unwrap();
        let episodes_dir_path = base.join("episodes");
        let _ = fs::create_dir_all(&episodes_dir_path);

        let episodes = json!({
            "episodes": [{
                "id": "ep-1",
                "title": "第一話",
                "order": 1,
                "fileName": "ep-1.txt"
            }]
        });
        fs::write(
            base.join("episodes.json"),
            serde_json::to_string_pretty(&episodes).unwrap(),
        )
        .unwrap();
        fs::write(
            episodes_dir_path.join("ep-1.txt"),
            "一行目\n違う……\n三行目\n違う……二回目",
        )
        .unwrap();

        let lines = get_episode_lines(EpisodeLinesRequest {
            project_id: project_id.clone(),
            episode_id: "ep-1".to_string(),
            start_line: Some(2),
            end_line: Some(3),
        })
        .unwrap();
        assert_eq!(lines.total_lines, 4);
        assert_eq!(lines.line_numbered_text, "2: 違う……\n3: 三行目");

        let found = find_episode_lines(EpisodeLineSearchRequest {
            project_id: project_id.clone(),
            episode_id: "ep-1".to_string(),
            query: "違う……".to_string(),
            context_lines: Some(1),
            max_matches: Some(10),
            case_sensitive: Some(true),
        })
        .unwrap();
        assert_eq!(found.matches.len(), 2);
        assert_eq!(found.matches[0].start_line, 2);
        assert_eq!(found.matches[0].expected_text, "違う……");
        assert!(found.matches[0].line_numbered_text.contains("1: 一行目"));
        assert!(found.matches[0].line_numbered_text.contains("3: 三行目"));

        cleanup(&project_id);
    }

    #[test]
    fn episode_line_search_finds_multiline_case_insensitive_text() {
        let project_id = test_project_id();
        let base = project_dir(&project_id).unwrap();
        let episodes_dir_path = base.join("episodes");
        let _ = fs::create_dir_all(&episodes_dir_path);

        let episodes = json!({
            "episodes": [{
                "id": "ep-1",
                "title": "第一話",
                "order": 1,
                "fileName": "ep-1.txt"
            }]
        });
        fs::write(
            base.join("episodes.json"),
            serde_json::to_string_pretty(&episodes).unwrap(),
        )
        .unwrap();
        fs::write(episodes_dir_path.join("ep-1.txt"), "Alpha\nBeta\nGamma").unwrap();

        let found = find_episode_lines(EpisodeLineSearchRequest {
            project_id: project_id.clone(),
            episode_id: "ep-1".to_string(),
            query: "\nalpha\nbeta\n".to_string(),
            context_lines: Some(0),
            max_matches: Some(1),
            case_sensitive: Some(false),
        })
        .unwrap();

        assert_eq!(found.query, "alpha\nbeta");
        assert_eq!(found.matches.len(), 1);
        assert_eq!(found.matches[0].start_line, 1);
        assert_eq!(found.matches[0].end_line, 2);
        assert_eq!(found.matches[0].expected_text, "Alpha\nBeta");

        cleanup(&project_id);
    }

    #[test]
    fn save_summary_creates_project_dir() {
        let project_id = test_project_id();

        save_episode_summary(SaveSummaryRequest {
            project_id: project_id.clone(),
            episode_id: "ep-1".to_string(),
            content: "要約本文".to_string(),
        })
        .expect("save_episode_summary should create project dir");

        let path = summary_file_path(&project_id).unwrap();
        assert!(path.exists());
        let summaries = read_json(&path).unwrap();
        assert_eq!(
            summaries["summaries"]["ep-1"]["content"].as_str().unwrap(),
            "要約本文"
        );

        cleanup(&project_id);
    }

    #[test]
    fn save_one_liner_creates_project_dir() {
        let project_id = test_project_id();

        save_episode_one_liner(SaveOneLinerRequest {
            project_id: project_id.clone(),
            episode_id: "ep-1".to_string(),
            one_liner: "一行要約".to_string(),
        })
        .expect("save_episode_one_liner should create project dir");

        let path = summary_file_path(&project_id).unwrap();
        assert!(path.exists());
        let summaries = read_json(&path).unwrap();
        assert_eq!(
            summaries["summaries"]["ep-1"]["oneLiner"].as_str().unwrap(),
            "一行要約"
        );

        cleanup(&project_id);
    }
}
