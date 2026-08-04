use js_sys::Date;
use wasm_bindgen::JsValue;

use crate::{data::genre_store, runtime::tauri};

use super::{
    models::{KnowledgeCandidate, KnowledgeDocument, KnowledgeItem, SCHEMA_VERSION},
    repository,
};

fn error(value: impl ToString) -> JsValue {
    JsValue::from_str(&value.to_string())
}

pub async fn append_candidates(
    genre_id: &str,
    mut candidates: Vec<KnowledgeCandidate>,
) -> Result<(), JsValue> {
    let mut document = load(genre_id).await?;
    document.candidates.append(&mut candidates);
    commit(document, false).await.map(|_| ())
}
fn now() -> String {
    Date::new_0()
        .to_iso_string()
        .as_string()
        .unwrap_or_default()
}

pub async fn load(genre_id: &str) -> Result<KnowledgeDocument, JsValue> {
    let Some(text) = genre_store::read_text(genre_id, "knowledge/current.json").await? else {
        return Ok(KnowledgeDocument {
            schema_version: SCHEMA_VERSION,
            genre_id: genre_id.into(),
            revision: 0,
            items: Vec::new(),
            candidates: Vec::new(),
            updated_at: now(),
        });
    };
    serde_json::from_str(&text).map_err(error)
}

async fn save(document: &KnowledgeDocument) -> Result<(), JsValue> {
    let text = serde_json::to_string_pretty(document).map_err(error)?;
    genre_store::write_text(&document.genre_id, "knowledge/current.json", &text).await
}

async fn commit(mut document: KnowledgeDocument, bump: bool) -> Result<KnowledgeDocument, JsValue> {
    if bump {
        document.revision += 1;
    }
    document.updated_at = now();
    save(&document).await?;
    if bump {
        let text = serde_json::to_string_pretty(&document).map_err(error)?;
        let path = format!("knowledge/history/{}.json", document.revision);
        genre_store::write_text(&document.genre_id, &path, &text).await?;
    }
    repository::rebuild_counts(&document.genre_id).await?;
    Ok(document)
}

pub async fn create_item(genre_id: &str, title: String, statement: String) -> Result<(), JsValue> {
    let mut document = load(genre_id).await?;
    let timestamp = now();
    document.items.push(KnowledgeItem {
        id: tauri::random_uuid(),
        genre_id: genre_id.into(),
        category: "definition".into(),
        title,
        statement,
        explanation: String::new(),
        importance: "optional".into(),
        status: "active".into(),
        confidence: 1.0,
        authority: "user_explicit".into(),
        source_references: Vec::new(),
        chat_references: Vec::new(),
        created_from_candidate_id: None,
        created_at: timestamp.clone(),
        updated_at: timestamp,
    });
    commit(document, true).await.map(|_| ())
}

pub async fn update_item(
    genre_id: &str,
    item_id: &str,
    title: String,
    statement: String,
) -> Result<(), JsValue> {
    let mut document = load(genre_id).await?;
    let item = document
        .items
        .iter_mut()
        .find(|item| item.id == item_id)
        .ok_or_else(|| JsValue::from_str("知識が見つかりません。"))?;
    item.title = title;
    item.statement = statement;
    item.updated_at = now();
    commit(document, true).await.map(|_| ())
}

pub async fn set_item_status(genre_id: &str, item_id: &str, status: &str) -> Result<(), JsValue> {
    let mut document = load(genre_id).await?;
    let item = document
        .items
        .iter_mut()
        .find(|item| item.id == item_id)
        .ok_or_else(|| JsValue::from_str("知識が見つかりません。"))?;
    item.status = status.into();
    item.updated_at = now();
    commit(document, true).await.map(|_| ())
}

pub async fn remove_item(genre_id: &str, item_id: &str) -> Result<(), JsValue> {
    let mut document = load(genre_id).await?;
    document.items.retain(|item| item.id != item_id);
    commit(document, true).await.map(|_| ())
}

pub async fn set_candidate_status(
    genre_id: &str,
    candidate_id: &str,
    status: &str,
) -> Result<(), JsValue> {
    let mut document = load(genre_id).await?;
    let position = document
        .candidates
        .iter()
        .position(|candidate| candidate.id == candidate_id)
        .ok_or_else(|| JsValue::from_str("知識候補が見つかりません。"))?;
    if status == "accepted" {
        let candidate = document.candidates[position].clone();
        let timestamp = now();
        document.items.push(KnowledgeItem {
            id: tauri::random_uuid(),
            genre_id: genre_id.into(),
            category: candidate.category,
            title: candidate.title,
            statement: candidate.statement,
            explanation: candidate.explanation,
            importance: if candidate.proposed_importance == "work_specific" {
                "optional".into()
            } else {
                candidate.proposed_importance
            },
            status: "active".into(),
            confidence: candidate.confidence,
            authority: if candidate.created_by == "user" {
                "user_explicit".into()
            } else {
                "user_approved_ai".into()
            },
            source_references: candidate.source_references,
            chat_references: candidate.chat_references,
            created_from_candidate_id: Some(candidate.id),
            created_at: timestamp.clone(),
            updated_at: timestamp,
        });
    }
    document.candidates[position].status = status.into();
    document.candidates[position].updated_at = now();
    commit(document, status == "accepted").await.map(|_| ())
}
