use std::{cell::RefCell, rc::Rc};

use js_sys::Date;
use serde_json::{json, Map, Value};
use wasm_bindgen::JsValue;

use super::{boolean, string, tool};
use crate::{
    data::projects,
    runtime::{ai, tauri},
};

use super::super::{generation, State};

const NAMES: &[&str] = &[
    "continuePassage",
    "rewritePassage",
    "lineEditPassage",
    "checkConsistency",
    "listPassageProposals",
    "getPassageProposal",
    "applyPassageProposal",
];

pub fn handles(name: &str) -> bool {
    NAMES.contains(&name)
}

pub async fn execute(
    state: &Rc<RefCell<State>>,
    project_id: &str,
    current_episode: Option<&str>,
    name: &str,
    input: Value,
) -> Result<Value, JsValue> {
    let input = input.as_object().cloned().unwrap_or_default();
    match name {
        "continuePassage" => continue_passage(state, project_id, current_episode, &input).await,
        "rewritePassage" => rewrite_passage(state, &input).await,
        "lineEditPassage" => line_edit(state, &input).await,
        "checkConsistency" => consistency(state, project_id, current_episode, &input).await,
        "listPassageProposals" => {
            let include_applied = input
                .get("includeApplied")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let document = load_proposals(project_id).await?;
            let proposals = document["proposals"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|item| include_applied || item.get("appliedAt").is_none())
                .filter(|item| current_episode.is_none_or(|id| item["episodeId"] == id))
                .collect::<Vec<_>>();
            Ok(json!({"proposals":proposals}))
        }
        "getPassageProposal" => {
            let id = required(&input, "proposalId")?;
            let document = load_proposals(project_id).await?;
            let proposal = document["proposals"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|item| item["id"] == id)
                .cloned();
            Ok(proposal
                .map(|proposal| json!({"proposal":proposal}))
                .unwrap_or_else(|| json!({"error":"文章提案が見つかりません。"})))
        }
        "applyPassageProposal" => apply_proposal(state, project_id, &input).await,
        _ => Ok(json!({"error":format!("未知の執筆ツールです: {name}")})),
    }
}

async fn continue_passage(
    state: &Rc<RefCell<State>>,
    project_id: &str,
    current_episode: Option<&str>,
    input: &Map<String, Value>,
) -> Result<Value, JsValue> {
    let episode_id =
        current_episode.ok_or_else(|| JsValue::from_str("エピソードが選択されていません。"))?;
    let instruction = required(input, "instruction")?;
    let (settings, context) = {
        let current = state.borrow();
        (
            current.ai_settings.clone(),
            tail(&current.editor_text, 24_000),
        )
    };
    let generated =
        generation::continue_story_with_instruction(&settings, &context, instruction).await?;
    let proposal = json!({"id":tauri::random_uuid(),"episodeId":episode_id,"instruction":instruction,
        "generatedText":generated.text,"createdAt":now()});
    let mut document = load_proposals(project_id).await?;
    let items = ensure_proposals(&mut document);
    items.insert(0, proposal.clone());
    items.truncate(100);
    projects::write_document(project_id, "passage-proposals", &document).await?;
    Ok(
        json!({"success":true,"proposalId":proposal["id"],"generatedText":proposal["generatedText"],
        "provider":generated.provider,"model":generated.model}),
    )
}

async fn rewrite_passage(
    state: &Rc<RefCell<State>>,
    input: &Map<String, Value>,
) -> Result<Value, JsValue> {
    let passage = required(input, "targetText")?;
    let instruction = input
        .get("instruction")
        .and_then(Value::as_str)
        .unwrap_or("意味と事実を保って自然に書き直す");
    let (settings, context) = {
        let current = state.borrow();
        (
            current.ai_settings.clone(),
            format!(
                "{}\n\n作者指示: {instruction}",
                tail(&current.editor_text, 12_000)
            ),
        )
    };
    let generated = generation::rewrite_passage(&settings, &context, passage).await?;
    Ok(
        json!({"rewrittenText":generated.text,"provider":generated.provider,"model":generated.model}),
    )
}

async fn line_edit(
    state: &Rc<RefCell<State>>,
    input: &Map<String, Value>,
) -> Result<Value, JsValue> {
    let passage = required(input, "passageText")?;
    let instruction = input
        .get("instruction")
        .and_then(Value::as_str)
        .unwrap_or("具体的な修正案を作る");
    let context = {
        let current = state.borrow();
        tail(&current.editor_text, 12_000)
    };
    let review = ai::generate(
        "judgment",
        "あなたは日本語小説の厳密な編集者です。対象本文の問題を具体的に日本語で指摘してください。"
            .into(),
        format!("編集方針: {instruction}\n\n周辺本文:\n{context}\n\n対象本文:\n{passage}"),
    )
    .await?
    .text;
    let settings = state.borrow().ai_settings.clone();
    let revised = generation::rewrite_passage(
        &settings,
        &format!("{context}\n\n編集レビュー:\n{review}"),
        passage,
    )
    .await?;
    Ok(
        json!({"review":review,"proposals":[{"targetText":passage,"replacementText":revised.text,"reason":instruction}]}),
    )
}

