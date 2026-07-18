use std::{cell::RefCell, rc::Rc};

use js_sys::Date;
use serde_json::{json, Map, Value};
use wasm_bindgen::JsValue;

use super::State;
use crate::{
    data::{
        genre_store,
        genres::{
            chat, knowledge,
            models::{GenreUpdate, KnowledgeCandidate},
            repository, sources,
        },
    },
    runtime::{ai, tauri},
};

const MAX_TOOL_ROUNDS: usize = 8;
const MAX_SOURCE_SNIPPET: usize = 3_000;
const MAX_KNOWLEDGE_SNIPPET: usize = 1_500;

pub async fn run(
    state: &Rc<RefCell<State>>,
    genre_id: &str,
    thread_id: &str,
    mut system: String,
    prompt: String,
    provider: Option<&str>,
    model: Option<&str>,
) -> Result<ai::GeneratedText, JsValue> {
    system.push_str(GUIDANCE);
    let mut messages = vec![json!({"role":"user","content":prompt})];
    let definitions = definitions();
    for _ in 0..MAX_TOOL_ROUNDS {
        let turn = ai::agent_turn(
            "chat",
            system.clone(),
            messages.clone(),
            definitions.clone(),
            provider,
            model,
        )
        .await?;
        if turn.tool_calls.is_empty() {
            return Ok(ai::GeneratedText {
                text: turn.text,
                provider: turn.provider,
                model: turn.model,
            });
        }
        let mut assistant_parts = Vec::new();
        if !turn.text.trim().is_empty() {
            assistant_parts.push(json!({"type":"text","text":turn.text}));
        }
        for call in &turn.tool_calls {
            assistant_parts.push(json!({
                "type":"tool-call", "toolCallId":call.id,
                "toolName":call.name, "input":call.input,
            }));
        }
        messages.push(json!({"role":"assistant","content":assistant_parts}));
        let mut results = Vec::new();
        for call in turn.tool_calls {
            let output = execute(state, genre_id, thread_id, &call.name, call.input)
                .await
                .unwrap_or_else(|error| json!({"error":js_error(&error)}));
            results.push(json!({
                "type":"tool-result", "toolCallId":call.id, "toolName":call.name,
                "output":{"type":"json","value":output},
            }));
        }
        messages.push(json!({"role":"tool","content":results}));
    }
    Err(JsValue::from_str(
        "ジャンルチャットのツール実行回数が上限を超えました。",
    ))
}

