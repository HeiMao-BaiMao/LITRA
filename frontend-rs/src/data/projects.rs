use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use wasm_bindgen::JsValue;

use crate::runtime::invoke;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub title: String,
    pub updated_at: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Episode {
    pub id: String,
    pub title: String,
    pub order: usize,
    pub file_name: String,
}

#[derive(Serialize)]
struct Empty {}
#[derive(Serialize)]
struct TitleArgs<'a> {
    title: &'a str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectArgs<'a> {
    project_id: &'a str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EpisodeFileArgs<'a> {
    project_id: &'a str,
    file_name: &'a str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EpisodeWriteArgs<'a> {
    project_id: &'a str,
    file_name: &'a str,
    content: &'a str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EpisodeIdArgs<'a> {
    project_id: &'a str,
    episode_id: &'a str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EpisodeCreateArgs<'a> {
    project_id: &'a str,
    title: &'a str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EpisodeTitleArgs<'a> {
    project_id: &'a str,
    episode_id: &'a str,
    title: &'a str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReorderArgs<'a> {
    project_id: &'a str,
    ordered_ids: &'a [String],
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentArgs<'a> {
    project_id: &'a str,
    kind: &'a str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentWriteArgs<'a> {
    project_id: &'a str,
    kind: &'a str,
    value: &'a Value,
}

async fn call<A: Serialize, R: DeserializeOwned>(command: &str, args: &A) -> Result<R, JsValue> {
    invoke::invoke(command, args).await
}

pub async fn list() -> Result<Vec<ProjectSummary>, JsValue> {
    call("project_list", &Empty {}).await
}
pub async fn create(title: &str) -> Result<Project, JsValue> {
    call("project_create", &TitleArgs { title }).await
}
pub async fn load(project_id: &str) -> Result<Project, JsValue> {
    call("project_load", &ProjectArgs { project_id }).await
}
pub async fn remove(project_id: &str) -> Result<(), JsValue> {
    call("project_delete", &ProjectArgs { project_id }).await
}
pub async fn list_episodes(project_id: &str) -> Result<Vec<Episode>, JsValue> {
    call("project_list_episodes", &ProjectArgs { project_id }).await
}
pub async fn create_episode(project_id: &str, title: &str) -> Result<Episode, JsValue> {
    call(
        "project_create_episode",
        &EpisodeCreateArgs { project_id, title },
    )
    .await
}
pub async fn read_episode(project_id: &str, file_name: &str) -> Result<String, JsValue> {
    call(
        "project_read_episode",
        &EpisodeFileArgs {
            project_id,
            file_name,
        },
    )
    .await
}
pub async fn write_episode(
    project_id: &str,
    file_name: &str,
    content: &str,
) -> Result<(), JsValue> {
    call(
        "project_write_episode",
        &EpisodeWriteArgs {
            project_id,
            file_name,
            content,
        },
    )
    .await
}
pub async fn update_episode_title(
    project_id: &str,
    episode_id: &str,
    title: &str,
) -> Result<(), JsValue> {
    call(
        "project_update_episode_title",
        &EpisodeTitleArgs {
            project_id,
            episode_id,
            title,
        },
    )
    .await
}
pub async fn remove_episode(project_id: &str, episode_id: &str) -> Result<(), JsValue> {
    call(
        "project_delete_episode",
        &EpisodeIdArgs {
            project_id,
            episode_id,
        },
    )
    .await
}
pub async fn reorder_episodes(project_id: &str, ordered_ids: &[String]) -> Result<(), JsValue> {
    call(
        "project_reorder_episodes",
        &ReorderArgs {
            project_id,
            ordered_ids,
        },
    )
    .await
}
pub async fn read_document(project_id: &str, kind: &str) -> Result<Option<Value>, JsValue> {
    call("project_read_document", &DocumentArgs { project_id, kind }).await
}
pub async fn write_document(project_id: &str, kind: &str, value: &Value) -> Result<(), JsValue> {
    call(
        "project_write_document",
        &DocumentWriteArgs {
            project_id,
            kind,
            value,
        },
    )
    .await
}
