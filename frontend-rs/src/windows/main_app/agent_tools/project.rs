use std::{cell::RefCell, rc::Rc};

use serde_json::{json, Map, Value};
use wasm_bindgen::JsValue;

use super::{boolean, enum_string, integer, string, tool};
use crate::{
    data::projects,
    runtime::{invoke, tauri},
};

use super::super::State;

const NAMES: &[&str] = &[
    "listCharacters",
    "createCharacter",
    "updateCharacter",
    "listWorldEntries",
    "createWorldEntry",
    "updateWorldEntry",
    "listRelationships",
    "createRelationship",
    "updateRelationship",
    "deleteRelationship",
    "listEpisodeMemos",
    "getEpisodeMemo",
    "saveEpisodeMemo",
    "listProjectMemos",
    "getProjectMemo",
    "createProjectMemo",
    "updateProjectMemo",
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
    let mut input = input.as_object().cloned().unwrap_or_default();
    match name {
        "listCharacters" => Ok(json!({"characters":state.borrow().characters.clone()})),
        "createCharacter" => {
            input.insert("projectId".into(), Value::String(project_id.into()));
            let value: Value = invoke::invoke("create_character", &json!({"req":input})).await?;
            refresh_characters(state, &value);
            Ok(value)
        }
        "updateCharacter" => {
            let id = take_required(&mut input, "characterId")?;
            let value: Value = invoke::invoke(
                "update_character",
                &json!({"req":{"projectId":project_id,"characterId":id,"updates":input}}),
            )
            .await?;
            refresh_characters(state, &value);
            Ok(value)
        }
        "listWorldEntries" => Ok(json!({"entries":state.borrow().world_entries.clone()})),
        "createWorldEntry" => {
            input.insert("projectId".into(), Value::String(project_id.into()));
            let value: Value = invoke::invoke("create_world_entry", &json!({"req":input})).await?;
            refresh_world(state, &value);
            Ok(value)
        }
        "updateWorldEntry" => {
            let id = take_required(&mut input, "entryId")?;
            let value: Value = invoke::invoke(
                "update_world_entry",
                &json!({"req":{"projectId":project_id,"entryId":id,"updates":input}}),
            )
            .await?;
            refresh_world(state, &value);
            Ok(value)
        }
        "listRelationships" => Ok(state.borrow().relationships.clone()),
        "createRelationship" => relationship_create(state, project_id, input).await,
        "updateRelationship" => relationship_update(state, project_id, input).await,
        "deleteRelationship" => relationship_delete(state, project_id, input).await,
        "listEpisodeMemos" => Ok(state.borrow().memos.clone()),
        "getEpisodeMemo" => {
            let id = input
                .get("episodeId")
                .and_then(Value::as_str)
                .or(current_episode)
                .ok_or_else(|| JsValue::from_str("episodeId は必須です。"))?;
            Ok(json!({"episodeId":id,"content":memo_content(&state.borrow().memos,id)}))
        }
        "saveEpisodeMemo" => {
            let id = input
                .get("episodeId")
                .and_then(Value::as_str)
                .or(current_episode)
                .ok_or_else(|| JsValue::from_str("episodeId は必須です。"))?
                .to_owned();
            let content = required(&input, "content")?.to_owned();
            let next = {
                let mut current = state.borrow_mut();
                set_memo(&mut current.memos, &id, content);
                current.memos.clone()
            };
            projects::write_document(project_id, "memos", &next).await?;
            Ok(json!({"success":true,"episodeId":id}))
        }
        "listProjectMemos" => Ok(json!({"memos":state.borrow().project_memos.clone()})),
        "getProjectMemo" => {
            let id = required(&input, "memoId")?;
            let memo = state
                .borrow()
                .project_memos
                .iter()
                .find(|memo| memo["id"] == id)
                .cloned();
            Ok(memo
                .map(|memo| json!({"memo":memo}))
                .unwrap_or_else(|| json!({"error":"プロジェクトメモが見つかりません。"})))
        }
        "createProjectMemo" => {
            let value: Value = invoke::invoke(
                "create_project_memo",
                &json!({"req":{"projectId":project_id,"title":required(&input,"title")?}}),
            )
            .await?;
            state.borrow_mut().project_memos.push(value.clone());
            Ok(value)
        }
        "updateProjectMemo" => {
            let id = take_required(&mut input, "memoId")?;
            let value: Value = invoke::invoke(
                "update_project_memo",
                &json!({"req":{"projectId":project_id,"memoId":id.clone(),
                    "title":input.get("title"),"content":input.get("content")}}),
            )
            .await?;
            let mut current = state.borrow_mut();
            if let Some(position) = current
                .project_memos
                .iter()
                .position(|memo| memo["id"] == id)
            {
                current.project_memos[position] = value.clone();
            }
            Ok(value)
        }
        _ => Ok(json!({"error":format!("未知のプロジェクトツールです: {name}")})),
    }
}

