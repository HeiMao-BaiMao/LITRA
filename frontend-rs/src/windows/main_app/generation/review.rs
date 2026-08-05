use serde::Deserialize;
use serde_json::{json, Value};
use wasm_bindgen::JsValue;

use crate::runtime::ai;

use super::{craft, old_prompts, prompts};

#[allow(clippy::too_many_arguments)]
pub async fn choose_draft(
    first: &str,
    second: &str,
    context: &str,
    settings_context: Option<&str>,
    plan: Option<&str>,
    scaffold: Option<&str>,
    instruction: Option<&str>,
) -> Result<bool, JsValue> {
    let result = ai::generate(
        "judgment",
        craft::system_with_principles(scaffold),
        prompts::select(
            first,
            second,
            context,
            settings_context,
            plan,
            scaffold,
            instruction,
        ),
    )
    .await?;
    Ok(old_prompts::parse_selection(&result.text, 2) == Some(1))
}

#[allow(clippy::too_many_arguments)]
pub async fn choose_candidate(
    first: &str,
    second: &str,
    task: &str,
    original: &str,
    context: &str,
    settings_context: Option<&str>,
    scaffold: Option<&str>,
) -> Result<bool, JsValue> {
    let result = ai::generate(
        "judgment",
        craft::system_with_principles(scaffold),
        prompts::candidate_selection(
            first,
            second,
            task,
            original,
            context,
            settings_context,
            scaffold,
        ),
    )
    .await?;
    Ok(old_prompts::parse_selection(&result.text, 2) == Some(1))
}

pub async fn inspect(
    context: &str,
    draft: &str,
    settings_context: Option<&str>,
    plan: Option<&str>,
    related_scenes: Option<&str>,
    extra_sections: &str,
    scaffold: Option<&str>,
) -> Result<String, JsValue> {
    ai::generate(
        "judgment",
        craft::system_with_principles(scaffold),
        prompts::review(
            context,
            draft,
            settings_context,
            plan,
            related_scenes,
            extra_sections,
        ),
    )
    .await
    .map(|result| result.text)
}

/// 文学目標カード付きの査読。カードの目指す読者効果を達成しているかを
/// 技術点検と並行して照合する(craft_review テンプレート)。
/// 出力の【総合判定】語彙は `inspect` と互換で、既存の改稿ゲートをそのまま通せる。
#[allow(clippy::too_many_arguments)]
pub async fn inspect_craft(
    context: &str,
    draft: &str,
    craft_card: &str,
    settings_context: Option<&str>,
    plan: Option<&str>,
    related_scenes: Option<&str>,
    extra_sections: &str,
    scaffold: Option<&str>,
) -> Result<String, JsValue> {
    ai::generate(
        "judgment",
        craft::system_with_principles(scaffold),
        craft::craft_review(
            context,
            draft,
            plan,
            (!craft_card.trim().is_empty()).then_some(craft_card),
            settings_context,
            related_scenes,
            extra_sections,
            scaffold,
        ),
    )
    .await
    .map(|result| result.text)
}

pub fn requires_revision(review: &str) -> bool {
    if let Some(verdict) = parse_verdict_json(review) {
        return !verdict_is_clean(&verdict);
    }

    let verdict = review.lines().map(str::trim).find(|line| {
        let lower = line.to_ascii_lowercase();
        line.starts_with("【総合判定】")
            || lower.starts_with("verdict")
            || lower.starts_with("decision")
    });
    let Some(verdict) = verdict else {
        return true;
    };
    !verdict_is_clean(verdict)
}

fn parse_verdict_json(review: &str) -> Option<String> {
    let trimmed = review.trim();
    let json_text = if trimmed.starts_with('{') {
        trimmed
    } else {
        let start = trimmed.find('{')?;
        let end = trimmed.rfind('}')?;
        trimmed.get(start..=end)?
    };
    let value: Value = serde_json::from_str(json_text).ok()?;
    let object = value.as_object()?;
    [
        "verdict",
        "decision",
        "status",
        "result",
        "判定",
        "総合判定",
    ]
    .iter()
    .find_map(|key| object.get(*key).and_then(Value::as_str).map(str::to_owned))
}

fn verdict_is_clean(verdict: &str) -> bool {
    let normalized = verdict.trim().to_ascii_lowercase();
    verdict.contains("問題なし")
        || verdict.contains("修正なしで採用可")
        || normalized.contains("no revision")
        || normalized.contains("no issue")
        || normalized == "pass"
        || normalized == "ok"
}

/// compare_revisions(craft) の構造化出力。overall が `"B"` のとき修正稿を採用する。
#[derive(Deserialize)]
struct CompareVerdict {
    #[serde(default)]
    overall: Option<String>,
}

#[allow(clippy::too_many_arguments)]
pub async fn prefer_revision(
    context: &str,
    original: &str,
    revised: &str,
    settings_context: Option<&str>,
    scaffold: Option<&str>,
    craft_compare: bool,
) -> Result<bool, JsValue> {
    if craft_compare {
        let verdict = crate::ai::structured_output::generate_structured_object::<CompareVerdict>(
            "judgment",
            Some(&craft::system_with_principles(scaffold)),
            &craft::compare_revisions(context, original, revised),
            json!({
                "type": "object",
                "properties": {
                    "overall": {"type": "string", "enum": ["A", "B", "tie"]},
                    "dimensions": {
                        "type": "object",
                        "properties": {
                            "canon": {"type": "string", "enum": ["A", "B", "tie"]},
                            "prose": {"type": "string", "enum": ["A", "B", "tie"]},
                            "structure": {"type": "string", "enum": ["A", "B", "tie"]},
                            "emotional": {"type": "string", "enum": ["A", "B", "tie"]}
                        },
                        "additionalProperties": false
                    },
                    "reason": {"type": "string"}
                },
                "required": ["overall", "reason"],
                "additionalProperties": false
            }),
            None,
            None,
        )
        .await;
        match verdict {
            Ok(verdict) => match verdict.overall.as_deref() {
                Some("B") => return Ok(true),
                Some("A") => return Ok(false),
                _ => {} // tie / 不明は既存の比較にフォールバック
            },
            Err(_) => {} // 構造化出力の失敗は既存の比較にフォールバック
        }
    }
    choose_candidate(
        original,
        revised,
        "査読に基づく修正稿",
        original,
        context,
        settings_context,
        scaffold,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::requires_revision;

    #[test]
    fn revision_is_skipped_only_for_explicit_clean_verdicts() {
        assert!(!requires_revision("【総合判定】問題なし"));
        assert!(!requires_revision("【総合判定】修正なしで採用可"));
        assert!(requires_revision("【総合判定】要修正"));
        assert!(requires_revision("形式外の応答"));
    }

    #[test]
    fn understands_structured_and_english_verdicts() {
        assert!(!requires_revision(r#"{"verdict":"pass"}"#));
        assert!(!requires_revision("Decision: no revision needed"));
        assert!(requires_revision(r#"{"decision":"revise"}"#));
    }
}
