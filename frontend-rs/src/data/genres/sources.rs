use js_sys::Date;
use wasm_bindgen::JsValue;

use crate::{data::genre_store, runtime::tauri};

use super::{
    hash::compute_text_hash,
    models::{
        GenreSource, SegmentDocument, SourceList, SourceSegment, SourceWithContent, SCHEMA_VERSION,
    },
    repository,
    segmentation::{self, SegmentationOptions},
};

fn error(value: impl ToString) -> JsValue {
    JsValue::from_str(&value.to_string())
}
fn now() -> String {
    Date::new_0()
        .to_iso_string()
        .as_string()
        .unwrap_or_default()
}

async fn load_list(genre_id: &str) -> Result<SourceList, JsValue> {
    let Some(text) = genre_store::read_text(genre_id, "sources/index.json").await? else {
        return Ok(SourceList {
            schema_version: SCHEMA_VERSION,
            sources: Vec::new(),
        });
    };
    serde_json::from_str(&text).map_err(error)
}

async fn save_list(genre_id: &str, list: &SourceList) -> Result<(), JsValue> {
    let text = serde_json::to_string_pretty(list).map_err(error)?;
    genre_store::write_text(genre_id, "sources/index.json", &text).await
}

pub async fn list(genre_id: &str) -> Result<Vec<GenreSource>, JsValue> {
    let mut sources = load_list(genre_id).await?.sources;
    sources.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(sources)
}

pub async fn load(genre_id: &str, source_id: &str) -> Result<SourceWithContent, JsValue> {
    let metadata = load_list(genre_id)
        .await?
        .sources
        .into_iter()
        .find(|item| item.id == source_id)
        .ok_or_else(|| JsValue::from_str("資料が見つかりません。"))?;
    let content = genre_store::read_text(genre_id, &format!("sources/{source_id}.md"))
        .await?
        .unwrap_or_default();
    let segment_text =
        genre_store::read_text(genre_id, &format!("sources/segments/{source_id}.json")).await?;
    let segments = match segment_text {
        Some(text) => {
            serde_json::from_str::<SegmentDocument>(&text)
                .map_err(error)?
                .segments
        }
        None => Vec::new(),
    };
    Ok(SourceWithContent {
        metadata,
        content,
        segments,
    })
}

pub async fn create(
    genre_id: &str,
    title: &str,
    content: &str,
) -> Result<SourceWithContent, JsValue> {
    let id = tauri::random_uuid();
    let timestamp = now();
    let content_hash = compute_text_hash(content).await?;
    let segments =
        segmentation::segment_source_text(&id, content, SegmentationOptions::default()).await?;
    let segments = if segments.is_empty() {
        vec![SourceSegment {
            id: tauri::random_uuid(),
            source_id: id.clone(),
            ordinal: 0,
            heading: title.to_owned(),
            start_offset: 0,
            end_offset: content.len(),
            content_hash: content_hash.clone(),
            segmentation_method: "manual".into(),
        }]
    } else {
        segments
    };
    let metadata = GenreSource {
        id: id.clone(),
        genre_id: genre_id.into(),
        title: title.into(),
        author: String::new(),
        source_type: "other".into(),
        source_role: "partial_example".into(),
        preference: "neutral".into(),
        source_note: String::new(),
        user_interpretation: String::new(),
        media_type: "text/markdown".into(),
        language: "ja".into(),
        content_file_name: format!("{id}.md"),
        content_hash,
        character_count: content.chars().count(),
        segment_count: segments.len(),
        analysis_status: "not_analyzed".into(),
        latest_analysis_run_id: None,
        created_at: timestamp.clone(),
        updated_at: timestamp,
        extra: Default::default(),
    };
    genre_store::write_text(genre_id, &format!("sources/{id}.md"), content).await?;
    write_json(
        genre_id,
        &format!("sources/segments/{id}.json"),
        &SegmentDocument {
            schema_version: SCHEMA_VERSION,
            source_id: id.clone(),
            segments: segments.clone(),
        },
    )
    .await?;
    let mut list = load_list(genre_id).await?;
    list.sources.push(metadata.clone());
    save_list(genre_id, &list).await?;
    repository::rebuild_counts(genre_id).await?;
    Ok(SourceWithContent {
        metadata,
        content: content.into(),
        segments,
    })
}

pub async fn remove(genre_id: &str, source_id: &str) -> Result<(), JsValue> {
    let mut list = load_list(genre_id).await?;
    list.sources.retain(|item| item.id != source_id);
    save_list(genre_id, &list).await?;
    let _ = genre_store::remove_path(genre_id, &format!("sources/{source_id}.md"), false).await;
    let _ = genre_store::remove_path(
        genre_id,
        &format!("sources/segments/{source_id}.json"),
        false,
    )
    .await;
    repository::rebuild_counts(genre_id).await
}

pub async fn mark_analyzed(genre_id: &str, source_id: &str, run_id: &str) -> Result<(), JsValue> {
    let mut list = load_list(genre_id).await?;
    let source = list
        .sources
        .iter_mut()
        .find(|source| source.id == source_id)
        .ok_or_else(|| JsValue::from_str("資料が見つかりません。"))?;
    source.analysis_status = "completed".into();
    source.latest_analysis_run_id = Some(run_id.into());
    source.updated_at = now();
    save_list(genre_id, &list).await?;
    repository::rebuild_counts(genre_id).await
}

async fn write_json<T: serde::Serialize>(
    genre_id: &str,
    path: &str,
    value: &T,
) -> Result<(), JsValue> {
    let text = serde_json::to_string_pretty(value).map_err(error)?;
    genre_store::write_text(genre_id, path, &text).await
}
