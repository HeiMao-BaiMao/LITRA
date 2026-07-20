use js_sys::Date;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use wasm_bindgen::JsValue;

use crate::{data::genre_store, runtime::tauri};

use super::{models::SCHEMA_VERSION, repository};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub genre_id: String,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub thread_id: String,
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
    #[serde(default)]
    pub attachments: Vec<serde_json::Value>,
    pub created_at: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub schema_version: u32,
    pub thread: Thread,
    #[serde(default)]
    pub messages: Vec<Message>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreadList {
    schema_version: u32,
    #[serde(default)]
    threads: Vec<Thread>,
}

fn error(value: impl ToString) -> JsValue {
    JsValue::from_str(&value.to_string())
}
fn now() -> String {
    Date::new_0()
        .to_iso_string()
        .as_string()
        .unwrap_or_default()
}

async fn load_list(genre_id: &str) -> Result<ThreadList, JsValue> {
    let Some(text) = genre_store::read_text(genre_id, "chats/index.json").await? else {
        return Ok(ThreadList {
            schema_version: SCHEMA_VERSION,
            threads: Vec::new(),
        });
    };
    serde_json::from_str(&text).map_err(error)
}

async fn save_list(genre_id: &str, list: &ThreadList) -> Result<(), JsValue> {
    let text = serde_json::to_string_pretty(list).map_err(error)?;
    genre_store::write_text(genre_id, "chats/index.json", &text).await
}

pub async fn list(genre_id: &str) -> Result<Vec<Thread>, JsValue> {
    let mut threads = load_list(genre_id).await?.threads;
    threads.retain(|thread| thread.status != "archived");
    threads.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(threads)
}

pub async fn create(genre_id: &str, title: &str) -> Result<Thread, JsValue> {
    let timestamp = now();
    let thread = Thread {
        id: tauri::random_uuid(),
        genre_id: genre_id.into(),
        title: title.into(),
        summary: String::new(),
        status: "active".into(),
        created_at: timestamp.clone(),
        updated_at: timestamp,
        extra: BTreeMap::new(),
    };
    let document = Document {
        schema_version: SCHEMA_VERSION,
        thread: thread.clone(),
        messages: Vec::new(),
    };
    save(genre_id, &document).await?;
    Ok(thread)
}

pub async fn load(genre_id: &str, thread_id: &str) -> Result<Document, JsValue> {
    let text = genre_store::read_text(genre_id, &format!("chats/{thread_id}.json"))
        .await?
        .ok_or_else(|| JsValue::from_str("チャットスレッドが見つかりません。"))?;
    serde_json::from_str(&text).map_err(error)
}

pub async fn save(genre_id: &str, document: &Document) -> Result<(), JsValue> {
    let text = serde_json::to_string_pretty(document).map_err(error)?;
    genre_store::write_text(
        genre_id,
        &format!("chats/{}.json", document.thread.id),
        &text,
    )
    .await?;
    let mut list = load_list(genre_id).await?;
    if let Some(position) = list
        .threads
        .iter()
        .position(|thread| thread.id == document.thread.id)
    {
        list.threads[position] = document.thread.clone();
    } else {
        list.threads.push(document.thread.clone());
    }
    save_list(genre_id, &list).await?;
    repository::rebuild_counts(genre_id).await
}

pub async fn append(
    genre_id: &str,
    thread_id: &str,
    role: &str,
    content: String,
    thinking: Option<String>,
    provider: Option<String>,
    model: Option<String>,
) -> Result<Document, JsValue> {
    let mut document = load(genre_id, thread_id).await?;
    let timestamp = now();
    document.messages.push(Message {
        id: tauri::random_uuid(),
        thread_id: thread_id.into(),
        role: role.into(),
        content,
        thinking,
        provider,
        model,
        finish_reason: None,
        attachments: Vec::new(),
        created_at: timestamp.clone(),
        extra: BTreeMap::new(),
    });
    document.thread.updated_at = timestamp;
    save(genre_id, &document).await?;
    Ok(document)
}

/// Update the attachments list on a specific message within a thread.
pub async fn set_message_attachments(
    genre_id: &str,
    thread_id: &str,
    message_id: &str,
    attachments: Vec<serde_json::Value>,
) -> Result<(), JsValue> {
    let mut document = load(genre_id, thread_id).await?;
    if let Some(message) = document
        .messages
        .iter_mut()
        .find(|message| message.id == message_id)
    {
        message.attachments = attachments;
    }
    save(genre_id, &document).await
}

pub async fn rename(genre_id: &str, thread_id: &str, title: String) -> Result<(), JsValue> {
    let mut document = load(genre_id, thread_id).await?;
    document.thread.title = title;
    document.thread.updated_at = now();
    save(genre_id, &document).await
}
pub async fn archive(genre_id: &str, thread_id: &str) -> Result<(), JsValue> {
    let mut document = load(genre_id, thread_id).await?;
    document.thread.status = "archived".into();
    document.thread.updated_at = now();
    save(genre_id, &document).await
}
pub async fn remove(genre_id: &str, thread_id: &str) -> Result<(), JsValue> {
    genre_store::remove_path(genre_id, &format!("chats/{thread_id}.json"), false).await?;
    let mut list = load_list(genre_id).await?;
    list.threads.retain(|thread| thread.id != thread_id);
    save_list(genre_id, &list).await?;
    repository::rebuild_counts(genre_id).await
}