fn refresh_characters(state: &Rc<RefCell<State>>, value: &Value) {
    state.borrow_mut().characters = value["characters"].as_array().cloned().unwrap_or_default();
}
fn refresh_world(state: &Rc<RefCell<State>>, value: &Value) {
    state.borrow_mut().world_entries = value["entries"].as_array().cloned().unwrap_or_default();
}

async fn relationship_create(
    state: &Rc<RefCell<State>>,
    project_id: &str,
    mut input: Map<String, Value>,
) -> Result<Value, JsValue> {
    input.insert("id".into(), Value::String(tauri::random_uuid()));
    let created = Value::Object(input);
    let next = {
        let mut current = state.borrow_mut();
        let relationships = ensure_array(&mut current.relationships, "relationships");
        relationships.push(created.clone());
        current.relationships.clone()
    };
    projects::write_document(project_id, "relationships", &next).await?;
    Ok(created)
}

async fn relationship_update(
    state: &Rc<RefCell<State>>,
    project_id: &str,
    mut input: Map<String, Value>,
) -> Result<Value, JsValue> {
    let id = take_required(&mut input, "relationshipId")?;
    let updated = {
        let mut current = state.borrow_mut();
        let items = ensure_array(&mut current.relationships, "relationships");
        let target = items
            .iter_mut()
            .find(|item| item["id"] == id)
            .ok_or_else(|| JsValue::from_str("関係設定が見つかりません。"))?;
        let object = target
            .as_object_mut()
            .ok_or_else(|| JsValue::from_str("関係設定が不正です。"))?;
        object.extend(input);
        target.clone()
    };
    let next = state.borrow().relationships.clone();
    projects::write_document(project_id, "relationships", &next).await?;
    Ok(updated)
}

async fn relationship_delete(
    state: &Rc<RefCell<State>>,
    project_id: &str,
    input: Map<String, Value>,
) -> Result<Value, JsValue> {
    let id = required(&input, "relationshipId")?;
    let next = {
        let mut current = state.borrow_mut();
        ensure_array(&mut current.relationships, "relationships").retain(|item| item["id"] != id);
        current.relationships.clone()
    };
    projects::write_document(project_id, "relationships", &next).await?;
    Ok(json!({"success":true,"relationshipId":id}))
}

fn ensure_array<'a>(document: &'a mut Value, key: &str) -> &'a mut Vec<Value> {
    if !document.is_object() {
        *document = json!({});
    }
    if !document[key].is_array() {
        document[key] = json!([]);
    }
    document[key].as_array_mut().expect("array initialized")
}
fn memo_content(document: &Value, episode_id: &str) -> String {
    document
        .get("memos")
        .and_then(|memos| memos.get(episode_id))
        .and_then(|memo| {
            memo.as_str()
                .or_else(|| memo.get("content").and_then(Value::as_str))
        })
        .unwrap_or_default()
        .to_owned()
}
fn set_memo(document: &mut Value, episode_id: &str, content: String) {
    if !document.is_object() {
        *document = json!({"memos":{}});
    }
    if !document["memos"].is_object() {
        document["memos"] = json!({});
    }
    document["memos"][episode_id] = Value::String(content);
}
fn required<'a>(input: &'a Map<String, Value>, key: &str) -> Result<&'a str, JsValue> {
    input
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| JsValue::from_str(&format!("{key} は必須です。")))
}
fn take_required(input: &mut Map<String, Value>, key: &str) -> Result<String, JsValue> {
    input
        .remove(key)
        .and_then(|value| value.as_str().map(str::to_owned))
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| JsValue::from_str(&format!("{key} は必須です。")))
}

