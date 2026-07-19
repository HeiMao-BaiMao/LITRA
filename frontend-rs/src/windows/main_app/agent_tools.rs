use std::{cell::RefCell, rc::Rc};

use serde_json::{json, Map, Value};
use wasm_bindgen::JsValue;

use super::State;
use crate::{
    data::projects,
    runtime::{ai, invoke},
};

const MAX_TOOL_ROUNDS: usize = 16;

/// 重複するツール呼び出しを検出した場合に中断するためのしきい値
const MAX_DUPLICATE_CALLS: usize = 2;

mod genre;
mod project;
mod writing;

pub async fn run(
    state: &Rc<RefCell<State>>,
    mut system: String,
    prompt: String,
) -> Result<ai::GeneratedText, JsValue> {
    let definitions = definitions();
    let tool_names: Vec<&str> = definitions.iter().filter_map(|d| d["name"].as_str()).collect();
    system.push_str(&build_tool_guidance(&tool_names));
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
    // 直前のラウンドで同じツール+同じ引数での呼び出しを検出し、ループ暴走を防ぐ
    let mut recent_calls: Vec<(String, String)> = Vec::new();
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
        // 重複ツール呼び出し検出
        for call in &turn.tool_calls {
            let input_str = serde_json::to_string(&call.input).unwrap_or_default();
            let signature = (call.name.clone(), input_str);
            let duplicate_count = recent_calls
                .iter()
                .filter(|s| s.0 == signature.0 && s.1 == signature.1)
                .count();
            if duplicate_count >= MAX_DUPLICATE_CALLS {
                return Err(JsValue::from_str(&format!(
                    "AI tool loop aborted: tool '{}' called repeatedly with the same input (likely stuck)",
                    call.name
                )));
            }
        }
        recent_calls.extend(
            turn.tool_calls
                .iter()
                .map(|c| (c.name.clone(), serde_json::to_string(&c.input).unwrap_or_default())),
        );
        if recent_calls.len() > 8 {
            let drop_count = recent_calls.len() - 8;
            recent_calls.drain(0..drop_count);
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
    if writing::handles(name) {
        return writing::execute(state, project_id, current_episode, name, input).await;
    }
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
    definitions.extend(writing::definitions());
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

// ============================================================
//  ツールガイダンス — TS版 buildToolGuidancePrompt の移植
// ============================================================

/// 利用可能なツールに応じて動的にツールガイダンスを生成する。
/// TS版 `buildToolGuidancePrompt` の移植。
fn build_tool_guidance(tool_names: &[&str]) -> String {
    use std::collections::BTreeSet;
    let available: BTreeSet<&str> = tool_names.iter().copied().collect();
    let mut s = String::from(BASE_TOOL_GUIDANCE);

    // EPISODE TEXT EDITING — TS版の条件分岐を移植
    let has_episode_tools = available.contains("findEpisodeLines")
        || available.contains("getEpisodeLines")
        || available.contains("editEpisode")
        || available.contains("editEpisodeBatch");
    if has_episode_tools {
        s.push_str(r#"

EPISODE TEXT EDITING — follow in this order:
1. WHEN THE USER ASKS YOU TO WRITE FICTION: 「〜を書いて」「本文に追加して」「小説の続きを書いて」「物語を作って」「以下の内容を反映して」など、ユーザーが明示的に本文執筆・追記・編集を依頼した場合 → あなたは相談だけで終わらず、必ずツールを使って実際に本文に書き込むこと。執筆依頼をチャットの相談にすり替えてツールを呼ばないことは禁止。
2. Before editing, ALWAYS read the current text and line numbers with findEpisodeLines or getEpisodeLines. NEVER guess line numbers or current text from memory.
3. expectedText MUST be a character-for-character copy of the text you just read, with the line-number prefixes removed. Change nothing else in it.
4. replacementText must be Japanese, unless the user explicitly asked for another language.
5. IF the edit is one contiguous range → call editEpisode once. IF multiple separate ranges → collect ALL from the same pre-edit text and call editEpisodeBatch exactly once.
6. Do NOT ask for confirmation before a clearly requested edit. Ask first only when the target range or the change is ambiguous.
7. IF the tool reports an expectedText mismatch → re-read only the failed range, then retry with the latest exact text.
8. After a successful edit, report editSummary or editedLineRanges once. Do not print expectedText or replacementText unless asked.
9. reason is required on every edit. State the concrete problem this change fixes or the goal it achieves, in Japanese. NEVER write filler like 「より自然にするため」.
"#);
    }

    s
}

const BASE_TOOL_GUIDANCE: &str = r#"
TOOL USE — follow these steps in this exact order for every request:

STEP 1 — DECIDE:
- IF the request needs current application data or a data change (retrieve, search, verify, edit, save, update, create, delete, consistency check) AND a capable tool is listed below → you MUST actually call that tool.
- Writing a plan, a procedure, or tool arguments as plain text is NOT execution. A reply that only describes what should be done is an unfinished task.
- IF no tool is needed → answer directly and skip the remaining steps.

STEP 2 — READ BEFORE WRITE:
- Before changing data, first read the target's ID and current values with the matching list/get/search tool.
- NEVER invent or guess an ID. Use only IDs returned by a tool or given by the user.
- Do not repeat a read whose reliable result you already have in this run.

STEP 3 — WRITE EXACTLY ONCE:
- Change only what the user asked for. Nothing extra.
- Execute each change exactly once. After a write tool returns success, NEVER call the same write tool again with the same input.
- NEVER overwrite a value you do not know with a guess or an empty string.

STEP 4 — IF A CALL FAILS:
- NEVER report success for a failed call.
- State the cause briefly in Japanese. Then retry only the failed part. IF the same call fails twice with the same error → stop retrying and report the situation honestly in Japanese.

STEP 5 — REPORT AND STOP:
- When the tools that answer the request have succeeded, give exactly one short Japanese report. Then stop calling tools.
- In the report, use editSummary or editedLineRanges when provided. Do not restate expectedText, replacementText, or other raw tool arguments.

JAPANESE DATA CHECK — run before every create/update/save call:
1. Every natural-language field value MUST be Japanese. 保存する説明文・メモ・要約は必ず日本語で書くこと。IF a value is ordinary descriptive English → translate it into natural Japanese first.
2. Keep unchanged: IDs, field names, enum values, exact quotations, exact-match source text, code, URLs, filenames, and established foreign proper nouns.
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
