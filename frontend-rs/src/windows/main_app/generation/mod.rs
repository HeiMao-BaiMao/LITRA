mod prompts;
mod review;

use serde_json::Value;
use wasm_bindgen::JsValue;

use crate::runtime::ai;

pub async fn continue_story(settings: &Value, context: &str) -> Result<ai::GeneratedText, JsValue> {
    let scene = if enabled(settings, "continuationSceneStateEnabled") {
        optional_judgment(
            "あなたは小説の連続性を管理する編集者です。",
            prompts::scene_state(context),
        )
        .await
    } else {
        String::new()
    };
    let voices = if enabled(settings, "continuationCharacterVoiceEnabled") {
        optional_judgment(
            "あなたは登場人物の声と呼称を管理する編集者です。",
            prompts::character_voices(context),
        )
        .await
    } else {
        String::new()
    };
    let plan = if enabled(settings, "twoStageContinuation") {
        ai::generate(
            "judgment",
            "あなたは日本語小説の構成担当です。計画だけを返してください。".into(),
            prompts::plan(
                context,
                enabled(settings, "continuationBeatSplitEnabled"),
                &scene,
                &voices,
            ),
        )
        .await?
        .text
    } else {
        String::new()
    };

    let first = draft(context, &plan, &scene, &voices).await?;
    let mut selected = if enabled(settings, "continuationBestOfTwo") {
        let second = draft(context, &plan, &scene, &voices).await?;
        if review::choose(&first.text, &second.text).await? {
            second
        } else {
            first
        }
    } else {
        first
    };

    if enabled(settings, "continuationReviewEnabled") {
        let findings = review::inspect(context, &selected.text).await?;
        let revised = ai::generate(
            "writing",
            "あなたは日本語小説の改稿者です。修正後の本文だけを返してください。".into(),
            prompts::revise(
                context,
                &selected.text,
                &findings,
                enabled(settings, "continuationTargetedRevision"),
            ),
        )
        .await?;
        if !revised.text.trim().is_empty()
            && review::prefer_revision(context, &selected.text, &revised.text).await?
        {
            selected = revised;
        }
    }
    Ok(selected)
}

pub async fn rewrite_passage(
    settings: &Value,
    context: &str,
    passage: &str,
) -> Result<ai::GeneratedText, JsValue> {
    let first = rewrite_candidate(context, passage).await?;
    let mut selected = if enabled(settings, "continuationBestOfTwo") {
        let second = rewrite_candidate(context, passage).await?;
        if review::choose(&first.text, &second.text).await? {
            second
        } else {
            first
        }
    } else {
        first
    };
    if enabled(settings, "continuationReviewEnabled") {
        let findings = review::inspect(context, &selected.text).await?;
        let revised = ai::generate(
            "writing",
            "あなたは日本語小説の改稿者です。対象範囲の修正後本文だけを返してください。".into(),
            prompts::revise(
                context,
                &selected.text,
                &findings,
                enabled(settings, "continuationTargetedRevision"),
            ),
        )
        .await?;
        if !revised.text.trim().is_empty()
            && review::prefer_revision(context, &selected.text, &revised.text).await?
        {
            selected = revised;
        }
    }
    Ok(selected)
}

async fn draft(
    context: &str,
    plan: &str,
    scene: &str,
    voices: &str,
) -> Result<ai::GeneratedText, JsValue> {
    ai::generate(
        "writing",
        "あなたは日本語小説の執筆者です。既存本文の文体・視点・時制を維持し、説明や前置きを付けず本文の続きだけを書いてください。".into(),
        prompts::draft(context, plan, scene, voices),
    )
    .await
}

async fn rewrite_candidate(context: &str, passage: &str) -> Result<ai::GeneratedText, JsValue> {
    ai::generate(
        "writing",
        "あなたは日本語小説の編集者です。指定範囲の書き直し本文だけを返してください。".into(),
        prompts::rewrite(context, passage),
    )
    .await
}

async fn optional_judgment(system: &str, prompt: String) -> String {
    ai::generate("judgment", system.into(), prompt)
        .await
        .map(|result| result.text)
        .unwrap_or_default()
}

fn enabled(settings: &Value, key: &str) -> bool {
    settings.get(key).and_then(Value::as_bool).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn missing_pipeline_flags_are_disabled() {
        assert!(!enabled(&json!({}), "continuationReviewEnabled"));
        assert!(enabled(
            &json!({"continuationReviewEnabled":true}),
            "continuationReviewEnabled"
        ));
    }

    #[test]
    fn every_prompt_keeps_original_context() {
        let context = "固有の本文末尾";
        assert!(prompts::draft(context, "", "", "").contains(context));
        assert!(prompts::review(context, "候補").contains(context));
        assert!(prompts::regression(context, "前", "後").contains(context));
        assert!(prompts::rewrite(context, "対象").contains(context));
    }
}