fn object<const N: usize>(properties: [(&str, Value); N], required: &[&str]) -> Value {
    let properties = properties
        .into_iter()
        .map(|(key, value)| (key.into(), value))
        .collect::<Map<String, Value>>();
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}
fn array(items: Value) -> Value {
    json!({"type":"array","items":items})
}

pub fn definitions() -> Vec<Value> {
    vec![
        tool(
            "listCharacters",
            "登場人物設定を一覧します。",
            object([], &[]),
        ),
        tool(
            "createCharacter",
            "新しい人物設定を作成します。",
            object(
                [
                    ("name", string()),
                    ("reading", string()),
                    ("alias", string()),
                ],
                &["name"],
            ),
        ),
        tool(
            "updateCharacter",
            "既存人物の指定項目だけを更新します。",
            object(
                [
                    ("characterId", string()),
                    ("name", string()),
                    ("reading", string()),
                    ("alias", string()),
                    ("role", string()),
                    ("gender", string()),
                    ("age", string()),
                    ("appearance", string()),
                    ("personality", string()),
                    ("notes", string()),
                    ("customFields", array(json!({"type":"object"}))),
                ],
                &["characterId"],
            ),
        ),
        tool(
            "listWorldEntries",
            "世界観設定を一覧します。",
            object([], &[]),
        ),
        tool(
            "createWorldEntry",
            "新しい世界観設定を作成します。",
            object(
                [("name", string()), ("category", string())],
                &["name", "category"],
            ),
        ),
        tool(
            "updateWorldEntry",
            "既存世界観の指定項目だけを更新します。",
            object(
                [
                    ("entryId", string()),
                    ("name", string()),
                    ("category", string()),
                    ("era", string()),
                    ("geography", string()),
                    ("climate", string()),
                    ("politics", string()),
                    ("culture", string()),
                    ("history", string()),
                    ("technology", string()),
                    ("notes", string()),
                    ("customFields", array(json!({"type":"object"}))),
                ],
                &["entryId"],
            ),
        ),
        tool(
            "listRelationships",
            "人物関係を一覧します。",
            object([], &[]),
        ),
        tool(
            "createRelationship",
            "人物関係を作成します。",
            relationship_schema(&["characterAId", "characterBId", "direction", "description"]),
        ),
        tool(
            "updateRelationship",
            "人物関係を更新します。",
            relationship_schema(&["relationshipId"]),
        ),
        tool(
            "deleteRelationship",
            "人物関係を削除します。",
            object([("relationshipId", string())], &["relationshipId"]),
        ),
        tool(
            "listEpisodeMemos",
            "各エピソードのメモを一覧します。",
            object([], &[]),
        ),
        tool(
            "getEpisodeMemo",
            "指定エピソードのメモを読みます。",
            object([("episodeId", string())], &[]),
        ),
        tool(
            "saveEpisodeMemo",
            "指定エピソードのメモを保存します。",
            object(
                [("episodeId", string()), ("content", string())],
                &["content"],
            ),
        ),
        tool(
            "listProjectMemos",
            "プロジェクトメモを一覧します。",
            object([], &[]),
        ),
        tool(
            "getProjectMemo",
            "プロジェクトメモを読みます。",
            object([("memoId", string())], &["memoId"]),
        ),
        tool(
            "createProjectMemo",
            "プロジェクトメモを作成します。",
            object([("title", string())], &["title"]),
        ),
        tool(
            "updateProjectMemo",
            "プロジェクトメモを更新します。",
            object(
                [
                    ("memoId", string()),
                    ("title", string()),
                    ("content", string()),
                ],
                &["memoId"],
            ),
        ),
    ]
}

fn relationship_schema(required: &[&str]) -> Value {
    object(
        [
            ("relationshipId", string()),
            ("characterAId", string()),
            ("characterBId", string()),
            ("direction", enum_string(&["a-to-b", "b-to-a", "mutual"])),
            ("description", string()),
            ("notes", string()),
            ("active", boolean()),
            ("order", integer()),
        ],
        required,
    )
}
