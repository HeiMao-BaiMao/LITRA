use serde::Serialize;
use serde_json::Value;
use wasm_bindgen::JsValue;

use crate::runtime::invoke;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectArgs<'a> {
    project_id: &'a str,
}
#[derive(Serialize)]
struct ReqArg<T> {
    req: T,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateCharacter<'a> {
    project_id: &'a str,
    name: &'a str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCharacter<'a> {
    project_id: &'a str,
    character_id: &'a str,
    updates: &'a serde_json::Map<String, Value>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteCharacter<'a> {
    project_id: &'a str,
    character_id: &'a str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateWorld<'a> {
    project_id: &'a str,
    name: &'a str,
    category: &'a str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateWorld<'a> {
    project_id: &'a str,
    entry_id: &'a str,
    updates: &'a serde_json::Map<String, Value>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteWorld<'a> {
    project_id: &'a str,
    entry_id: &'a str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoCreate<'a> {
    project_id: &'a str,
    title: &'a str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoUpdate<'a> {
    project_id: &'a str,
    memo_id: &'a str,
    title: Option<&'a str>,
    content: Option<&'a str>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoDelete<'a> {
    project_id: &'a str,
    memo_id: &'a str,
}

pub async fn characters(project_id: &str) -> Result<Value, JsValue> {
    invoke::invoke("list_characters", &ProjectArgs { project_id }).await
}
pub async fn create_character(project_id: &str, name: &str) -> Result<Value, JsValue> {
    invoke::invoke(
        "create_character",
        &ReqArg {
            req: CreateCharacter { project_id, name },
        },
    )
    .await
}
pub async fn update_character(project_id: &str, value: &Value) -> Result<Value, JsValue> {
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| JsValue::from_str("character ID missing"))?;
    let updates = value
        .as_object()
        .ok_or_else(|| JsValue::from_str("character invalid"))?;
    invoke::invoke(
        "update_character",
        &ReqArg {
            req: UpdateCharacter {
                project_id,
                character_id: id,
                updates,
            },
        },
    )
    .await
}
pub async fn delete_character(project_id: &str, character_id: &str) -> Result<Value, JsValue> {
    invoke::invoke(
        "delete_character",
        &ReqArg {
            req: DeleteCharacter {
                project_id,
                character_id,
            },
        },
    )
    .await
}
pub async fn world(project_id: &str) -> Result<Value, JsValue> {
    invoke::invoke("list_world_entries", &ProjectArgs { project_id }).await
}
pub async fn create_world(project_id: &str, name: &str, category: &str) -> Result<Value, JsValue> {
    invoke::invoke(
        "create_world_entry",
        &ReqArg {
            req: CreateWorld {
                project_id,
                name,
                category,
            },
        },
    )
    .await
}
pub async fn update_world(project_id: &str, value: &Value) -> Result<Value, JsValue> {
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| JsValue::from_str("world ID missing"))?;
    let updates = value
        .as_object()
        .ok_or_else(|| JsValue::from_str("world invalid"))?;
    invoke::invoke(
        "update_world_entry",
        &ReqArg {
            req: UpdateWorld {
                project_id,
                entry_id: id,
                updates,
            },
        },
    )
    .await
}
pub async fn delete_world(project_id: &str, entry_id: &str) -> Result<Value, JsValue> {
    invoke::invoke(
        "delete_world_entry",
        &ReqArg {
            req: DeleteWorld {
                project_id,
                entry_id,
            },
        },
    )
    .await
}
pub async fn memos(project_id: &str) -> Result<Vec<Value>, JsValue> {
    invoke::invoke("list_project_memos", &ProjectArgs { project_id }).await
}
pub async fn create_memo(project_id: &str, title: &str) -> Result<Value, JsValue> {
    invoke::invoke(
        "create_project_memo",
        &ReqArg {
            req: MemoCreate { project_id, title },
        },
    )
    .await
}
pub async fn update_memo(
    project_id: &str,
    memo_id: &str,
    title: Option<&str>,
    content: Option<&str>,
) -> Result<Value, JsValue> {
    invoke::invoke(
        "update_project_memo",
        &ReqArg {
            req: MemoUpdate {
                project_id,
                memo_id,
                title,
                content,
            },
        },
    )
    .await
}
pub async fn delete_memo(project_id: &str, memo_id: &str) -> Result<(), JsValue> {
    invoke::invoke(
        "delete_project_memo",
        &ReqArg {
            req: MemoDelete {
                project_id,
                memo_id,
            },
        },
    )
    .await
}
