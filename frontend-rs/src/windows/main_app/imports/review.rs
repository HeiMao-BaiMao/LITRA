use std::collections::HashMap;

use serde::Deserialize;
use serde_json::{json, Map, Value};
use wasm_bindgen::JsValue;

use crate::{
    ai::structured_output,
    data::{project_settings, projects},
    runtime::tauri,
};

use super::model::ImportResult;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Review {
    characters_to_update: Vec<Map<String, Value>>,
    world_entries_to_update: Vec<Map<String, Value>>,
    relationships_to_create: Vec<ReviewRelationship>,
    project_memos_to_create: Vec<ReviewMemo>,
    episode_memos_to_update: Vec<ReviewEpisodeMemo>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ReviewRelationship {
    episode_title: String,
    character_a_name: String,
    character_b_name: String,
    direction: String,
    description: String,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct ReviewMemo {
    title: String,
    content: String,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ReviewEpisodeMemo {
    episode_title: String,
    content: String,
}

#[derive(Default)]
pub struct ReviewResult {
    pub updated_characters: usize,
    pub updated_world_entries: usize,
    pub created_relationships: usize,
    pub created_project_memos: usize,
    pub updated_episode_memos: usize,
}

pub async fn review_and_fix(
    project_id: &str,
    imported: &ImportResult,
) -> Result<ReviewResult, JsValue> {
    let characters = project_settings::characters(project_id).await?;
    let world = project_settings::world(project_id).await?;
    let episodes = projects::list_episodes(project_id).await?;
    let relationships = projects::read_document(project_id, "relationships")
        .await?
        .unwrap_or_else(|| json!({"groups":[]}));
    let project_memos = project_settings::memos(project_id).await?;
    let episode_memos = projects::read_document(project_id, "memos")
        .await?
        .unwrap_or_else(|| json!({"memos":{}}));
    let snapshot = json!({
        "importResult": {
            "characters": imported.characters,
            "worldEntries": imported.world_entries,
            "episodes": imported.episodes,
            "memos": imported.memos,
            "projectMemos": imported.project_memos,
            "relationships": imported.relationships,
        },
        "characters": characters,
        "world": world,
        "episodes": episodes,
        "relationships": relationships,
        "projectMemos": project_memos,
        "episodeMemos": episode_memos,
    });
    let prompt = format!(
        r#"フォルダ取り込み直後のプロジェクトを整合性チェックしてください。
明確な根拠がある修正だけを返し、推測で設定を追加しないでください。
自然言語の保存値は日本語にしてください。ID と固有名詞を維持してください。

次の JSON オブジェクトだけを返してください:
{{"charactersToUpdate":[],"worldEntriesToUpdate":[],"relationshipsToCreate":[],"projectMemosToCreate":[],"episodeMemosToUpdate":[]}}

charactersToUpdate/worldEntriesToUpdate は id と変更フィールドを含む部分オブジェクトです。
relationshipsToCreate は episodeTitle, characterAName, characterBName, direction, description を含みます。
direction は a-to-b, b-to-a, mutual のいずれかです。
projectMemosToCreate は title, content、episodeMemosToUpdate は episodeTitle, content を含みます。
重複人物の空欄補完、明確に欠落した関係・メモのみ修正してください。

<project_snapshot>
{}
</project_snapshot>"#,
        limit(
            &serde_json::to_string_pretty(&snapshot).unwrap_or_default(),
            80_000
        )
    );
    let review: Review = structured_output::generate_structured_object(
        "judgment",
        Some("You review imported creative-writing data. Return only necessary corrections, as structured JSON that follows the schema exactly. Keep IDs and enum values unchanged. Write every natural-language value that will be persisted in Japanese. 保存する説明文は必ず日本語で書くこと。"),
        &prompt,
        review_schema(),
        None,
        None,
    )
    .await?;
    apply(
        project_id,
        review,
        characters,
        episodes,
        relationships,
        episode_memos,
    )
    .await
}

fn review_schema() -> Value {
    let partial = json!({"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":true});
    json!({"type":"object","properties":{
        "charactersToUpdate":{"type":"array","items":partial.clone()},
        "worldEntriesToUpdate":{"type":"array","items":partial},
        "relationshipsToCreate":{"type":"array","items":{"type":"object","properties":{
            "episodeTitle":{"type":"string"},"characterAName":{"type":"string"},"characterBName":{"type":"string"},
            "direction":{"type":"string","enum":["a-to-b","b-to-a","mutual"]},"description":{"type":"string"}
        },"required":["episodeTitle","characterAName","characterBName","direction","description"],"additionalProperties":false}},
        "projectMemosToCreate":{"type":"array","items":{"type":"object","properties":{"title":{"type":"string"},"content":{"type":"string"}},"required":["title","content"],"additionalProperties":false}},
        "episodeMemosToUpdate":{"type":"array","items":{"type":"object","properties":{"episodeTitle":{"type":"string"},"content":{"type":"string"}},"required":["episodeTitle","content"],"additionalProperties":false}}
    },"required":["charactersToUpdate","worldEntriesToUpdate","relationshipsToCreate","projectMemosToCreate","episodeMemosToUpdate"],"additionalProperties":false})
}

async fn apply(
    project_id: &str,
    review: Review,
    characters: Value,
    episodes: Vec<projects::Episode>,
    mut relationships: Value,
    mut episode_memos: Value,
) -> Result<ReviewResult, JsValue> {
    let mut result = ReviewResult::default();
    for update in review.characters_to_update {
        if update.get("id").and_then(Value::as_str).is_some() {
            project_settings::update_character(project_id, &Value::Object(update)).await?;
            result.updated_characters += 1;
        }
    }
    for update in review.world_entries_to_update {
        if update.get("id").and_then(Value::as_str).is_some() {
            project_settings::update_world(project_id, &Value::Object(update)).await?;
            result.updated_world_entries += 1;
        }
    }
    let name_to_id = character_names(&characters);
    let episode_to_id = episodes
        .iter()
        .map(|episode| (normalize(&episode.title), episode.id.clone()))
        .collect::<HashMap<_, _>>();
    if let Some(groups) = relationships
        .get_mut("groups")
        .and_then(Value::as_array_mut)
    {
        for relationship in review.relationships_to_create {
            let (Some(a), Some(b)) = (
                name_to_id.get(&normalize(&relationship.character_a_name)),
                name_to_id.get(&normalize(&relationship.character_b_name)),
            ) else {
                continue;
            };
            if a == b || relationship.description.trim().is_empty() {
                continue;
            }
            let episode_id = episode_to_id
                .get(&normalize(&relationship.episode_title))
                .cloned()
                .unwrap_or_default();
            let group_index = groups
                .iter()
                .position(|group| {
                    group.get("episodeId").and_then(Value::as_str) == Some(&episode_id)
                })
                .unwrap_or_else(|| {
                    groups.push(json!({"episodeId":episode_id,"relationships":[]}));
                    groups.len() - 1
                });
            if let Some(items) = groups[group_index]
                .get_mut("relationships")
                .and_then(Value::as_array_mut)
            {
                items.push(json!({
                    "id": tauri::random_uuid(),
                    "characterAId": a,
                    "characterBId": b,
                    "direction": direction(&relationship.direction),
                    "description": relationship.description,
                }));
                result.created_relationships += 1;
            }
        }
    }
    if result.created_relationships > 0 {
        projects::write_document(project_id, "relationships", &relationships).await?;
    }
    for memo in review.project_memos_to_create {
        if memo.title.trim().is_empty() || memo.content.trim().is_empty() {
            continue;
        }
        let created = project_settings::create_memo(project_id, &memo.title).await?;
        if let Some(id) = created.get("id").and_then(Value::as_str) {
            project_settings::update_memo(project_id, id, None, Some(&memo.content)).await?;
            result.created_project_memos += 1;
        }
    }
    if let Some(memos) = episode_memos
        .get_mut("memos")
        .and_then(Value::as_object_mut)
    {
        for memo in review.episode_memos_to_update {
            let Some(id) = episode_to_id.get(&normalize(&memo.episode_title)) else {
                continue;
            };
            memos.insert(
                id.clone(),
                json!({"content":memo.content,"updatedAt":js_sys::Date::new_0().to_iso_string().as_string().unwrap_or_default()}),
            );
            result.updated_episode_memos += 1;
        }
    }
    if result.updated_episode_memos > 0 {
        projects::write_document(project_id, "memos", &episode_memos).await?;
    }
    Ok(result)
}

fn character_names(characters: &Value) -> HashMap<String, String> {
    let mut result = HashMap::new();
    for character in characters
        .get("characters")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(id) = character.get("id").and_then(Value::as_str) else {
            continue;
        };
        for field in ["name", "reading", "alias"] {
            if let Some(value) = character.get(field).and_then(Value::as_str) {
                for name in value.split(['、', ',', '/', '／']) {
                    let key = normalize(name);
                    if !key.is_empty() {
                        result.insert(key, id.into());
                    }
                }
            }
        }
    }
    result
}

fn normalize(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .replace([' ', '　', '・', '-', '_'], "")
}
fn direction(value: &str) -> &'static str {
    match value.trim().to_lowercase().as_str() {
        "a-to-b" => "a-to-b",
        "b-to-a" => "b-to-a",
        _ => "mutual",
    }
}
fn limit(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}
