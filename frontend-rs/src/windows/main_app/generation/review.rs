use serde_json::Value;
use wasm_bindgen::JsValue;

use crate::runtime::ai;

use super::{old_prompts, prompts};

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
        super::super::ai_actions::EDITORIAL_PARTNER_SYSTEM_PROMPT.into(),
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
        super::super::ai_actions::EDITORIAL_PARTNER_SYSTEM_PROMPT.into(),
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
) -> Result<String, JsValue> {
    ai::generate(
        "judgment",
        super::super::ai_actions::EDITORIAL_PARTNER_SYSTEM_PROMPT.into(),
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

pub async fn prefer_revision(
    context: &str,
    original: &str,
    revised: &str,
    settings_context: Option<&str>,
    scaffold: Option<&str>,
) -> Result<bool, JsValue> {
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
