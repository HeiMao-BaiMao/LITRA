//! 小説原理(craft)を基にしたチャットツール。
//!
//! - `craftAdvice`: 作劇相談。小説原理と場面の文脈から診断・選択肢・推奨を返す。
//! - `recordCraftNote`: 執筆セッションの記録から再利用可能な技法の教訓を抽出し、
//!   プロジェクト文書 `craft-notes` に保存する。
//! - `getCraftNotes`: 保存済みの技法ノートを一覧する。
//!
//! 技法ノートは将来のセッションの参照データとして使う(編集ログと同じ思想)。
//! 保存するのは技法であり、正史・設定・プロットの事実は対象外。

use std::{cell::RefCell, rc::Rc};

use serde_json::{json, Map, Value};
use wasm_bindgen::JsValue;

use super::super::{generation, prompt_context, State};
use crate::{
    ai::structured_output,
    data::projects,
    runtime::ai,
};

const NAMES: &[&str] = &["craftAdvice", "recordCraftNote", "getCraftNotes"];
/// 技法ノートの保存上限(この件数を超えると新しいノートは捨てられる)。
const MAX_NOTES: usize = 100;

pub fn handles(name: &str) -> bool {
    NAMES.contains(&name)
}

pub fn definitions() -> Vec<Value> {
    use super::{object, object_with_required, string, tool};
    vec![
        tool(
            "craftAdvice",
            "作劇相談: 行き詰まった展開・場面・文体・構成の相談に、小説原理に基づく診断・選択肢(効果とリスク)・推奨を返す。",
            object_with_required([("consultation", string())], &["consultation"]),
        ),
        tool(
            "recordCraftNote",
            "執筆セッションから技法の教訓(効いた処理・失敗・この作品の声)を抽出し、プロジェクトの技法ノートに保存する。record には実際に何が起きたか(書いた内容、査読の指摘、採用・不採用、ユーザーの反応)を具体的に書く。",
            object_with_required([("record", string())], &["record"]),
        ),
        tool(
            "getCraftNotes",
            "保存済みの技法ノートを一覧する。",
            object([]),
        ),
    ]
}

pub async fn execute(
    state: &Rc<RefCell<State>>,
    project_id: &str,
    current_episode: Option<&str>,
    name: &str,
    input: Value,
    on_progress: &mut dyn FnMut(&str),
) -> Result<Value, JsValue> {
    let input = input.as_object().cloned().unwrap_or_default();
    match name {
        "craftAdvice" => craft_advice(state, current_episode, &input, on_progress).await,
        "recordCraftNote" => record_craft_note(project_id, &input).await,
        "getCraftNotes" => get_craft_notes(project_id).await,
        _ => Ok(json!({"error": format!("未知の作劇ツールです: {name}")})),
    }
}

async fn craft_advice(
    state: &Rc<RefCell<State>>,
    current_episode: Option<&str>,
    input: &Map<String, Value>,
    on_progress: &mut dyn FnMut(&str),
) -> Result<Value, JsValue> {
    let consultation = required(input, "consultation")?;
    // 現在のエピソード本文の末尾を相談の文脈として渡す(continuePassage と同じ
    // スライス予算。コンテキスト上限が取れなければ 24,000 字)。
    let writing_defaults = ai::role_defaults("writing").await.ok();
    let slice_chars = prompt_context::context_slice_chars(
        writing_defaults
            .as_ref()
            .and_then(|value| value.max_context_tokens),
        24_000,
    );
    let (settings, context) = {
        let current = state.borrow();
        let context = prompt_context::tail_chars(&current.editor_text, slice_chars);
        (current.ai_settings.clone(), context)
    };
    let scaffold = generation::judgment_scaffold(&settings);
    let settings_context = {
        let current = state.borrow();
        let value = prompt_context::build_settings_context(&current, &settings);
        (!value.trim().is_empty()).then_some(value)
    };
    let _ = current_episode;
    on_progress("小説原理に照らして回答を検討中");
    let result = ai::generate(
        "judgment",
        generation::craft::system_with_principles(scaffold),
        generation::craft::craft_advice(
            &context,
            consultation,
            settings_context.as_deref(),
            scaffold,
        ),
    )
    .await?;
    Ok(json!({
        "success": true,
        "message": "作劇相談への回答を生成しました。",
        "advice": result.text,
        "model": result.model,
    }))
}

