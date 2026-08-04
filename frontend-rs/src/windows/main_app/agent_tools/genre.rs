use serde_json::{json, Map, Value};
use wasm_bindgen::JsValue;

use super::{boolean, integer, string, tool};
use crate::data::{
    genre_store,
    genres::{knowledge, repository, sources},
};

const NAMES: &[&str] = &[
    "listGenres",
    "getGenreOverview",
    "listGenreKnowledge",
    "getGenreKnowledgeItem",
    "listGenreSources",
    "getGenreSource",
    "searchGenreSourceText",
    "listGenreAnalyses",
    "getGenreAnalysis",
];

pub fn handles(name: &str) -> bool {
    NAMES.contains(&name)
}

pub async fn execute(name: &str, input: Value) -> Result<Value, JsValue> {
    let input = input.as_object().cloned().unwrap_or_default();
    match name {
        "listGenres" => {
            let query = optional(&input, "query").map(str::to_lowercase);
            let filtered = repository::list()
                .await?
                .into_iter()
                .filter(|genre| {
                    query.as_ref().is_none_or(|query| {
                        genre.name.to_lowercase().contains(query)
                            || genre.description.to_lowercase().contains(query)
                    })
                })
                .collect::<Vec<_>>();
            let genres = filtered
                .iter()
                .map(|genre| {
                    json!({
                        "id": genre.id,
                        "name": genre.name,
                        "description": limit_chars(&genre.description, 500),
                        "revision": genre.revision,
                        "sourceCount": genre.source_count,
                        "acceptedKnowledgeCount": genre.accepted_knowledge_count,
                        "candidateKnowledgeCount": genre.candidate_knowledge_count,
                        "updatedAt": genre.updated_at,
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({"count":genres.len(),"genres":genres}))
        }
        "getGenreOverview" => {
            let id = required(&input, "genreId")?;
            let genre = repository::load(id).await?;
            let knowledge = knowledge::load(id).await?;
            let sources = sources::list(id).await?;
            let analyses = read_json(id, "analyses/index.json").await?;
            let active_knowledge = knowledge
                .items
                .iter()
                .filter(|item| item.status == "active")
                .collect::<Vec<_>>();
            let genre_value = serde_json::to_value(&genre)
                .map_err(|error| JsValue::from_str(&error.to_string()))?;
            let key_knowledge = active_knowledge
                .iter()
                .take(20)
                .map(|item| {
                    json!({
                        "id": item.id,
                        "category": item.category,
                        "importance": item.importance,
                        "title": item.title,
                        "statement": limit_chars(&item.statement, 800),
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({
                "genre": genre_value,
                "counts": {
                    "sources": sources.len(),
                    "acceptedKnowledge": active_knowledge.len(),
                    "pendingKnowledgeCandidates": knowledge.candidates.iter().filter(|candidate| candidate.status == "pending").count(),
                    "analyses": analyses["runs"].as_array().map(Vec::len).unwrap_or(0),
                },
                "keyKnowledge": key_knowledge,
            }))
        }
        "listGenreKnowledge" => {
            let genre_id = required(&input, "genreId")?;
            let document = knowledge::load(genre_id).await?;
            let category = optional(&input, "category");
            let include_disabled = input
                .get("includeDisabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let max_items = input
                .get("maxItems")
                .and_then(Value::as_u64)
                .unwrap_or(50)
                .clamp(1, 100) as usize;
            let revision = document.revision;
            let items = document
                .items
                .into_iter()
                .filter(|item| {
                    (include_disabled || item.status == "active")
                        && category.is_none_or(|category| item.category == category)
                })
                .take(max_items)
                .map(|item| {
                    json!({
                        "id": item.id,
                        "category": item.category,
                        "importance": item.importance,
                        "status": item.status,
                        "confidence": item.confidence,
                        "title": item.title,
                        "statement": limit_chars(&item.statement, 1200),
                        "explanation": limit_chars(&item.explanation, 1200),
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({
                "genreId":genre_id,
                "revision":revision,
                "count":items.len(),
                "items":items,
            }))
        }
        "getGenreKnowledgeItem" => {
            let document = knowledge::load(required(&input, "genreId")?).await?;
            let id = required(&input, "itemId")?;
            let item = document.items.into_iter().find(|item| item.id == id);
            Ok(item
                .map(|item| {
                    json!({
                        "item": {
                            "id": item.id,
                            "genreId": item.genre_id,
                            "category": item.category,
                            "title": item.title,
                            "statement": limit_chars(&item.statement, 12_000),
                            "explanation": limit_chars(&item.explanation, 12_000),
                            "importance": item.importance,
                            "status": item.status,
                            "confidence": item.confidence,
                            "authority": item.authority,
                            "sourceReferences": item.source_references,
                            "chatReferences": item.chat_references,
                        }
                    })
                })
                .unwrap_or_else(|| json!({"error":"ジャンル知識が見つかりません。"})))
        }
        "listGenreSources" => {
            let items = sources::list(required(&input, "genreId")?).await?;
            let sources = items
                .iter()
                .map(|source| {
                    json!({
                        "id": source.id,
                        "title": source.title,
                        "author": source.author,
                        "sourceType": source.source_type,
                        "sourceRole": source.source_role,
                        "preference": source.preference,
                        "sourceNote": limit_chars(&source.source_note, 500),
                        "userInterpretation": limit_chars(&source.user_interpretation, 500),
                        "characterCount": source.character_count,
                        "segmentCount": source.segment_count,
                        "analysisStatus": source.analysis_status,
                        "latestAnalysisRunId": source.latest_analysis_run_id,
                        "updatedAt": source.updated_at,
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({"count":sources.len(),"sources":sources}))
        }
        "getGenreSource" => {
            let source =
                sources::load(required(&input, "genreId")?, required(&input, "sourceId")?).await?;
            let metadata = source.metadata;
            let segments = source.segments;
            let content = source.content;
            let include_content = input
                .get("includeContent")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || input.get("maxCharacters").is_some();
            let max_characters = input
                .get("maxCharacters")
                .and_then(Value::as_u64)
                .unwrap_or(16_000)
                .min(20_000) as usize;
            let mut output = json!({
                "source": metadata,
                "segments": segments,
            });
            if include_content {
                output["content"] = Value::String(limit_chars(&content, max_characters));
            }
            Ok(output)
        }
        "searchGenreSourceText" => search(&input).await,
        "listGenreAnalyses" => {
            let genre_id = required(&input, "genreId")?;
            let index = read_json(genre_id, "analyses/index.json").await?;
            let source_id = optional(&input, "sourceId");
            let runs = index["runs"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|run| source_id.is_none_or(|id| run["sourceId"] == id))
                .collect::<Vec<_>>();
            let analyses = runs
                .iter()
                .map(|run| {
                    json!({
                        "id": run["id"],
                        "sourceId": run["sourceId"],
                        "status": run["status"],
                        "provider": run["provider"],
                        "model": run["model"],
                        "totalSegments": run["totalSegments"],
                        "completedSegments": run["completedSegments"],
                        "failedSegments": run["failedSegments"],
                        "hasSynthesis": run.get("synthesis").is_some_and(|value| !value.is_null()),
                        "startedAt": run["startedAt"],
                        "completedAt": run["completedAt"],
                        "error": run["error"],
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({"count":analyses.len(),"analyses":analyses}))
        }
        "getGenreAnalysis" => {
            let genre_id = required(&input, "genreId")?;
            let id = required(&input, "analysisRunId")?;
            let mut analysis = read_json(genre_id, &format!("analyses/{id}.json")).await?;
            let max_segments = input
                .get("maxSegments")
                .and_then(Value::as_u64)
                .unwrap_or(5)
                .clamp(1, 20) as usize;
            if let Some(results) = analysis
                .get_mut("segmentResults")
                .and_then(Value::as_array_mut)
            {
                results.truncate(max_segments);
            }
            Ok(json!({"analysis":analysis}))
        }
        _ => Ok(json!({"error":format!("未知のジャンルツールです: {name}")})),
    }
}

async fn search(input: &Map<String, Value>) -> Result<Value, JsValue> {
    let genre_id = required(input, "genreId")?;
    let query = required(input, "query")?.to_lowercase();
    let limit = input
        .get("maxResults")
        .and_then(Value::as_u64)
        .unwrap_or(10)
        .min(20) as usize;
    let source_ids = input
        .get("sourceIds")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>());
    let mut results = Vec::new();
    for metadata in sources::list(genre_id).await? {
        if source_ids
            .as_ref()
            .is_some_and(|ids| !ids.is_empty() && !ids.contains(&metadata.id.as_str()))
        {
            continue;
        }
        let source = sources::load(genre_id, &metadata.id).await?;
        for segment in source.segments {
            let text = safe_slice(&source.content, segment.start_offset, segment.end_offset);
            if let Some(match_index) = text.to_lowercase().find(&query) {
                let start = match_index.saturating_sub(160);
                let end = (match_index + query.len() + 160).min(text.len());
                results.push(json!({
                    "sourceId":metadata.id,
                    "title":metadata.title,
                    "segmentId":segment.id,
                    "heading":segment.heading,
                    "snippet":limit_chars(safe_slice(text,start,end),500),
                }));
                if results.len() >= limit {
                    return Ok(json!({"count":results.len(),"results":results}));
                }
            }
        }
    }
    Ok(json!({"count":results.len(),"results":results}))
}

async fn read_json(genre_id: &str, path: &str) -> Result<Value, JsValue> {
    let text = genre_store::read_text(genre_id, path)
        .await?
        .ok_or_else(|| JsValue::from_str(&format!("{path} が見つかりません。")))?;
    serde_json::from_str(&text).map_err(|error| JsValue::from_str(&error.to_string()))
}
fn required<'a>(input: &'a Map<String, Value>, key: &str) -> Result<&'a str, JsValue> {
    input
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| JsValue::from_str(&format!("{key} は必須です。")))
}
fn optional<'a>(input: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    input
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}
fn safe_slice(text: &str, start: usize, end: usize) -> &str {
    let mut start = start.min(text.len());
    let mut end = end.min(text.len()).max(start);
    while start > 0 && !text.is_char_boundary(start) {
        start -= 1;
    }
    while end > start && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[start..end]
}
fn limit_chars(text: &str, limit: usize) -> String {
    let mut value = text.chars().take(limit).collect::<String>();
    if text.chars().count() > limit {
        value.push_str("…（後略）");
    }
    value
}

fn object<const N: usize>(properties: [(&str, Value); N], required: &[&str]) -> Value {
    let properties = properties
        .into_iter()
        .map(|(key, value)| (key.into(), value))
        .collect::<Map<String, Value>>();
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}

pub fn definitions() -> Vec<Value> {
    vec![
        tool(
            "listGenres",
            "ジャンルライブラリを検索・一覧します。",
            object([("query", string())], &[]),
        ),
        tool(
            "getGenreOverview",
            "ジャンルの定義と概要を読みます。",
            object([("genreId", string())], &["genreId"]),
        ),
        tool(
            "listGenreKnowledge",
            "採用済みジャンル知識を一覧します。",
            object(
                [
                    ("genreId", string()),
                    ("category", string()),
                    ("includeDisabled", boolean()),
                    ("maxItems", integer()),
                ],
                &["genreId"],
            ),
        ),
        tool(
            "getGenreKnowledgeItem",
            "ジャンル知識項目の全文を読みます。",
            object(
                [("genreId", string()), ("itemId", string())],
                &["genreId", "itemId"],
            ),
        ),
        tool(
            "listGenreSources",
            "ジャンル資料を一覧します。",
            object([("genreId", string())], &["genreId"]),
        ),
        tool(
            "getGenreSource",
            "ジャンル資料本文を読みます。",
            object(
                [
                    ("genreId", string()),
                    ("sourceId", string()),
                    ("includeContent", boolean()),
                    ("maxCharacters", integer()),
                ],
                &["genreId", "sourceId"],
            ),
        ),
        tool(
            "searchGenreSourceText",
            "ジャンル資料本文を検索します。",
            object(
                [
                    ("genreId", string()),
                    ("query", string()),
                    ("sourceIds", json!({"type":"array","items":{"type":"string"}})),
                    ("maxResults", integer()),
                ],
                &["genreId", "query"],
            ),
        ),
        tool(
            "listGenreAnalyses",
            "ジャンル資料の分析履歴を一覧します。",
            object(
                [("genreId", string()), ("sourceId", string())],
                &["genreId"],
            ),
        ),
        tool(
            "getGenreAnalysis",
            "ジャンル分析結果を読みます。",
            object(
                [
                    ("genreId", string()),
                    ("analysisRunId", string()),
                    ("maxSegments", integer()),
                ],
                &["genreId", "analysisRunId"],
            ),
        ),
    ]
}
