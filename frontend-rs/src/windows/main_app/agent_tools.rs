use std::{cell::RefCell, rc::Rc};

use serde_json::{json, Map, Value};
use wasm_bindgen::JsValue;

use super::State;
use crate::{
    data::projects,
    runtime::{ai, invoke},
};

const MAX_TOOL_ROUNDS: usize = 8;

mod genre;
mod project;

pub async fn run(
    state: &Rc<RefCell<State>>,
    mut system: String,
    prompt: String,
) -> Result<ai::GeneratedText, JsValue> {
    system.push_str(TOOL_GUIDANCE);
    let (project_id, current_episode, provider, model) = {
        let current = state.borrow();
        (
            current
                .current_project
                .as_ref()
                .map(|project| project.id.clone()),
            current.current_episode_id.clone(),
            current.selected_provider.clone(),
            current.selected_model.clone(),
        )
    };
    let Some(project_id) = project_id else {
        return ai::generate_with(
            "chat",
            system,
            prompt,
            provider.as_deref(),
            model.as_deref(),
        )
        .await;
    };
    let mut messages = vec![json!({"role":"user","content":prompt})];
    let definitions = definitions();
    for _ in 0..MAX_TOOL_ROUNDS {
        let turn = ai::agent_turn(
            "chat",
            system.clone(),
            messages.clone(),
            definitions.clone(),
            provider.as_deref(),
            model.as_deref(),
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
                "type":"tool-call",
                "toolCallId":call.id,
                "toolName":call.name,
                "input":call.input,
            }));
        }
        messages.push(json!({"role":"assistant","content":assistant_parts}));
        let mut results = Vec::new();
        for call in turn.tool_calls {
            let output = execute(
                state,
                &project_id,
                current_episode.as_deref(),
                &call.name,
                call.input,
            )
            .await
            .unwrap_or_else(|error| json!({"error":js_error(&error)}));
            results.push(json!({
                "type":"tool-result",
                "toolCallId":call.id,
                "toolName":call.name,
                "output":{"type":"json","value":output},
            }));
        }
        messages.push(json!({"role":"tool","content":results}));
    }
    Err(JsValue::from_str(
        "AI tool loop exceeded the maximum number of rounds",
    ))
}

async fn execute(
    state: &Rc<RefCell<State>>,
    project_id: &str,
    current_episode: Option<&str>,
    name: &str,
    input: Value,
) -> Result<Value, JsValue> {
    if genre::handles(name) {
        return genre::execute(name, input).await;
    }
    if project::handles(name) {
        return project::execute(state, project_id, current_episode, name, input).await;
    }
    let mut input = input.as_object().cloned().unwrap_or_default();
    let value: Value = match name {
        "listEpisodes" => {
            invoke::invoke(
                "list_episodes_with_summaries",
                &json!({"projectId":project_id}),
            )
            .await?
        }
        "rebuildSearchIndex" => {
            invoke::invoke("rebuild_search_index", &json!({"projectId":project_id})).await?
        }
        "webSearch" => invoke::invoke("web_search", &json!({"req":input.clone()})).await?,
        "webFetch" => invoke::invoke("web_fetch", &json!({"req":input.clone()})).await?,
        "saveEpisodeSummaryAndOneLiner" => {
            let episode_id = input.get("episodeId").cloned().unwrap_or(Value::Null);
            let content = input.get("content").cloned().unwrap_or(Value::Null);
            let one_liner = input.get("oneLiner").cloned().unwrap_or(Value::Null);
            invoke::invoke::<_, ()>(
                "save_episode_summary",
                &json!({"req":{"projectId":project_id,"episodeId":episode_id.clone(),"content":content}}),
            )
            .await?;
            invoke::invoke::<_, ()>(
                "save_episode_one_liner",
                &json!({"req":{"projectId":project_id,"episodeId":episode_id,"oneLiner":one_liner}}),
            )
            .await?;
            json!({"success":true})
        }
        command => {
            input.insert("projectId".into(), Value::String(project_id.into()));
            if matches!(
                name,
                "getEpisodeLines" | "findEpisodeLines" | "editEpisode" | "editEpisodeBatch"
            ) && input
                .get("episodeId")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            {
                if let Some(episode_id) = current_episode {
                    input.insert("episodeId".into(), Value::String(episode_id.into()));
                }
            }
            let command = match command {
                "retrieveEpisode" => "retrieve_episode_content",
                "searchEpisodes" => "search_episodes",
                "getEpisodeLines" => "get_episode_lines",
                "findEpisodeLines" => "find_episode_lines",
                "editEpisode" => "edit_episode_text",
                "editEpisodeBatch" => "edit_episode_text_batch",
                "getEditLog" => "get_edit_log",
                "saveEpisodeSummary" => "save_episode_summary",
                "saveEpisodeOneLiner" => "save_episode_one_liner",
                _ => return Ok(json!({"error":format!("Unknown tool: {name}")})),
            };
            invoke::invoke(command, &json!({"req":input})).await?
        }
    };
    if matches!(name, "editEpisode" | "editEpisodeBatch") {
        if let Some(text) = value.get("newText").and_then(Value::as_str) {
            if input.get("episodeId").and_then(Value::as_str) == current_episode {
                state.borrow_mut().editor_text = text.into();
            }
        }
        let _: Value = invoke::invoke("rebuild_search_index", &json!({"projectId":project_id}))
            .await
            .unwrap_or(Value::Null);
    }
    if matches!(
        name,
        "saveEpisodeSummary" | "saveEpisodeOneLiner" | "saveEpisodeSummaryAndOneLiner"
    ) {
        state.borrow_mut().summaries = projects::read_document(project_id, "summaries")
            .await?
            .unwrap_or_else(|| json!({"summaries":{}}));
    }
    Ok(value)
}