async fn execute(
    state: &Rc<RefCell<State>>,
    genre_id: &str,
    thread_id: &str,
    name: &str,
    input: Value,
) -> Result<Value, JsValue> {
    let input = input.as_object().cloned().unwrap_or_default();
    match name {
        "readGenreChatHistory" => {
            let document = chat::load(genre_id, thread_id).await?;
            let include_attachments = input
                .get("includeAttachments")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let mut messages = Vec::new();
            for message in document.messages {
                let attachments = message.attachments.clone();
                let mut value = serde_json::to_value(message)
                    .map_err(|error| JsValue::from_str(&error.to_string()))?;
                if include_attachments {
                    let mut contents = Vec::new();
                    for attachment in attachments {
                        let Some(id) = attachment.get("id").and_then(Value::as_str) else {
                            continue;
                        };
                        let path = format!(
                            "chats/attachments/{thread_id}/{}/{id}.md",
                            value["id"].as_str().unwrap_or_default()
                        );
                        if let Some(content) = genre_store::read_text(genre_id, &path).await? {
                            contents.push(json!({
                                "id":id,
                                "name":attachment.get("name").and_then(Value::as_str).unwrap_or_default(),
                                "content":limit_chars(&content, MAX_SOURCE_SNIPPET),
                            }));
                        }
                    }
                    value["attachmentContents"] = Value::Array(contents);
                }
                messages.push(value);
            }
            Ok(json!({"messages":messages}))
        }
        "readGenreChatAttachment" => {
            let message_id = required_str(&input, "messageId")?;
            let attachment_id = required_str(&input, "attachmentId")?;
            let path = format!("chats/attachments/{thread_id}/{message_id}/{attachment_id}.md");
            Ok(
                json!({"content":genre_store::read_text(genre_id, &path).await?.unwrap_or_default()}),
            )
        }
        "updateGenreUserDefinition" | "updateGenreNotes" => {
            let mut changes = GenreUpdate::default();
            if name == "updateGenreUserDefinition" {
                changes.user_definition = Some(required_str(&input, "userDefinition")?.into());
            } else {
                changes.notes = Some(required_str(&input, "notes")?.into());
            }
            let genre = repository::update(genre_id, changes).await?;
            state.borrow_mut().genre = Some(genre);
            Ok(json!({"success":true,"message":"ジャンル情報を更新しました。"}))
        }
        "listGenreSources" => {
            let items = sources::list(genre_id).await?;
            Ok(json!({"sources":items.into_iter().map(|item| json!({
                "id":item.id,"title":item.title,"sourceType":item.source_type,
                "sourceRole":item.source_role,"analysisStatus":item.analysis_status
            })).collect::<Vec<_>>() }))
        }
        "readGenreSourceMetadata" => {
            let id = required_str(&input, "sourceId")?;
            let item = sources::list(genre_id)
                .await?
                .into_iter()
                .find(|item| item.id == id);
            Ok(item
                .map(|source| json!({"source":source}))
                .unwrap_or_else(|| json!({"error":"資料が見つかりません。"})))
        }
        "readGenreSourceSegment" => {
            let source = sources::load(genre_id, required_str(&input, "sourceId")?).await?;
            let segment_id = required_str(&input, "segmentId")?;
            let Some(segment) = source
                .segments
                .into_iter()
                .find(|item| item.id == segment_id)
            else {
                return Ok(json!({"error":"資料セグメントが見つかりません。"}));
            };
            let content = safe_slice(&source.content, segment.start_offset, segment.end_offset);
            Ok(json!({"segment":{
                "id":segment.id,"sourceId":segment.source_id,"ordinal":segment.ordinal,
                "heading":segment.heading,"content":limit_chars(content, MAX_SOURCE_SNIPPET)
            }}))
        }
        "searchGenreSourceText" => search_sources(genre_id, &input).await,
        "listGenreAnalyses" => {
            let index = read_json(genre_id, "analyses/index.json").await?;
            let source_id = optional_str(&input, "sourceId");
            let runs = index
                .get("runs")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let runs = runs
                .into_iter()
                .filter(|run| source_id.is_none_or(|id| run["sourceId"] == id))
                .collect::<Vec<_>>();
            Ok(json!({"runs":runs}))
        }
        "readGenreAnalysis" => {
            let id = required_str(&input, "analysisRunId")?;
            Ok(json!({"run":read_json(genre_id, &format!("analyses/{id}.json")).await?}))
        }
        "listGenreKnowledge" => {
            let category = optional_str(&input, "category");
            let items = knowledge::load(genre_id).await?.items.into_iter()
                .filter(|item| item.status == "active" && category.is_none_or(|value| item.category == value))
                .map(|item| json!({"id":item.id,"category":item.category,"title":item.title,
                    "statement":limit_chars(&item.statement, MAX_KNOWLEDGE_SNIPPET),"importance":item.importance}))
                .collect::<Vec<_>>();
            Ok(json!({"items":items}))
        }
        "readGenreKnowledgeItem" => {
            let id = required_str(&input, "itemId")?;
            let item = knowledge::load(genre_id)
                .await?
                .items
                .into_iter()
                .find(|item| item.id == id);
            Ok(item
                .map(|item| json!({"item":item}))
                .unwrap_or_else(|| json!({"error":"知識項目が見つかりません。"})))
        }
        "listGenreKnowledgeCandidates" => {
            let candidates = knowledge::load(genre_id)
                .await?
                .candidates
                .into_iter()
                .filter(|item| item.status == "pending")
                .collect::<Vec<_>>();
            Ok(json!({"candidates":candidates}))
        }
        "proposeGenreKnowledgeItem" => {
            let candidate = candidate_from_input(genre_id, thread_id, &input)?;
            let id = candidate.id.clone();
            knowledge::append_candidates(genre_id, vec![candidate]).await?;
            Ok(
                json!({"success":true,"candidateId":id,"message":"知識候補を作成しました。レビュー画面で承認してください。"}),
            )
        }
        "proposeGenreKnowledgeUpdate" => propose_update(genre_id, thread_id, &input, false).await,
        "proposeGenreKnowledgeDisable" => propose_update(genre_id, thread_id, &input, true).await,
        "proposeThreadSummary" => Ok(
            json!({"success":true,"proposedSummary":required_str(&input,"summary")?,"message":"スレッド要約案を作成しました。"}),
        ),
        "proposeChatConclusions" => {
            let document = chat::load(genre_id, thread_id).await?;
            Ok(json!({
                "messages":document.messages,
                "instruction":"合意済みの新規結論だけを抽出し、各結論を proposeGenreKnowledgeItem で候補化してください。既存知識の変更は proposeGenreKnowledgeUpdate、無効化は proposeGenreKnowledgeDisable を使ってください。未解決事項は候補化しないでください。"
            }))
        }
        _ => Ok(json!({"error":format!("未知のジャンルツールです: {name}")})),
    }
}