async fn record_craft_note(
    project_id: &str,
    input: &Map<String, Value>,
) -> Result<Value, JsValue> {
    let record = required(input, "record")?;
    let document = load_notes(project_id).await?;
    let existing = document["notes"].as_array().cloned().unwrap_or_default();
    let existing_text = if existing.is_empty() {
        None
    } else {
        Some(
            existing
                .iter()
                .filter_map(|note| {
                    let title = note.get("title").and_then(Value::as_str).unwrap_or("?");
                    let statement = note.get("statement").and_then(Value::as_str).unwrap_or("");
                    Some(format!("- {title}: {statement}"))
                })
                .collect::<Vec<_>>()
                .join("\n"),
        )
    };
    let extracted = structured_output::generate_structured_object::<Value>(
        "judgment",
        Some(&generation::craft::full_system()),
        &generation::craft::record_craft_note(record, existing_text.as_deref()),
        record_craft_note_schema(),
        None,
        None,
    )
    .await?;
    let notes = extracted
        .get("notes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if notes.is_empty() {
        return Ok(json!({
            "success": true,
            "message": "保存する技法ノートはありませんでした。",
            "saved": 0,
            "notes": existing,
        }));
    }
    let mut merged = existing.clone();
    for note in notes {
        if merged.len() >= MAX_NOTES {
            break;
        }
        merged.push(note);
    }
    let saved = merged.len().saturating_sub(existing.len());
    projects::write_document(project_id, "craft-notes", &json!({"notes": merged})).await?;
    Ok(json!({
        "success": true,
        "message": format!("技法ノートを{saved}件保存しました。"),
        "saved": saved,
        "notes": merged,
    }))
}

async fn get_craft_notes(project_id: &str) -> Result<Value, JsValue> {
    let document = load_notes(project_id).await?;
    let notes = document["notes"].as_array().cloned().unwrap_or_default();
    Ok(json!({"success": true, "notes": notes}))
}

async fn load_notes(project_id: &str) -> Result<Value, JsValue> {
    Ok(
        projects::read_document(project_id, "craft-notes")
            .await?
            .unwrap_or_else(|| json!({"notes": []})),
    )
}

fn record_craft_note_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "notes": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "statement": {"type": "string"},
                        "category": {
                            "type": "string",
                            "enum": ["technique", "failure", "voice"]
                        },
                        "evidence": {"type": "string"},
                        "confidence": {
                            "type": "string",
                            "enum": ["adopted-and-praised", "adopted", "flagged-once"]
                        }
                    },
                    "required": ["title", "statement", "category", "evidence", "confidence"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["notes"],
        "additionalProperties": false
    })
}

fn required<'a>(input: &'a Map<String, Value>, key: &str) -> Result<&'a str, JsValue> {
    input
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| JsValue::from_str(&format!("{key} は必須です。")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_names_are_unique_and_handled() {
        let definitions = definitions();
        let names = definitions
            .iter()
            .filter_map(|definition| definition["name"].as_str())
            .collect::<Vec<_>>();
        let unique = names.iter().collect::<std::collections::HashSet<_>>();
        assert_eq!(names.len(), unique.len());
        for name in names {
            assert!(handles(name), "handles() が {name} を漏らしている");
        }
        assert!(!handles("editEpisode"));
    }

    #[test]
    fn craft_advice_requires_consultation() {
        let definitions = definitions();
        let tool = definitions
            .iter()
            .find(|definition| definition["name"] == "craftAdvice")
            .unwrap();
        assert_eq!(
            tool["inputSchema"]["required"],
            json!(["consultation"])
        );
        assert_eq!(tool["inputSchema"]["additionalProperties"], false);
    }

    #[test]
    fn record_craft_note_schema_matches_prompt_contract() {
        let schema = record_craft_note_schema();
        assert_eq!(
            schema["properties"]["notes"]["items"]["properties"]["category"]["enum"],
            json!(["technique", "failure", "voice"])
        );
        assert_eq!(
            schema["properties"]["notes"]["items"]["properties"]["confidence"]["enum"],
            json!(["adopted-and-praised", "adopted", "flagged-once"])
        );
    }
}
