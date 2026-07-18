use serde_json::{json, Map, Value};
use wasm_bindgen::JsValue;

use super::{integer, string, tool};
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
            let genres = repository::list()
                .await?
                .into_iter()
                .filter(|genre| {
                    query.as_ref().is_none_or(|query| {
                        genre.name.to_lowercase().contains(query)
                            || genre.description.to_lowercase().contains(query)
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({"genres":genres}))
        }
        "getGenreOverview" => {
            let id = required(&input, "genreId")?;
            let genre = repository::load(id).await?;
            let knowledge = knowledge::load(id).await?;
            Ok(
                json!({"genre":genre,"acceptedKnowledgeCount":knowledge.items.iter().filter(|item| item.status == "active").count(),
                "candidateKnowledgeCount":knowledge.candidates.iter().filter(|item| item.status == "pending").count()}),
            )
        }
        "listGenreKnowledge" => {
            let document = knowledge::load(required(&input, "genreId")?).await?;
            let category = optional(&input, "category");
            let items = document
                .items
                .into_iter()
                .filter(|item| {
                    item.status == "active"
                        && category.is_none_or(|category| item.category == category)
                })
                .collect::<Vec<_>>();
            Ok(json!({"items":items}))
        }
        "getGenreKnowledgeItem" => {
            let document = knowledge::load(required(&input, "genreId")?).await?;
            let id = required(&input, "itemId")?;
            let item = document.items.into_iter().find(|item| item.id == id);
            Ok(item
                .map(|item| json!({"item":item}))
                .unwrap_or_else(|| json!({"error":"ジャンル知識が見つかりません。"})))
        }
        "listGenreSources" => {
            let items = sources::list(required(&input, "genreId")?).await?;
            Ok(json!({"sources":items}))
        }
        "getGenreSource" => {
            let source =
                sources::load(required(&input, "genreId")?, required(&input, "sourceId")?).await?;
            Ok(
                json!({"metadata":source.metadata,"segments":source.segments,
                "content":limit_chars(&source.content, input.get("maxCharacters").and_then(Value::as_u64).unwrap_or(6000).min(20000) as usize)}),
            )
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
            Ok(json!({"runs":runs}))
        }
        "getGenreAnalysis" => {
            let genre_id = required(&input, "genreId")?;
            let id = required(&input, "analysisRunId")?;
            Ok(json!({"run":read_json(genre_id,&format!("analyses/{id}.json")).await?}))
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
    let mut results = Vec::new();
    for metadata in sources::list(genre_id).await? {
        let source = sources::load(genre_id, &metadata.id).await?;
        for segment in source.segments {
            let text = safe_slice(&source.content, segment.start_offset, segment.end_offset);
            if text.to_lowercase().contains(&query) {
                results.push(json!({"sourceId":metadata.id,"segmentId":segment.id,"title":metadata.title,"snippet":limit_chars(text,300)}));
                if results.len() >= limit {
                    return Ok(json!({"results":results}));
                }
            }
        }
    }
    Ok(json!({"results":results}))
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
                [("genreId", string()), ("category", string())],
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
                [("genreId", string()), ("analysisRunId", string())],
                &["genreId", "analysisRunId"],
            ),
        ),
    ]
}
