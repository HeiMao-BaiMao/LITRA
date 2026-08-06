//! `checkCommonSense` ツール: 本文を現実世界の一般常識と照合する監査。
//!
//! チャットモデル(特に直接執筆モード)が editEpisode で本文を書いた後、
//! エージェントが自ら呼ぶ。多段パイプラインの常識監査
//! (commonSenseAuditEnabled)が届かない経路の誤りを塞ぐ。

use std::{cell::RefCell, rc::Rc};

use serde_json::{json, Map, Value};
use wasm_bindgen::JsValue;

use super::super::{generation, prompt_context, State};
use crate::{
    ai::structured_output,
    runtime::ai,
};

const NAMES: &[&str] = &["checkCommonSense"];

pub fn handles(name: &str) -> bool {
    NAMES.contains(&name)
}

pub fn definitions() -> Vec<Value> {
    use super::{object_with_required, string, tool};
    vec![tool(
        "checkCommonSense",
        "本文の現実整合性(一般常識)を監査する: 学校制度・暦・季節・時系列・因果・社会通念と矛盾する記述を行番号付きで指摘し、最小の修正方針を返す。",
        object_with_required([("passage", string())], &["passage"]),
    )]
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
        "checkCommonSense" => {
            check(state, project_id, current_episode, &input, on_progress).await
        }
        _ => Ok(json!({"error": format!("未知の監査ツールです: {name}")})),
    }
}

async fn check(
    state: &Rc<RefCell<State>>,
    project_id: &str,
    current_episode: Option<&str>,
    input: &Map<String, Value>,
    on_progress: &mut dyn FnMut(&str),
) -> Result<Value, JsValue> {
    let passage = required(input, "passage")?;
    // 現在のエピソード本文の末尾を文脈として渡す(continuePassage と同じスライス予算)。
    let writing_defaults = ai::role_defaults("writing").await.ok();
    let slice_chars = prompt_context::context_slice_chars(
        writing_defaults
            .as_ref()
            .and_then(|value| value.max_context_tokens),
    );
    let (settings, context) = {
        let current = state.borrow();
        let context = prompt_context::tail_chars(&current.editor_text, slice_chars);
        (current.ai_settings.clone(), context)
    };
    let settings_context = {
        let current = state.borrow();
        let value = prompt_context::build_settings_context(&current, &settings);
        (!value.trim().is_empty()).then_some(value)
    };
    let _ = project_id;
    let _ = current_episode;
    on_progress("一般常識と照合中");
    let result = structured_output::generate_structured_object::<Value>(
        "judgment",
        Some(&generation::common_sense::audit_system()),
        &generation::common_sense::audit(&context, passage, settings_context.as_deref()),
        generation::common_sense::common_sense_schema(),
        None,
        None,
    )
    .await;
    let value = match result {
        Ok(value) => value,
        Err(error) => {
            let message = error
                .as_string()
                .unwrap_or_else(|| "AIからの応答が空でした。".into());
            return Ok(json!({
                "success": false,
                "message": "常識監査に失敗しました。",
                "error": message,
            }));
        }
    };
    let findings = value
        .get("findings")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let summary = value
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    Ok(json!({
        "success": true,
        "message": if findings.is_empty() {
            "常識との矛盾は確認できませんでした。".to_string()
        } else {
            format!("常識との矛盾を{}件指摘しました。", findings.len())
        },
        "findings": findings,
        "summary": summary,
    }))
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
        assert_eq!(names, vec!["checkCommonSense"]);
        for name in names {
            assert!(handles(name), "handles() が {name} を漏らしている");
        }
        assert!(!handles("editEpisode"));
    }

    #[test]
    fn check_common_sense_requires_passage() {
        let definitions = definitions();
        let tool = &definitions[0];
        assert_eq!(tool["name"], "checkCommonSense");
        assert_eq!(tool["inputSchema"]["required"], json!(["passage"]));
        assert_eq!(tool["inputSchema"]["additionalProperties"], false);
    }
}
