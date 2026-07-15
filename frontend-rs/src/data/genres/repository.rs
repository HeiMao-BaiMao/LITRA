use js_sys::Date;
use wasm_bindgen::JsValue;

use crate::{data::genre_store, runtime::tauri};

use super::models::{Genre, GenreIndex, GenreIndexEntry, GenreUpdate, SCHEMA_VERSION};

fn json_error(error: impl ToString) -> JsValue {
    JsValue::from_str(&error.to_string())
}

fn now() -> String {
    Date::new_0()
        .to_iso_string()
        .as_string()
        .unwrap_or_default()
}

async fn load_index() -> Result<GenreIndex, JsValue> {
    let Some(text) = genre_store::read_index().await? else {
        return Ok(GenreIndex {
            schema_version: SCHEMA_VERSION,
            genres: Vec::new(),
        });
    };
    serde_json::from_str(&text).map_err(json_error)
}

async fn save_index(index: &GenreIndex) -> Result<(), JsValue> {
    let text = serde_json::to_string_pretty(index).map_err(json_error)?;
    genre_store::write_index(&text).await
}

pub async fn list() -> Result<Vec<GenreIndexEntry>, JsValue> {
    let mut genres = load_index().await?.genres;
    genres.retain(|genre| genre.status != "archived");
    genres.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(genres)
}

pub async fn load(genre_id: &str) -> Result<Genre, JsValue> {
    let text = genre_store::read_text(genre_id, "genre.json")
        .await?
        .ok_or_else(|| JsValue::from_str(&format!("ジャンル {genre_id} が見つかりません。")))?;
    serde_json::from_str(&text).map_err(json_error)
}

pub async fn create(name: &str) -> Result<Genre, JsValue> {
    let id = tauri::random_uuid();
    let timestamp = now();
    let genre = Genre {
        schema_version: SCHEMA_VERSION,
        id: id.clone(),
        name: name.to_owned(),
        aliases: Vec::new(),
        description: String::new(),
        user_definition: String::new(),
        notes: String::new(),
        tags: Vec::new(),
        status: "active".into(),
        revision: 0,
        created_at: timestamp.clone(),
        updated_at: timestamp.clone(),
    };

    write_json(&id, "genre.json", &genre).await?;
    write_value(
        &id,
        "sources/index.json",
        serde_json::json!({"schemaVersion": SCHEMA_VERSION, "sources": []}),
    )
    .await?;
    write_value(
        &id,
        "analyses/index.json",
        serde_json::json!({"schemaVersion": SCHEMA_VERSION, "runs": []}),
    )
    .await?;
    write_value(
        &id,
        "knowledge/current.json",
        serde_json::json!({
            "schemaVersion": SCHEMA_VERSION, "genreId": id, "revision": 0,
            "items": [], "candidates": [], "updatedAt": timestamp
        }),
    )
    .await?;
    write_value(
        &id,
        "chats/index.json",
        serde_json::json!({"schemaVersion": SCHEMA_VERSION, "threads": []}),
    )
    .await?;

    let mut index = load_index().await?;
    index.genres.push(GenreIndexEntry::from_genre(&genre));
    save_index(&index).await?;
    Ok(genre)
}

pub async fn update(genre_id: &str, changes: GenreUpdate) -> Result<Genre, JsValue> {
    let mut genre = load(genre_id).await?;
    if let Some(value) = changes.name {
        genre.name = value;
    }
    if let Some(value) = changes.aliases {
        genre.aliases = value;
    }
    if let Some(value) = changes.description {
        genre.description = value;
    }
    if let Some(value) = changes.user_definition {
        genre.user_definition = value;
    }
    if let Some(value) = changes.notes {
        genre.notes = value;
    }
    if let Some(value) = changes.tags {
        genre.tags = value;
    }
    if let Some(value) = changes.status {
        genre.status = value;
    }
    genre.updated_at = now();
    write_json(genre_id, "genre.json", &genre).await?;

    let mut index = load_index().await?;
    let mut next = GenreIndexEntry::from_genre(&genre);
    if let Some(existing) = index.genres.iter().find(|entry| entry.id == genre_id) {
        next.source_count = existing.source_count;
        next.accepted_knowledge_count = existing.accepted_knowledge_count;
        next.candidate_knowledge_count = existing.candidate_knowledge_count;
        next.chat_thread_count = existing.chat_thread_count;
    }
    if let Some(position) = index.genres.iter().position(|entry| entry.id == genre_id) {
        index.genres[position] = next;
    } else {
        index.genres.push(next);
    }
    save_index(&index).await?;
    Ok(genre)
}

pub async fn remove(genre_id: &str) -> Result<(), JsValue> {
    genre_store::remove_genre(genre_id).await?;
    let mut index = load_index().await?;
    index.genres.retain(|entry| entry.id != genre_id);
    save_index(&index).await
}

pub async fn rebuild_counts(genre_id: &str) -> Result<(), JsValue> {
    let genre = load(genre_id).await?;
    let mut entry = GenreIndexEntry::from_genre(&genre);
    if let Some(text) = genre_store::read_text(genre_id, "sources/index.json").await? {
        entry.source_count = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|value| value.get("sources")?.as_array().map(Vec::len))
            .unwrap_or(0);
    }
    if let Some(text) = genre_store::read_text(genre_id, "knowledge/current.json").await? {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            entry.accepted_knowledge_count = value
                .get("items")
                .and_then(|items| items.as_array())
                .map(Vec::len)
                .unwrap_or(0);
            entry.candidate_knowledge_count = value
                .get("candidates")
                .and_then(|items| items.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter(|item| {
                            item.get("status").and_then(|status| status.as_str()) == Some("pending")
                        })
                        .count()
                })
                .unwrap_or(0);
        }
    }
    if let Some(text) = genre_store::read_text(genre_id, "chats/index.json").await? {
        entry.chat_thread_count = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|value| value.get("threads")?.as_array().map(Vec::len))
            .unwrap_or(0);
    }
    let mut index = load_index().await?;
    if let Some(position) = index.genres.iter().position(|item| item.id == genre_id) {
        index.genres[position] = entry;
    } else {
        index.genres.push(entry);
    }
    save_index(&index).await
}

async fn write_json<T: serde::Serialize>(
    genre_id: &str,
    path: &str,
    value: &T,
) -> Result<(), JsValue> {
    let text = serde_json::to_string_pretty(value).map_err(json_error)?;
    genre_store::write_text(genre_id, path, &text).await
}

async fn write_value(genre_id: &str, path: &str, value: serde_json::Value) -> Result<(), JsValue> {
    write_json(genre_id, path, &value).await
}
