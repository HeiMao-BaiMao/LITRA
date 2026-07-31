use std::{cell::RefCell, rc::Rc};

use serde_json::{json, Map, Value};
use wasm_bindgen::JsValue;

use super::{enum_string, string, tool};
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
        "listCharacters" => {
            let value: Value = invoke::invoke(
                "list_characters",
                &json!({"projectId":project_id}),
            )
            .await?;
            refresh_characters(state, &value);
            Ok(value)
        }
        "createCharacter" => {
            let name = required(&input, "name")?.to_owned();
            input.insert("projectId".into(), Value::String(project_id.into()));
            let value: Value = invoke::invoke("create_character", &json!({"req":input})).await?;
            refresh_characters(state, &value);
            let character = value
                .get("characters")
                .and_then(Value::as_array)
                .and_then(|characters| {
                    characters
                        .iter()
                        .rev()
                        .find(|character| character["name"].as_str() == Some(name.as_str()))
                })
                .cloned();
            Ok(json!({
                "success": true,
                "message": format!("キャラクター「{name}」を作成しました。"),
                "character": character,
            }))
        }
        "updateCharacter" => {
            let id = take_required(&mut input, "characterId")?;
            let updates = input
                .remove("updates")
                .and_then(|value| value.as_object().cloned())
                .unwrap_or(input);
            let value: Value = invoke::invoke(
                "update_character",
                &json!({"req":{"projectId":project_id,"characterId":id,"updates":updates}}),
            )
            .await?;
            refresh_characters(state, &value);
            let character = value
                .get("characters")
                .and_then(Value::as_array)
                .and_then(|characters| characters.iter().find(|character| character["id"] == id))
                .cloned();
            Ok(json!({
                "success": true,
                "message": "キャラクター設定を更新しました。",
                "character": character,
            }))
        }
        "listWorldEntries" => {
            let value: Value = invoke::invoke(
                "list_world_entries",
                &json!({"projectId":project_id}),
            )
            .await?;
            refresh_world(state, &value);
            Ok(value)
        }
        "createWorldEntry" => {
            let name = required(&input, "name")?.to_owned();
            input.insert("projectId".into(), Value::String(project_id.into()));
            let value: Value = invoke::invoke("create_world_entry", &json!({"req":input})).await?;
            refresh_world(state, &value);
            let entry = value
                .get("entries")
                .and_then(Value::as_array)
                .and_then(|entries| {
                    entries
                        .iter()
                        .rev()
                        .find(|entry| entry["name"].as_str() == Some(name.as_str()))
                })
                .cloned();
            Ok(json!({
                "success": true,
                "message": format!("世界観「{name}」を作成しました。"),
                "entry": entry,
            }))
        }
        "updateWorldEntry" => {
            let id = take_required(&mut input, "entryId")?;
            let updates = input
                .remove("updates")
                .and_then(|value| value.as_object().cloned())
                .unwrap_or(input);
            let value: Value = invoke::invoke(
                "update_world_entry",
                &json!({"req":{"projectId":project_id,"entryId":id,"updates":updates}}),
            )
            .await?;
            refresh_world(state, &value);
            let entry = value
                .get("entries")
                .and_then(Value::as_array)
                .and_then(|entries| entries.iter().find(|entry| entry["id"] == id))
                .cloned();
            Ok(json!({
                "success": true,
                "message": "世界観設定を更新しました。",
                "entry": entry,
            }))
        }
        "listRelationships" => {
            let relationships = projects::read_document(project_id, "relationships")
                .await?
                .unwrap_or_else(|| json!({"groups":[]}));
            let normalized = {
                let mut current = state.borrow_mut();
                current.relationships = relationships;
                ensure_groups(&mut current.relationships);
                current.relationships.clone()
            };
            projects::write_document(project_id, "relationships", &normalized).await?;
            Ok(json!({"relationships":format_relationships_for_ai(state)}))
        }
        "createRelationship" => relationship_create(state, project_id, input).await,
        "updateRelationship" => relationship_update(state, project_id, input).await,
        "deleteRelationship" => relationship_delete(state, project_id, input).await,
        "listEpisodeMemos" => {
            let memos = projects::read_document(project_id, "memos")
                .await?
                .unwrap_or_else(|| json!({"memos":{}}));
            state.borrow_mut().memos = memos.clone();
            let current = state.borrow();
            let items = current
                .episodes
                .iter()
                .filter_map(|episode| {
                    let content = memo_content(&memos, &episode.id);
                    (!content.is_empty()).then(|| {
                        json!({
                            "episodeId": episode.id,
                            "title": if episode.title.is_empty() { "（無題）" } else { episode.title.as_str() },
                            "preview": limit_chars(&content, 240),
                        })
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({"count":items.len(),"memos":items}))
        }
        "getEpisodeMemo" => {
            let id = input
                .get("episodeId")
                .and_then(Value::as_str)
                .or(current_episode)
                .ok_or_else(|| JsValue::from_str("episodeId は必須です。"))?;
            let (title, content) = {
                let current = state.borrow();
                (
                    current
                        .episodes
                        .iter()
                        .find(|episode| episode.id == id)
                        .map(|episode| episode.title.clone())
                        .filter(|title| !title.is_empty())
                        .unwrap_or_else(|| "（無題）".into()),
                    memo_content(&current.memos, id),
                )
            };
            Ok(json!({
                "episodeId":id,
                "title":title,
                "content":limit_chars(&content, 12_000),
            }))
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
            Ok(json!({
                "success": true,
                "message": "覚え書きを保存しました。",
                "episodeId": id,
            }))
        }
        "listProjectMemos" => {
            let value: Value = invoke::invoke(
                "list_project_memos",
                &json!({"projectId":project_id}),
            )
            .await?;
            let memos = value.as_array().cloned().unwrap_or_default();
            state.borrow_mut().project_memos = memos.clone();
            let items = memos
                .iter()
                .map(|memo| {
                    json!({
                        "id": memo.get("id").cloned().unwrap_or(Value::Null),
                        "title": memo
                            .get("title")
                            .and_then(Value::as_str)
                            .filter(|title| !title.is_empty())
                            .unwrap_or("（無題）"),
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({"count":items.len(),"memos":items}))
        }
        "getProjectMemo" => {
            let id = required(&input, "memoId")?;
            let memos: Vec<Value> = invoke::invoke(
                "list_project_memos",
                &json!({"projectId":project_id}),
            )
            .await?;
            state.borrow_mut().project_memos = memos.clone();
            let memo = memos
                .iter()
                .find(|memo| memo.get("id").and_then(Value::as_str) == Some(id))
                .cloned();
            Ok(memo
                .map(|memo| {
                    json!({
                        "id": memo["id"].clone(),
                        "title": memo
                            .get("title")
                            .and_then(Value::as_str)
                            .filter(|title| !title.is_empty())
                            .unwrap_or("（無題）"),
                        "content": limit_chars(memo.get("content").and_then(Value::as_str).unwrap_or_default(), 12_000),
                    })
                })
                .unwrap_or_else(|| json!({"error":"プロジェクトメモが見つかりません。"})))
        }
        "createProjectMemo" => {
            let value: Value = invoke::invoke(
                "create_project_memo",
                &json!({"req":{"projectId":project_id,"title":required(&input,"title")?}}),
            )
            .await?;
            let memos: Vec<Value> = invoke::invoke(
                "list_project_memos",
                &json!({"projectId":project_id}),
            )
            .await?;
            state.borrow_mut().project_memos = memos.clone();
            let memo = memos
                .iter()
                .find(|memo| memo["id"] == value["id"])
                .cloned()
                .unwrap_or(value);
            Ok(json!({
                "success": true,
                "message": format!("作品メモ「{}」を作成しました。", memo["title"].as_str().unwrap_or_default()),
                "memo": memo,
            }))
        }
        "updateProjectMemo" => {
            let id = take_required(&mut input, "memoId")?;
            if !input.contains_key("title") && !input.contains_key("content") {
                return Ok(json!({"error":"title または content のいずれかを指定してください。"}));
            }
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
            Ok(json!({
                "success": true,
                "message": "作品メモを更新しました。",
                "memo": value,
            }))
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
    let episode_id = input
        .remove("episodeId")
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default();
    let character_a_id = take_required(&mut input, "characterAId")?;
    let character_b_id = take_required(&mut input, "characterBId")?;
    if character_a_id == character_b_id {
        return Err(JsValue::from_str(
            "同じキャラクター同士の関係は登録できません。",
        ));
    }
    let direction = take_required(&mut input, "direction")?;
    if !matches!(direction.as_str(), "a-to-b" | "b-to-a" | "mutual") {
        return Err(JsValue::from_str("direction が不正です。"));
    }
    let description = take_required(&mut input, "description")?;
    let created = json!({
        "id": tauri::random_uuid(),
        "characterAId": character_a_id,
        "characterBId": character_b_id,
        "direction": direction,
        "description": description,
    });
    let next = {
        let mut current = state.borrow_mut();
        let groups = ensure_groups(&mut current.relationships);
        let group = groups
            .iter_mut()
            .find(|group| group.get("episodeId").and_then(Value::as_str) == Some(&episode_id));
        let group = match group {
            Some(group) => group,
            None => {
                groups.push(json!({"episodeId":episode_id,"relationships":[]}));
                groups.last_mut().expect("group was inserted")
            }
        };
        ensure_array(group, "relationships").push(created.clone());
        current.relationships.clone()
    };
    projects::write_document(project_id, "relationships", &next).await?;
    Ok(json!({
        "success": true,
        "message": "人間関係を作成しました。",
        "relationship": created,
    }))
}

async fn relationship_update(
    state: &Rc<RefCell<State>>,
    project_id: &str,
    mut input: Map<String, Value>,
) -> Result<Value, JsValue> {
    let id = take_required(&mut input, "relationshipId")?;
    let updates = input
        .remove("updates")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or(input);
    let updated = {
        let mut current = state.borrow_mut();
        let groups = ensure_groups(&mut current.relationships);
        let target = groups
            .iter_mut()
            .filter_map(|group| group.get_mut("relationships").and_then(Value::as_array_mut))
            .flatten()
            .find(|item| item["id"] == id)
            .ok_or_else(|| JsValue::from_str("関係設定が見つかりません。"))?;
        let object = target
            .as_object_mut()
            .ok_or_else(|| JsValue::from_str("関係設定が不正です。"))?;
        for key in ["characterAId", "characterBId", "direction", "description"] {
            if let Some(value) = updates.get(key) {
                object.insert(key.into(), value.clone());
            }
        }
        if object.get("characterAId") == object.get("characterBId") {
            return Err(JsValue::from_str(
                "同じキャラクター同士の関係にはできません。",
            ));
        }
        if let Some(direction) = object.get("direction").and_then(Value::as_str) {
            if !matches!(direction, "a-to-b" | "b-to-a" | "mutual") {
                return Err(JsValue::from_str("direction が不正です。"));
            }
        }
        target.clone()
    };
    let next = state.borrow().relationships.clone();
    projects::write_document(project_id, "relationships", &next).await?;
    Ok(json!({
        "success": true,
        "message": "人間関係を更新しました。",
        "relationship": updated,
    }))
}

async fn relationship_delete(
    state: &Rc<RefCell<State>>,
    project_id: &str,
    input: Map<String, Value>,
) -> Result<Value, JsValue> {
    let id = required(&input, "relationshipId")?;
    let next = {
        let mut current = state.borrow_mut();
        let groups = ensure_groups(&mut current.relationships);
        for group in groups.iter_mut() {
            ensure_array(group, "relationships").retain(|item| item["id"] != id);
        }
        groups.retain(|group| {
            group
                .get("relationships")
                .and_then(Value::as_array)
                .is_some_and(|relationships| !relationships.is_empty())
        });
        current.relationships.clone()
    };
    projects::write_document(project_id, "relationships", &next).await?;
    Ok(json!({
        "success": true,
        "message": "人間関係を削除しました。",
        "relationshipId": id,
    }))
}

fn ensure_groups(document: &mut Value) -> &mut Vec<Value> {
    if !document.is_object() {
        *document = json!({});
    }
    if !document["groups"].is_array() {
        let legacy = document
            .get_mut("relationships")
            .map(Value::take)
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default();
        let mut groups = Vec::<Value>::new();
        for mut relationship in legacy {
            let episode_id = relationship
                .get("episodeId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            if let Some(object) = relationship.as_object_mut() {
                object.remove("episodeId");
            }
            let group = groups
                .iter_mut()
                .find(|group| group.get("episodeId").and_then(Value::as_str) == Some(&episode_id));
            if let Some(group) = group {
                ensure_array(group, "relationships").push(relationship);
            } else {
                groups.push(json!({"episodeId":episode_id,"relationships":[relationship]}));
            }
        }
        document["groups"] = Value::Array(groups);
    }
    document["groups"].as_array_mut().expect("groups initialized")
}

fn format_relationships_for_ai(state: &Rc<RefCell<State>>) -> String {
    let current = state.borrow();
    current
        .relationships
        .get("groups")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|group| {
            let episode_id = group
                .get("episodeId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let episode_title = if episode_id.is_empty() {
                "全体（全話共通）"
            } else {
                current
                    .episodes
                    .iter()
                    .find(|episode| episode.id == episode_id)
                    .map(|episode| episode.title.as_str())
                    .unwrap_or("（不明）")
            };
            let relationships = group
                .get("relationships")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|relationship| {
                    let character_name = |key: &str| {
                        relationship
                            .get(key)
                            .and_then(Value::as_str)
                            .and_then(|id| current.characters.iter().find(|item| item["id"] == id))
                            .and_then(|character| character["name"].as_str())
                            .unwrap_or("（不明）")
                    };
                    let arrow = match relationship
                        .get("direction")
                        .and_then(Value::as_str)
                    {
                        Some("a-to-b") => "→",
                        Some("b-to-a") => "←",
                        _ => "↔",
                    };
                    format!(
                        "  - {}: {} {} {} / {}",
                        relationship.get("id").and_then(Value::as_str).unwrap_or("?"),
                        character_name("characterAId"),
                        arrow,
                        character_name("characterBId"),
                        relationship
                            .get("description")
                            .and_then(Value::as_str)
                            .filter(|value| !value.is_empty())
                            .unwrap_or("（説明なし）")
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            format!("■ {episode_title}\n{relationships}")
        })
        .collect::<Vec<_>>()
        .join("\n\n")
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
fn limit_chars(text: &str, limit: usize) -> String {
    let mut value = text.chars().take(limit).collect::<String>();
    if text.chars().count() > limit {
        value.push_str("…（後略）");
    }
    value
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
                    (
                        "updates",
                        json!({"type":"object","additionalProperties":true}),
                    ),
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
                    (
                        "updates",
                        json!({"type":"object","additionalProperties":true}),
                    ),
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
            relationship_create_schema(),
        ),
        tool(
            "updateRelationship",
            "人物関係を更新します。",
            relationship_update_schema(),
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
            object([("episodeId", string())], &["episodeId"]),
        ),
        tool(
            "saveEpisodeMemo",
            "指定エピソードのメモを保存します。",
            object(
                [("episodeId", string()), ("content", string())],
                &["episodeId", "content"],
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

fn relationship_create_schema() -> Value {
    object(
        [
            ("episodeId", string()),
            ("characterAId", string()),
            ("characterBId", string()),
            ("direction", enum_string(&["a-to-b", "b-to-a", "mutual"])),
            ("description", string()),
        ],
        &[
            "episodeId",
            "characterAId",
            "characterBId",
            "direction",
            "description",
        ],
    )
}
fn relationship_update_schema() -> Value {
    object(
        [
            ("relationshipId", string()),
            (
                "updates",
                object(
                    [
                        ("characterAId", string()),
                        ("characterBId", string()),
                        ("direction", enum_string(&["a-to-b", "b-to-a", "mutual"])),
                        ("description", string()),
                    ],
                    &[],
                ),
            ),
        ],
        &["relationshipId"],
    )
}

#[cfg(test)]
mod tests {
    use super::ensure_groups;
    use serde_json::json;

    #[test]
    fn migrates_legacy_relationship_array_into_episode_groups() {
        let mut document = json!({
            "relationships": [
                {"id":"r1","episodeId":"episode-1","characterAId":"a","characterBId":"b"},
                {"id":"r2","episodeId":"episode-1","characterAId":"b","characterBId":"c"},
                {"id":"r3","episodeId":"","characterAId":"a","characterBId":"c"}
            ]
        });
        let groups = ensure_groups(&mut document);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0]["relationships"].as_array().map(Vec::len), Some(2));
        assert_eq!(groups[0]["relationships"][0].get("episodeId"), None);
    }
}