async fn search_sources(genre_id: &str, input: &Map<String, Value>) -> Result<Value, JsValue> {
    let query = required_str(input, "query")?.to_lowercase();
    let ids = input
        .get("sourceIds")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        });
    let limit = input
        .get("maxResults")
        .and_then(Value::as_u64)
        .unwrap_or(10)
        .min(20) as usize;
    let mut results = Vec::new();
    for metadata in sources::list(genre_id).await? {
        if ids.as_ref().is_some_and(|ids| !ids.contains(&metadata.id)) {
            continue;
        }
        let source = sources::load(genre_id, &metadata.id).await?;
        for segment in source.segments {
            let content = safe_slice(&source.content, segment.start_offset, segment.end_offset);
            if content.to_lowercase().contains(&query) {
                results.push(json!({"sourceId":metadata.id,"segmentId":segment.id,
                    "title":metadata.title,"snippet":limit_chars(content, 300)}));
                if results.len() >= limit {
                    return Ok(json!({"results":results}));
                }
            }
        }
    }
    Ok(json!({"results":results}))
}

async fn propose_update(
    genre_id: &str,
    thread_id: &str,
    input: &Map<String, Value>,
    disable: bool,
) -> Result<Value, JsValue> {
    let target_id = required_str(input, "targetKnowledgeItemId")?;
    let item = knowledge::load(genre_id)
        .await?
        .items
        .into_iter()
        .find(|item| item.id == target_id)
        .ok_or_else(|| JsValue::from_str("対象の知識項目が見つかりません。"))?;
    let reason = required_str(input, "reason")?;
    let (category, title, statement, explanation, importance, confidence) = if disable {
        (
            "failure_mode".into(),
            format!("{}（無効化提案）", item.title),
            format!("既存知識「{}」を無効化する提案", item.title),
            format!("【無効化理由】\n{reason}"),
            "boundary".into(),
            0.5,
        )
    } else {
        (
            item.category,
            format!("{}（修正案）", item.title),
            required_str(input, "proposedStatement")?.into(),
            format!("【修正理由】\n{reason}\n\n【元の文面】\n{}", item.statement),
            item.importance,
            0.6,
        )
    };
    let candidate = new_candidate(
        genre_id,
        thread_id,
        category,
        title,
        statement,
        explanation,
        importance,
        confidence,
    );
    let id = candidate.id.clone();
    knowledge::append_candidates(genre_id, vec![candidate]).await?;
    Ok(
        json!({"success":true,"candidateId":id,"message":"変更候補を作成しました。レビュー画面で承認してください。"}),
    )
}

