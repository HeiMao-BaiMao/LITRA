pub(crate) mod old_prompts;
mod prompts;
mod review;

use serde_json::Value;
use wasm_bindgen::JsValue;

use crate::ai::draft_checks;
use crate::ai::plan_beats;
use crate::ai::style_fingerprint;
use crate::runtime::ai;

pub async fn continue_story(settings: &Value, context: &str) -> Result<ai::GeneratedText, JsValue> {
    continue_story_with_instruction(settings, context, "自然に続きを執筆する").await
}

pub async fn continue_story_with_instruction(
    settings: &Value,
    context: &str,
    instruction: &str,
) -> Result<ai::GeneratedText, JsValue> {
    // 文体指紋を計測（続き生成前に本文の統計的特徴を取得）
    let fingerprint = style_fingerprint::measure_style_fingerprint(context);
    let _ = &fingerprint; // プロンプト拡張用に予約（将来の prompts 統合で使用）

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
                instruction,
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

    // ビート分割生成: 構想メモから主要ビートを抽出
    let beats = if enabled(settings, "continuationBeatSplitEnabled") && !plan.is_empty() {
        plan_beats::parse_plan_beats(&plan)
    } else {
        vec![]
    };
    let _ = &beats; // 将来のマルチビート分割生成で使用

    let first = draft(context, instruction, &plan, &scene, &voices).await?;
    let mut selected = if enabled(settings, "continuationBestOfTwo") {
        let second = draft(context, instruction, &plan, &scene, &voices).await?;
        if review::choose(&first.text, &second.text).await? {
            second
        } else {
            first
        }
    } else {
        first
    };

    // 機械検査: ハード違反があれば破棄して再生成（最大1回リトライ）
    let mechanical = draft_checks::check_draft(&selected.text, context);
    if !mechanical.hard.is_empty() && !enabled(settings, "continuationBestOfTwo") {
        let retry = draft(context, instruction, &plan, &scene, &voices).await?;
        let retry_check = draft_checks::check_draft(&retry.text, context);
        if retry_check.hard.len() < mechanical.hard.len() {
            selected = retry;
        }
    }

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
    instruction: &str,
    plan: &str,
    scene: &str,
    voices: &str,
) -> Result<ai::GeneratedText, JsValue> {
    let mut result = ai::generate(
        "writing",
        super::ai_actions::EDITORIAL_PARTNER_SYSTEM_PROMPT.into(),
        prompts::draft(context, instruction, plan, scene, voices),
    )
    .await?;
    // 機械的サニタイズ: 前置き・コードフェンス・見出しの除去
    result.text = draft_checks::sanitize_draft_text(&result.text);
    Ok(result)
}

async fn rewrite_candidate(context: &str, passage: &str) -> Result<ai::GeneratedText, JsValue> {
    ai::generate(
        "writing",
        super::ai_actions::EDITORIAL_PARTNER_SYSTEM_PROMPT.into(),
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
        assert!(prompts::draft(context, "", "", "", "").contains(context));
        assert!(prompts::review(context, "候補").contains(context));
        assert!(prompts::regression(context, "前", "後").contains(context));
        assert!(prompts::rewrite(context, "対象").contains(context));
    }
}
