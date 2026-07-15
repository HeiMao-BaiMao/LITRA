use js_sys::Date;
use serde::Deserialize;
use wasm_bindgen::JsValue;

use crate::{
    data::genre_store,
    runtime::{ai, tauri},
};

use super::{knowledge, models::KnowledgeCandidate, sources};

#[derive(Deserialize)]
struct AnalysisOutput {
    #[serde(default)]
    candidates: Vec<CandidateOutput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CandidateOutput {
    category: String,
    title: String,
    statement: String,
    #[serde(default)]
    explanation: String,
    #[serde(default = "importance")]
    importance: String,
    #[serde(default = "confidence")]
    confidence: f64,
}

fn importance() -> String {
    "optional".into()
}
fn confidence() -> f64 {
    0.7
}
fn now() -> String {
    Date::new_0()
        .to_iso_string()
        .as_string()
        .unwrap_or_default()
}

pub async fn analyze(genre_id: &str, source_id: &str, genre_name: &str) -> Result<usize, JsValue> {
    let source = sources::load(genre_id, source_id).await?;
    let prompt = format!(
        r#"ジャンル「{genre_name}」の参考資料を分析し、再利用可能なジャンル知識候補を抽出してください。

資料名: {title}
本文:
{content}

JSONのみを返してください。形式:
{{"candidates":[{{"category":"definition|core_requirement|frequent_feature|optional_feature|boundary_condition|genre_differentiator|prose_style|narrative_structure|scene_pattern|character_function|worldbuilding_function|reader_contract|emotional_effect|generation_guidance|prohibition|failure_mode|evaluation_criterion","title":"短い名称","statement":"知識本文","explanation":"根拠","importance":"core|frequent|optional|boundary|work_specific","confidence":0.0}}]}}
作品固有の固有名詞や表現を一般ルールとして採用しないでください。"#,
        title = source.metadata.title,
        content = source.content
    );
    let generated = ai::generate("chat", "あなたは小説ジャンル分析の専門家です。根拠のない断定を避け、指定JSON形式を厳守してください。".into(), prompt).await?;
    let json = extract_json(&generated.text)
        .ok_or_else(|| JsValue::from_str("AI分析結果にJSONがありません。"))?;
    let output: AnalysisOutput = serde_json::from_str(json)
        .map_err(|error| JsValue::from_str(&format!("AI分析JSONが不正です: {error}")))?;
    let timestamp = now();
    let candidates = output
        .candidates
        .into_iter()
        .filter(|item| !item.title.trim().is_empty() && !item.statement.trim().is_empty())
        .map(|item| KnowledgeCandidate {
            id: tauri::random_uuid(),
            genre_id: genre_id.into(),
            category: item.category,
            title: item.title,
            statement: item.statement,
            explanation: item.explanation,
            proposed_importance: item.importance,
            status: "pending".into(),
            confidence: item.confidence.clamp(0.0, 1.0),
            origin: "source_analysis".into(),
            source_references: vec![serde_json::json!({"sourceId": source_id})],
            chat_references: Vec::new(),
            created_by: "ai".into(),
            created_at: timestamp.clone(),
            updated_at: timestamp.clone(),
        })
        .collect::<Vec<_>>();
    let count = candidates.len();
    knowledge::append_candidates(genre_id, candidates).await?;
    let run_id = tauri::random_uuid();
    let run = serde_json::json!({
        "id": run_id, "genreId": genre_id, "sourceId": source_id, "status": "completed",
        "sourceHash": source.metadata.content_hash, "promptVersion": "rust-v1",
        "provider": generated.provider, "model": generated.model, "totalSegments": source.segments.len(),
        "completedSegments": source.segments.len(), "failedSegments": 0, "segmentResults": [],
        "startedAt": timestamp, "completedAt": now()
    });
    let text = serde_json::to_string_pretty(&run)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    genre_store::write_text(genre_id, &format!("analyses/{run_id}.json"), &text).await?;
    update_run_index(genre_id, run).await?;
    sources::mark_analyzed(genre_id, source_id, &run_id).await?;
    Ok(count)
}

async fn update_run_index(genre_id: &str, run: serde_json::Value) -> Result<(), JsValue> {
    let mut index = match genre_store::read_text(genre_id, "analyses/index.json").await? {
        Some(text) => serde_json::from_str::<serde_json::Value>(&text)
            .unwrap_or_else(|_| serde_json::json!({"schemaVersion":1,"runs":[]})),
        None => serde_json::json!({"schemaVersion":1,"runs":[]}),
    };
    index
        .get_mut("runs")
        .and_then(|value| value.as_array_mut())
        .ok_or_else(|| JsValue::from_str("分析インデックスが不正です。"))?
        .insert(0, run);
    let text = serde_json::to_string_pretty(&index)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    genre_store::write_text(genre_id, "analyses/index.json", &text).await
}

fn extract_json(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    (end >= start).then_some(&text[start..=end])
}
