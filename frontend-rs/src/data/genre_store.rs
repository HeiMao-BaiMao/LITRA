use serde::Serialize;
use wasm_bindgen::JsValue;

use crate::runtime::invoke;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PathArgs<'a> {
    genre_id: &'a str,
    relative_path: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteArgs<'a> {
    genre_id: &'a str,
    relative_path: &'a str,
    content: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoveArgs<'a> {
    genre_id: &'a str,
    relative_path: &'a str,
    recursive: Option<bool>,
}

#[derive(Serialize)]
struct IndexWriteArgs<'a> {
    content: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GenreArgs<'a> {
    genre_id: &'a str,
}

pub async fn read_index() -> Result<Option<String>, JsValue> {
    invoke::invoke("genre_read_index", &()).await
}

pub async fn write_index(content: &str) -> Result<(), JsValue> {
    invoke::invoke("genre_write_index", &IndexWriteArgs { content }).await
}

pub async fn remove_genre(genre_id: &str) -> Result<(), JsValue> {
    invoke::invoke("genre_remove", &GenreArgs { genre_id }).await
}

pub async fn read_text(genre_id: &str, relative_path: &str) -> Result<Option<String>, JsValue> {
    invoke::invoke(
        "genre_read_text",
        &PathArgs {
            genre_id,
            relative_path,
        },
    )
    .await
}

pub async fn write_text(genre_id: &str, relative_path: &str, content: &str) -> Result<(), JsValue> {
    invoke::invoke(
        "genre_write_text",
        &WriteArgs {
            genre_id,
            relative_path,
            content,
        },
    )
    .await
}

pub async fn remove_path(
    genre_id: &str,
    relative_path: &str,
    recursive: bool,
) -> Result<(), JsValue> {
    invoke::invoke(
        "genre_remove_path",
        &RemoveArgs {
            genre_id,
            relative_path,
            recursive: Some(recursive),
        },
    )
    .await
}