fn candidate_from_input(
    genre_id: &str,
    thread_id: &str,
    input: &Map<String, Value>,
) -> Result<KnowledgeCandidate, JsValue> {
    let mut candidate = new_candidate(
        genre_id,
        thread_id,
        required_str(input, "category")?.into(),
        required_str(input, "title")?.into(),
        required_str(input, "statement")?.into(),
        required_str(input, "explanation")?.into(),
        required_str(input, "proposedImportance")?.into(),
        0.7,
    );
    candidate.source_references = input
        .get("sourceSegmentIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|segment_id| json!({"sourceId":"","segmentId":segment_id}))
        .collect();
    Ok(candidate)
}

#[allow(clippy::too_many_arguments)]
fn new_candidate(
    genre_id: &str,
    thread_id: &str,
    category: String,
    title: String,
    statement: String,
    explanation: String,
    importance: String,
    confidence: f64,
) -> KnowledgeCandidate {
    let timestamp = Date::new_0()
        .to_iso_string()
        .as_string()
        .unwrap_or_default();
    KnowledgeCandidate {
        id: tauri::random_uuid(),
        genre_id: genre_id.into(),
        category,
        title,
        statement,
        explanation,
        proposed_importance: importance,
        status: "pending".into(),
        confidence,
        origin: "genre_chat".into(),
        source_references: Vec::new(),
        chat_references: vec![json!({"threadId":thread_id,"messageIds":[]})],
        created_by: "ai".into(),
        created_at: timestamp.clone(),
        updated_at: timestamp,
    }
}

async fn read_json(genre_id: &str, path: &str) -> Result<Value, JsValue> {
    let text = genre_store::read_text(genre_id, path)
        .await?
        .ok_or_else(|| JsValue::from_str(&format!("{path} が見つかりません。")))?;
    serde_json::from_str(&text).map_err(|error| JsValue::from_str(&error.to_string()))
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
fn required_str<'a>(input: &'a Map<String, Value>, key: &str) -> Result<&'a str, JsValue> {
    input
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| JsValue::from_str(&format!("{key} は必須です。")))
}
fn optional_str<'a>(input: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    input
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}
fn js_error(error: &JsValue) -> String {
    error.as_string().unwrap_or_else(|| format!("{error:?}"))
}