async fn consistency(
    state: &Rc<RefCell<State>>,
    project_id: &str,
    current_episode: Option<&str>,
    input: &Map<String, Value>,
) -> Result<Value, JsValue> {
    let episode_id = input
        .get("episodeId")
        .and_then(Value::as_str)
        .or(current_episode)
        .ok_or_else(|| JsValue::from_str("episodeId は必須です。"))?;
    let focus = input.get("focus").and_then(Value::as_str).unwrap_or("全体");
    let text = {
        let current = state.borrow();
        if current.current_episode_id.as_deref() == Some(episode_id) {
            current.editor_text.clone()
        } else {
            let episode = current
                .episodes
                .iter()
                .find(|item| item.id == episode_id)
                .ok_or_else(|| JsValue::from_str("エピソードが見つかりません。"))?;
            projects::read_episode(project_id, &episode.file_name).await?
        }
    };
    let result=ai::generate("judgment","あなたは小説設定の整合性監査者です。本文にない事実を作らず、日本語で具体的に報告してください。".into(),
        format!("確認対象: {focus}\n\nエピソード本文:\n{}",tail(&text,30_000))).await?;
    Ok(json!({"success":true,"summary":result.text,"episodeId":episode_id,"focus":focus}))
}

async fn apply_proposal(
    state: &Rc<RefCell<State>>,
    project_id: &str,
    input: &Map<String, Value>,
) -> Result<Value, JsValue> {
    let id = required(input, "proposalId")?;
    let mut document = load_proposals(project_id).await?;
    let proposal = ensure_proposals(&mut document)
        .iter_mut()
        .find(|item| item["id"] == id)
        .ok_or_else(|| JsValue::from_str("文章提案が見つかりません。"))?;
    if proposal.get("appliedAt").is_some() {
        return Ok(json!({"error":"この文章提案は適用済みです。"}));
    }
    let episode_id = proposal["episodeId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    if state.borrow().current_episode_id.as_deref() != Some(&episode_id) {
        return Ok(json!({"error":"提案対象のエピソードを開いてから適用してください。"}));
    }
    let generated = proposal["generatedText"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    proposal["appliedAt"] = Value::String(now());
    let next_text = {
        let mut current = state.borrow_mut();
        if !current.editor_text.ends_with('\n') {
            current.editor_text.push('\n');
        }
        current.editor_text.push_str(generated.trim_start());
        current.editor_text.clone()
    };
    let file_name = state
        .borrow()
        .episodes
        .iter()
        .find(|item| item.id == episode_id)
        .map(|item| item.file_name.clone())
        .ok_or_else(|| JsValue::from_str("エピソードが見つかりません。"))?;
    projects::write_episode(project_id, &file_name, &next_text).await?;
    projects::write_document(project_id, "passage-proposals", &document).await?;
    Ok(json!({"success":true,"proposalId":id,"episodeId":episode_id}))
}

async fn load_proposals(project_id: &str) -> Result<Value, JsValue> {
    Ok(projects::read_document(project_id, "passage-proposals")
        .await?
        .unwrap_or_else(|| json!({"schemaVersion":1,"proposals":[]})))
}
fn ensure_proposals(document: &mut Value) -> &mut Vec<Value> {
    if !document.is_object() {
        *document = json!({"schemaVersion":1,"proposals":[]});
    }
    if !document["proposals"].is_array() {
        document["proposals"] = json!([]);
    }
    document["proposals"]
        .as_array_mut()
        .expect("array initialized")
}
fn required<'a>(input: &'a Map<String, Value>, key: &str) -> Result<&'a str, JsValue> {
    input
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| JsValue::from_str(&format!("{key} は必須です。")))
}
fn tail(text: &str, limit: usize) -> String {
    text.chars()
        .rev()
        .take(limit)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}
fn now() -> String {
    Date::new_0()
        .to_iso_string()
        .as_string()
        .unwrap_or_default()
}
fn object<const N: usize>(properties: [(&str, Value); N], required: &[&str]) -> Value {
    let properties = properties
        .into_iter()
        .map(|(k, v)| (k.into(), v))
        .collect::<Map<String, Value>>();
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}

pub fn definitions() -> Vec<Value> {
    vec![
        tool(
            "continuePassage",
            "専用の多段執筆設定で続き案を生成し、提案キャッシュへ保存します。",
            object([("instruction", string())], &["instruction"]),
        ),
        tool(
            "rewritePassage",
            "専用の執筆設定で対象本文の書き直し案を生成します。",
            object(
                [("targetText", string()), ("instruction", string())],
                &["targetText"],
            ),
        ),
        tool(
            "lineEditPassage",
            "判断モデルのレビューと執筆モデルによる具体的修正案を作ります。",
            object(
                [("passageText", string()), ("instruction", string())],
                &["passageText"],
            ),
        ),
        tool(
            "checkConsistency",
            "指定エピソードの設定・時系列・因果・人物状態の整合性を監査します。",
            object([("episodeId", string()), ("focus", string())], &[]),
        ),
        tool(
            "listPassageProposals",
            "未適用または全ての文章提案を一覧します。",
            object([("includeApplied", boolean())], &[]),
        ),
        tool(
            "getPassageProposal",
            "文章提案の全文を読みます。",
            object([("proposalId", string())], &["proposalId"]),
        ),
        tool(
            "applyPassageProposal",
            "文章提案を対象エピソード末尾へ適用して保存します。",
            object([("proposalId", string())], &["proposalId"]),
        ),
    ]
}