fn definitions() -> Vec<Value> {
    let mut definitions = vec![
        tool(
            "listEpisodes",
            "Lists episodes with IDs, order, titles and one-line summaries.",
            object([]),
        ),
        tool(
            "retrieveEpisode",
            "Retrieves an episode summary or full manuscript text.",
            object([
                ("episodeId", string()),
                ("contentType", enum_string(&["summary", "fullText"])),
            ]),
        ),
        tool(
            "searchEpisodes",
            "Searches project episodes and summaries.",
            object([("query", string()), ("limit", integer())]),
        ),
        tool(
            "rebuildSearchIndex",
            "Rebuilds the project search index when results are stale.",
            object([]),
        ),
        tool(
            "getEpisodeLines",
            "Reads exact episode text with one-based line numbers before editing.",
            object([
                ("episodeId", string()),
                ("startLine", integer()),
                ("endLine", integer()),
            ]),
        ),
        tool(
            "findEpisodeLines",
            "Finds exact matching lines and context in an episode.",
            object([
                ("episodeId", string()),
                ("query", string()),
                ("contextLines", integer()),
                ("maxMatches", integer()),
                ("caseSensitive", boolean()),
            ]),
        ),
        tool(
            "editEpisode",
            "Replaces an exact line range. Read lines first and copy expectedText exactly.",
            object([
                ("episodeId", string()),
                ("startLine", integer()),
                ("endLine", integer()),
                ("expectedText", string()),
                ("replacementText", string()),
                ("reason", string()),
            ]),
        ),
        tool(
            "editEpisodeBatch",
            "Atomically replaces multiple exact non-overlapping ranges.",
            json!({
                "type":"object",
                "properties":{
                    "episodeId":string(),
                    "edits":{"type":"array","items":object([
                        ("startLine",integer()),("endLine",integer()),("expectedText",string()),("replacementText",string()),("reason",string())
                    ])}
                }
            }),
        ),
        tool(
            "getEditLog",
            "Reads recent manuscript edit history and reasons.",
            object([("episodeId", string()), ("limit", integer())]),
        ),
        tool(
            "saveEpisodeSummary",
            "Saves a detailed episode summary.",
            object([("episodeId", string()), ("content", string())]),
        ),
        tool(
            "saveEpisodeOneLiner",
            "Saves a 30-80 Japanese character one-line episode summary.",
            object([("episodeId", string()), ("oneLiner", string())]),
        ),
        tool(
            "saveEpisodeSummaryAndOneLiner",
            "Saves the detailed and one-line episode summaries together.",
            object([
                ("episodeId", string()),
                ("content", string()),
                ("oneLiner", string()),
            ]),
        ),
        tool(
            "webSearch",
            "Searches the web for current factual information.",
            object([("query", string()), ("numResults", integer())]),
        ),
        tool(
            "webFetch",
            "Fetches readable content from a URL.",
            object([
                ("url", string()),
                ("format", enum_string(&["text", "markdown", "html"])),
            ]),
        ),
    ];
    definitions.extend(project::definitions());
    definitions.extend(genre::definitions());
    definitions
}

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({"name":name,"description":description,"inputSchema":input_schema})
}
fn object<const N: usize>(properties: [(&str, Value); N]) -> Value {
    let required = properties
        .iter()
        .map(|(key, _)| Value::String((*key).into()))
        .collect::<Vec<_>>();
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
fn enum_string(values: &[&str]) -> Value {
    json!({"type":"string","enum":values})
}
fn js_error(error: &JsValue) -> String {
    error.as_string().unwrap_or_else(|| format!("{error:?}"))
}

const TOOL_GUIDANCE: &str = r#"

利用可能なツールは、説明ではなく実際の操作に使ってください。ツール実行に失敗した操作を成功したと報告してはいけません。保存する自然言語、編集理由、最終回答は日本語にしてください。ただしID、列挙値、URL、ファイル名、本文からの完全一致引用は変更しません。

本文編集の規則:
1. 編集前に必ず getEpisodeLines または findEpisodeLines で最新本文と行番号を取得し、行番号を推測しないこと。
2. expectedText は取得した本文から行番号部分だけを除いた完全一致文字列にすること。
3. 連続した一範囲は editEpisode を一度だけ、離れた複数範囲は同じ編集前本文を基準に editEpisodeBatch を一度だけ使うこと。
4. expectedText 不一致時は失敗範囲だけを再取得して一度再試行すること。
5. reason には将来のセッションが意図を復元できる具体的な編集目的を書くこと。

過去話は、対象が不明なら listEpisodes または searchEpisodes で特定し、要旨で足りる場合は retrieveEpisode の summary、正確な文言が必要な場合だけ fullText を使ってください。検索結果が明らかに古い場合だけ rebuildSearchIndex を実行してください。編集履歴や過去の変更意図を問われた場合は getEditLog を使ってください。

要約の保存を依頼された場合は本文を確認してから saveEpisodeSummary または saveEpisodeOneLiner を必要な分だけ一度ずつ呼んでください。実在情報の調査・検証を依頼された場合は webSearch を使い、webFetch はユーザー指定または検索結果の実在URLだけに使ってください。物語内の設定をウェブで検索してはいけません。
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_schemas_reject_missing_or_unknown_arguments() {
        let tools = definitions();
        let edit = tools
            .iter()
            .find(|tool| tool["name"] == "editEpisode")
            .expect("editEpisode definition");
        let schema = &edit["inputSchema"];
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["required"].as_array().map(Vec::len), Some(6));
    }

    #[test]
    fn every_tool_name_is_unique() {
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
}