fn definitions() -> Vec<Value> {
    let categories = &[
        "definition",
        "core_requirement",
        "frequent_feature",
        "optional_feature",
        "boundary_condition",
        "genre_differentiator",
        "prose_style",
        "narrative_structure",
        "scene_pattern",
        "character_function",
        "worldbuilding_function",
        "reader_contract",
        "emotional_effect",
        "generation_guidance",
        "prohibition",
        "failure_mode",
        "evaluation_criterion",
    ];
    vec![
        tool(
            "readGenreChatHistory",
            "現在のジャンルチャット履歴を読みます。",
            object([("includeAttachments", boolean())], &[]),
        ),
        tool(
            "readGenreChatAttachment",
            "チャット添付の長文を読みます。",
            object(
                [("messageId", string()), ("attachmentId", string())],
                &["messageId", "attachmentId"],
            ),
        ),
        tool(
            "updateGenreUserDefinition",
            "ユーザーが明示したジャンル定義を保存します。",
            object([("userDefinition", string())], &["userDefinition"]),
        ),
        tool(
            "updateGenreNotes",
            "作業メモや未整理事項を保存します。",
            object([("notes", string())], &["notes"]),
        ),
        tool(
            "listGenreSources",
            "登録資料を一覧します。",
            object([], &[]),
        ),
        tool(
            "readGenreSourceMetadata",
            "資料メタデータを読みます。",
            object([("sourceId", string())], &["sourceId"]),
        ),
        tool(
            "readGenreSourceSegment",
            "資料の指定セグメントを読みます。",
            object(
                [("sourceId", string()), ("segmentId", string())],
                &["sourceId", "segmentId"],
            ),
        ),
        tool(
            "searchGenreSourceText",
            "登録資料本文を検索します。",
            object(
                [
                    ("query", string()),
                    ("sourceIds", array(string())),
                    ("maxResults", integer()),
                ],
                &["query"],
            ),
        ),
        tool(
            "listGenreAnalyses",
            "資料の分析履歴を一覧します。",
            object([("sourceId", string())], &[]),
        ),
        tool(
            "readGenreAnalysis",
            "指定分析結果を読みます。",
            object([("analysisRunId", string())], &["analysisRunId"]),
        ),
        tool(
            "listGenreKnowledge",
            "採用済みジャンル知識を一覧します。",
            object([("category", string())], &[]),
        ),
        tool(
            "readGenreKnowledgeItem",
            "採用済み知識の全文を読みます。",
            object([("itemId", string())], &["itemId"]),
        ),
        tool(
            "listGenreKnowledgeCandidates",
            "未承認の知識候補を一覧します。",
            object([], &[]),
        ),
        tool(
            "proposeGenreKnowledgeItem",
            "新規知識を未承認候補として保存します。",
            object(
                [
                    ("category", enum_string(categories)),
                    ("title", string()),
                    ("statement", string()),
                    ("explanation", string()),
                    (
                        "proposedImportance",
                        enum_string(&["core", "frequent", "optional", "boundary", "work_specific"]),
                    ),
                    ("sourceSegmentIds", array(string())),
                ],
                &[
                    "category",
                    "title",
                    "statement",
                    "explanation",
                    "proposedImportance",
                ],
            ),
        ),
        tool(
            "proposeGenreKnowledgeUpdate",
            "既存知識の修正案を未承認候補として保存します。",
            object(
                [
                    ("targetKnowledgeItemId", string()),
                    ("proposedStatement", string()),
                    ("reason", string()),
                ],
                &["targetKnowledgeItemId", "proposedStatement", "reason"],
            ),
        ),
        tool(
            "proposeGenreKnowledgeDisable",
            "既存知識の無効化案を未承認候補として保存します。",
            object(
                [("targetKnowledgeItemId", string()), ("reason", string())],
                &["targetKnowledgeItemId", "reason"],
            ),
        ),
        tool(
            "proposeThreadSummary",
            "スレッド要約案を提示します（自動保存しません）。",
            object([("summary", string())], &["summary"]),
        ),
        tool(
            "proposeChatConclusions",
            "会話から合意済み結論を抽出するため全履歴を取得します。",
            object([], &[]),
        ),
    ]
}
fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({"name":name,"description":description,"inputSchema":input_schema})
}
fn object<const N: usize>(properties: [(&str, Value); N], required: &[&str]) -> Value {
    let properties = properties
        .into_iter()
        .map(|(key, value)| (key.into(), value))
        .collect::<Map<String, Value>>();
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}
fn string() -> Value {
    json!({"type":"string"})
}
fn integer() -> Value {
    json!({"type":"integer"})
}
fn boolean() -> Value {
    json!({"type":"boolean"})
}
fn array(items: Value) -> Value {
    json!({"type":"array","items":items})
}
fn enum_string(values: &[&str]) -> Value {
    json!({"type":"string","enum":values})
}

const GUIDANCE: &str = r#"

ジャンルチャット用ツール規則:
- 保存済み定義、知識、資料、分析について答える前に該当ツールで確認し、推測で補完しないでください。
- 採用済み知識はユーザーの現在の定義です。資料本文、分析、未承認候補、チャット上の発言を自動的に採用済み知識として扱わないでください。
- 資料からは抽象的で再利用可能な技法だけを扱い、固有の文章、人物、場面を別作品へコピーしないでください。
- 新しい結論は proposeGenreKnowledgeItem、修正は proposeGenreKnowledgeUpdate、無効化は proposeGenreKnowledgeDisable で未承認候補にしてください。ユーザーの承認なしに採用済み知識を直接変更してはいけません。
- updateGenreUserDefinition と updateGenreNotes は、ユーザーが保存を明示した場合だけ使用してください。保存する自然言語と最終回答は日本語にしてください。
"#;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn genre_tool_names_are_unique() {
        let tools = definitions();
        let mut names = tools
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect::<Vec<_>>();
        let count = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), count);
    }
    #[test]
    fn write_tool_requires_payload() {
        let tools = definitions();
        let tool = tools
            .iter()
            .find(|tool| tool["name"] == "updateGenreUserDefinition")
            .unwrap();
        assert_eq!(tool["inputSchema"]["required"], json!(["userDefinition"]));
        assert_eq!(tool["inputSchema"]["additionalProperties"], false);
    }
}
