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
    let verdict = review
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with("【総合判定】"));
    let Some(verdict) = verdict else {
        return true;
    };
    !(verdict.contains("問題なし") || verdict.contains("修正なしで採用可"))
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
}
