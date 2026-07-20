use serde::{Deserialize, Serialize};
use wasm_bindgen::JsValue;

use crate::{data::genre_store, runtime::tauri};

/// Attachment metadata stored on a chat message.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub attachment_type: String,
    pub size: usize,
}

/// Detect whether text looks like novel/fiction content.
///
/// Criteria (matching legacy TS `detectNovelText`):
/// - trimmed length > 1200 chars
/// - line count >= 8 OR paragraph count >= 4
/// - contains dialogue markers (「『"') or fiction structural markers
pub fn detect_novel_text(content: &str) -> bool {
    let trimmed = content.trim();
    if trimmed.chars().count() <= 1200 {
        return false;
    }

    let line_count = trimmed.lines().count();
    let paragraph_count = trimmed.split("\n\n").count();
    let has_dialogue = trimmed.contains('「')
        || trimmed.contains('『')
        || trimmed.contains('\u{201C}') // "
        || trimmed.contains('\u{2018}'); // '
    let has_fiction_markers = [
        "章", "話", "幕", "場面", "登場人物", "あらすじ", "プロローグ", "エピローグ",
    ]
    .iter()
    .any(|marker| trimmed.contains(marker));

    (line_count >= 8 || paragraph_count >= 4) && (has_dialogue || has_fiction_markers)
}

/// Detect whether text is long enough to be worth attaching (>2000 chars).
pub fn detect_long_text(content: &str) -> bool {
    content.chars().count() > 2000
}

/// Extract a preview of the text (first 500 chars).
pub fn extract_preview(content: &str, max_chars: usize) -> String {
    let trimmed = content.trim();
    let char_count = trimmed.chars().count();
    if char_count <= max_chars {
        return trimmed.to_string();
    }
    let truncated: String = trimmed.chars().take(max_chars).collect();
    format!("{truncated}…（後略）")
}

/// Save a chat attachment to `chats/attachments/{thread_id}/{message_id}/{attachment_id}.md`.
///
/// Returns the attachment metadata.
pub async fn save(
    genre_id: &str,
    thread_id: &str,
    message_id: &str,
    name: &str,
    attachment_type: &str,
    content: &str,
) -> Result<Attachment, JsValue> {
    let attachment_id = tauri::random_uuid();
    let relative_path = format!(
        "chats/attachments/{thread_id}/{message_id}/{attachment_id}.md"
    );
    genre_store::write_text(genre_id, &relative_path, content).await?;

    Ok(Attachment {
        id: attachment_id,
        name: name.to_string(),
        attachment_type: attachment_type.to_string(),
        size: content.len(),
    })
}

/// Load a chat attachment's content.
pub async fn load(
    genre_id: &str,
    thread_id: &str,
    message_id: &str,
    attachment_id: &str,
) -> Result<Option<String>, JsValue> {
    let relative_path = format!(
        "chats/attachments/{thread_id}/{message_id}/{attachment_id}.md"
    );
    genre_store::read_text(genre_id, &relative_path).await
}

/// Delete all attachments for a specific message.
pub async fn delete_for_message(
    genre_id: &str,
    thread_id: &str,
    message_id: &str,
) -> Result<(), JsValue> {
    let relative_path = format!("chats/attachments/{thread_id}/{message_id}");
    genre_store::remove_path(genre_id, &relative_path, true).await
}

/// Delete all attachments for a thread.
pub async fn delete_for_thread(genre_id: &str, thread_id: &str) -> Result<(), JsValue> {
    let relative_path = format!("chats/attachments/{thread_id}");
    genre_store::remove_path(genre_id, &relative_path, true).await
}
