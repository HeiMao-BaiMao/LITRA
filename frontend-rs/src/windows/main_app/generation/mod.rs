pub(crate) mod old_prompts;
mod prompts;
pub(crate) mod review;

use std::cell::RefCell;
use std::rc::Rc;

use serde_json::Value;
use wasm_bindgen::JsValue;

use crate::ai::draft_checks;
use crate::ai::plan_beats;
use crate::ai::style_fingerprint;
use crate::runtime::ai;

/// ドラフト生成中のテキストデルタを受け取るコールバック
pub type ChunkCallback = Rc<RefCell<dyn FnMut(&str)>>;

#[derive(Clone, Default)]
pub struct FictionReferences {
    pub settings_context: String,
    pub related_scenes: Option<String>,
    pub character_names: Vec<String>,
    pub character_excerpts: String,
}

pub async fn continue_story_with_references_progress<F>(
    settings: &Value,
    context: &str,
    instruction: &str,
    references: &FictionReferences,
    mut on_stage: F,
) -> Result<ai::GeneratedText, JsValue>
where
    F: FnMut(&str),
{
    continue_story_full(settings, context, instruction, references, &mut on_stage, None, None).await
}

/// on_chunk 付きの完全版。ドラフト生成中にテキストデルタをリアルタイムで受け取れる。
pub async fn continue_story_streaming<F>(
    settings: &Value,
    context: &str,
    instruction: &str,
    references: &FictionReferences,
    mut on_stage: F,
    on_chunk: ChunkCallback,
    previous_episode_text: Option<&str>,
) -> Result<ai::GeneratedText, JsValue>
where
    F: FnMut(&str),
{
    continue_story_full(settings, context, instruction, references, &mut on_stage, Some(on_chunk), previous_episode_text).await
}

async fn continue_story_full<F>(
    settings: &Value,
    context: &str,
    instruction: &str,
    references: &FictionReferences,
    on_stage: &mut F,
    on_chunk: Option<ChunkCallback>,
    previous_episode_text: Option<&str>,
) -> Result<ai::GeneratedText, JsValue>
where
    F: FnMut(&str),
{
    // 文体指紋を計測し、旧 TypeScript と同じ文体指標セクションをドラフトへ渡す。
    // 現エピソードが短い場合、直前エピソードの本文を補って計測材料を確保する（TS版 findPreviousEpisodeContent 相当）。
    let style_sample = style_fingerprint::compose_style_sample_text(context, previous_episode_text);
    let fingerprint = style_fingerprint::measure_style_fingerprint(&style_sample);
    let endings = fingerprint
        .sentence_endings
        .iter()
        .take(5)
        .map(|entry| format!("「{}」{:.0}%", entry.form, entry.ratio * 100.0))
        .collect::<Vec<_>>()
        .join(" / ");
    let fingerprint_section = old_prompts::style_fingerprint_section(
        fingerprint.average_sentence_length,
        fingerprint.kanji_ratio,
        fingerprint.dialogue_ratio,
        fingerprint.average_sentences_per_paragraph,
        &endings,
    );

    let scene = if enabled(settings, "continuationSceneStateEnabled") {
        on_stage("場面状態を整理中");
        optional_judgment(
            "あなたは小説の連続性を管理する編集者です。",
            prompts::scene_state(context, nonempty(&references.settings_context)),
        )
        .await
    } else {
        String::new()
    };
    let voices = if enabled(settings, "continuationCharacterVoiceEnabled")
        && !references.character_names.is_empty()
    {
        on_stage("人物の話し方を整理中");
        optional_judgment(
            "あなたは登場人物の声と呼称を管理する編集者です。",
            prompts::character_voices(
                &references.character_names,
                if references.character_excerpts.trim().is_empty() {
                    context
                } else {
                    &references.character_excerpts
                },
                nonempty(&references.settings_context),
            ),
        )
        .await
    } else {
        String::new()
    };
    let plan = if enabled(settings, "twoStageContinuation") {
        on_stage("構想を作成中");
        ai::generate(
            "judgment",
            super::ai_actions::EDITORIAL_PARTNER_SYSTEM_PROMPT.into(),
            prompts::plan(
                context,
                instruction,
                enabled(settings, "continuationBeatSplitEnabled"),
                &scene,
                &voices,
                nonempty(&references.settings_context),
                references.related_scenes.as_deref(),
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
    let best_of_two = enabled(settings, "continuationBestOfTwo");
    on_stage(if beats.len() >= 2 && !best_of_two {
        "ビートごとに本文を生成中"
    } else {
        "本文候補を生成中"
    });
    let first = if beats.len() >= 2 && !best_of_two {
        draft_beats(
            context,
            instruction,
            &plan,
            &scene,
            &voices,
            &fingerprint_section,
            references,
            scaffold(settings),
            &beats,
        )
        .await?
    } else {
        draft(
            context,
            instruction,
            &plan,
            &scene,
            &voices,
            &fingerprint_section,
            references,
            scaffold(settings),
            None,
            on_chunk.clone(),
        )
        .await?
    };
    let mut selected = if best_of_two {
        on_stage("第2候補を生成中");
        let second = draft(
            context,
            instruction,
            &plan,
            &scene,
            &voices,
            &fingerprint_section,
            references,
            scaffold(settings),
            None,
            None,
        )
        .await?;
        on_stage("候補を比較中");
        if review::choose_draft(
            &first.text,
            &second.text,
            context,
            nonempty(&references.settings_context),
            nonempty(&plan),
            scaffold(settings),
            Some(instruction),
        )
        .await?
        {
            second
        } else {
            first
        }
    } else {
        first
    };

    // 機械検査: ハード違反があれば破棄して再生成（最大1回リトライ）
    let mechanical = draft_checks::check_draft(&selected.text, context);
    if !mechanical.hard.is_empty() {
        on_stage("機械検査の指摘を再生成中");
        let retry = draft(
            context,
            instruction,
            &plan,
            &scene,
            &voices,
            &fingerprint_section,
            references,
            scaffold(settings),
            None,
            None,
        )
        .await?;
        let retry_check = draft_checks::check_draft(&retry.text, context);
        if retry_check.hard.len() < mechanical.hard.len() {
            selected = retry;
        }
    }

    if enabled(settings, "continuationReviewEnabled") {
        on_stage("判断モデルで査読中");
        let extras = old_prompts::fiction_extra_sections(&scene, &voices, &fingerprint_section);
        let mut findings = review::inspect(
            context,
            &selected.text,
            nonempty(&references.settings_context),
            nonempty(&plan),
            references.related_scenes.as_deref(),
            &extras,
        )
        .await?;
        let checked = draft_checks::check_draft(&selected.text, context);
        let mechanical_findings = checked
            .hard
            .into_iter()
            .chain(checked.soft)
            .collect::<Vec<_>>();
        if !mechanical_findings.is_empty() {
            findings.push_str("\n\n【機械検査による指摘】\n");
            findings.push_str(
                &mechanical_findings
                    .into_iter()
                    .map(|item| format!("- {item}"))
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
        }
        if !review::requires_revision(&findings) {
            return Ok(selected);
        }
        on_stage("査読結果から改稿中");
        let revised = revise_with_review(
            context,
            &selected.text,
            &findings,
            enabled(settings, "continuationTargetedRevision"),
            scaffold(settings),
            nonempty(&references.settings_context),
            references.related_scenes.as_deref(),
            &extras,
        )
        .await?;
        if revised.text == selected.text {
            return Ok(selected);
        }
        on_stage("改稿の回帰を確認中");
        if !revised.text.trim().is_empty()
            && review::prefer_revision(
                context,
                &selected.text,
                &revised.text,
                nonempty(&references.settings_context),
                scaffold(settings),
            )
            .await?
        {
            selected = revised;
        }
    }
    Ok(selected)
}

pub async fn rewrite_passage_with_references(
    settings: &Value,
    context: &str,
    passage: &str,
    instruction: &str,
    references: &FictionReferences,
) -> Result<ai::GeneratedText, JsValue> {
    rewrite_passage_streaming(settings, context, passage, instruction, references, None).await
}

/// on_chunk 付きの書き直し。第一候補の生成中にテキストデルタを受け取れる。
pub async fn rewrite_passage_streaming(
    settings: &Value,
    context: &str,
    passage: &str,
    instruction: &str,
    references: &FictionReferences,
    on_chunk: Option<ChunkCallback>,
) -> Result<ai::GeneratedText, JsValue> {
    let first = rewrite_candidate(
        context,
        passage,
        instruction,
        references,
        scaffold(settings),
        on_chunk,
    )
    .await?;
    let mut selected = if enabled(settings, "continuationBestOfTwo") {
        let second = rewrite_candidate(
            context,
            passage,
            instruction,
            references,
            scaffold(settings),
            None,
        )
        .await?;
        if review::choose_candidate(
            &first.text,
            &second.text,
            instruction,
            passage,
            context,
            nonempty(&references.settings_context),
            scaffold(settings),
        )
        .await?
        {
            second
        } else {
            first
        }
    } else {
        first
    };
    if enabled(settings, "continuationReviewEnabled") {
        let findings = review::inspect(
            context,
            &selected.text,
            nonempty(&references.settings_context),
            None,
            references.related_scenes.as_deref(),
            "",
        )
        .await?;
        if !review::requires_revision(&findings) {
            return Ok(selected);
        }
        let revised = revise_with_review(
            context,
            &selected.text,
            &findings,
            enabled(settings, "continuationTargetedRevision"),
            scaffold(settings),
            nonempty(&references.settings_context),
            references.related_scenes.as_deref(),
            "",
        )
        .await?;
        if revised.text == selected.text {
            return Ok(selected);
        }
        if !revised.text.trim().is_empty()
            && review::prefer_revision(
                context,
                &selected.text,
                &revised.text,
                nonempty(&references.settings_context),
                scaffold(settings),
            )
            .await?
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
    style_fingerprint: &str,
    references: &FictionReferences,
    scaffold: Option<&str>,
    beat_directive: Option<(&str, usize, usize)>,
    on_chunk: Option<ChunkCallback>,
) -> Result<ai::GeneratedText, JsValue> {
    let prompt = prompts::draft(
        context,
        instruction,
        plan,
        scene,
        voices,
        nonempty(&references.settings_context),
        references.related_scenes.as_deref(),
        scaffold,
        Some(style_fingerprint),
        beat_directive,
    );
    let system: String = super::ai_actions::EDITORIAL_PARTNER_SYSTEM_PROMPT.into();
    let mut result = if let Some(callback) = on_chunk {
        let cb = Rc::clone(&callback);
        ai::generate_streaming(
            "writing",
            system,
            prompt.clone(),
            None,
            None,
            move |chunk| {
                (cb.borrow_mut())(chunk);
            },
        )
        .await?
    } else {
        ai::generate("writing", system, prompt.clone()).await?
    };
    // TS の continuation と同じく、出力上限で切れた場合は同じ会話を
    // 最大2回だけ継続し、途中で欠けた本文をそのまま連結する。
    for _ in 0..2 {
        if !is_length_finish(result.finish_reason.as_deref()) {
            break;
        }
        let turn = ai::agent_turn(
            "writing",
            super::ai_actions::EDITORIAL_PARTNER_SYSTEM_PROMPT.into(),
            vec![
                serde_json::json!({"role":"user","content":prompt}),
                serde_json::json!({"role":"assistant","content":result.text}),
                serde_json::json!({"role":"user","content":"直前の出力は長さ上限で途切れた。同じ本文を繰り返さず、中断した位置から小説本文だけを続けてください。"}),
            ],
            Vec::new(),
            None,
            None,
        ).await?;
        result.text.push_str(&turn.text);
        result.finish_reason = turn.finish_reason;
    }
    // 機械的サニタイズ: 前置き・コードフェンス・見出しの除去
    result.text = draft_checks::sanitize_draft_text(&result.text);
    Ok(result)
}

fn is_length_finish(reason: Option<&str>) -> bool {
    reason.is_some_and(|reason| {
        matches!(
            reason.to_ascii_lowercase().as_str(),
            "length" | "max_tokens" | "max_output_tokens"
        )
    })
}

async fn draft_beats(
    context: &str,
    instruction: &str,
    plan: &str,
    scene: &str,
    voices: &str,
    style_fingerprint: &str,
    references: &FictionReferences,
    scaffold: Option<&str>,
    beats: &[String],
) -> Result<ai::GeneratedText, JsValue> {
    let mut cumulative_context = context.to_string();
    let mut combined: Option<ai::GeneratedText> = None;
    for (index, beat) in beats.iter().enumerate() {
        let part = draft(
            &cumulative_context,
            instruction,
            plan,
            scene,
            voices,
            style_fingerprint,
            references,
            scaffold,
            Some((beat, index + 1, beats.len())),
            None,
        )
        .await?;
        let part_text = part.text.clone();
        if let Some(result) = combined.as_mut() {
            result.text.push_str(&part_text);
        } else {
            combined = Some(part);
        }
        cumulative_context.push_str(&part_text);
        cumulative_context = cumulative_context
            .chars()
            .rev()
            .take(24_000)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
    }
    combined.ok_or_else(|| JsValue::from_str("構想メモからビートを取得できませんでした。"))
}

async fn rewrite_candidate(
    context: &str,
    passage: &str,
    instruction: &str,
    references: &FictionReferences,
    scaffold: Option<&str>,
    on_chunk: Option<ChunkCallback>,
) -> Result<ai::GeneratedText, JsValue> {
    let system: String = super::ai_actions::EDITORIAL_PARTNER_SYSTEM_PROMPT.into();
    let prompt = prompts::rewrite(
        context,
        passage,
        scaffold,
        Some(instruction),
        nonempty(&references.settings_context),
    );
    if let Some(callback) = on_chunk {
        let cb = Rc::clone(&callback);
        ai::generate_streaming("writing", system, prompt, None, None, move |chunk| {
            (cb.borrow_mut())(chunk);
        })
        .await
    } else {
        ai::generate("writing", system, prompt).await
    }
}

async fn optional_judgment(system: &str, prompt: String) -> String {
    let _ = system;
    ai::generate(
        "judgment",
        super::ai_actions::EDITORIAL_PARTNER_SYSTEM_PROMPT.into(),
        prompt,
    )
    .await
    .map(|result| result.text)
    .unwrap_or_default()
}

fn enabled(settings: &Value, key: &str) -> bool {
    settings.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn nonempty(value: &str) -> Option<&str> {
    (!value.trim().is_empty()).then_some(value)
}

fn scaffold(settings: &Value) -> Option<&str> {
    settings
        .get("promptScaffold")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
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
        assert!(
            prompts::draft(context, "", "", "", "", None, None, None, None, None).contains(context)
        );
        assert!(prompts::review(context, "候補", None, None, None, "").contains(context));
        assert!(
            prompts::candidate_selection("前", "後", "改稿", "前", context, None, None)
                .contains(context)
        );
        assert!(prompts::rewrite(context, "対象", None, None, None).contains(context));
    }

    #[test]
    fn draft_includes_generated_continuity_cards_and_style() {
        let prompt = prompts::draft(
            "直前本文",
            "続ける",
            "構想",
            "場所: 書斎",
            "主人公: 私、常体",
            None,
            None,
            None,
            Some("【文体指標】短文中心"),
            Some(("扉を開ける", 1, 2)),
        );
        assert!(prompt.contains("【場面の現在状態"));
        assert!(prompt.contains("<reference_data name=\"scene_state\">\n場所: 書斎"));
        assert!(prompt.contains("【人物の話し方カード"));
        assert!(prompt.contains("<reference_data name=\"character_voice_cards\">"));
        assert!(prompt.contains("【文体指標】短文中心"));
        assert!(prompt.contains("ビート1/2「扉を開ける」"));
        assert!(prompt.contains("【LITRA工程】continuation-draft/v2"));
        assert!(prompt.contains("【最終指示"));
        assert!(prompt.contains("【メタ認知"));
    }

    #[test]
    fn plan_never_contains_draft_output_instructions() {
        let prompt = prompts::plan("本文", "続ける", false, "", "", None, None);
        assert!(prompt.contains("continuation-plan/v2"));
        assert!(!prompt.contains("continuation-draft/v2"));
        assert!(!prompt.contains("出力の1文字目から小説本文を書く"));
    }

    #[test]
    fn feedback_and_line_edit_use_full_ts_templates() {
        let feedback = old_prompts::feedback("対象", "設定");
        assert!(feedback.contains("【評価項目 — すべて確認する】"));
        assert!(feedback.contains("【優先して直す点】"));
        let review = old_prompts::line_edit_review("対象", "周囲", None, None, Some("設定"), None);
        assert!(review.contains("4観点で1文ずつ点検"));
        assert!(!review.contains("{instructionSection}"));
        assert!(!review.contains("formatPromptDataBlock"));
        let tool_need = old_prompts::tool_call_need(
            "保存して",
            Some("保存します"),
            &["saveMemo".to_string()],
        );
        assert!(tool_need.contains("- saveMemo"));
        assert!(tool_need.contains("needsTools=true"));
        assert!(!tool_need.contains("availableToolNames.length"));
    }

    #[test]
    fn targeted_replacements_only_change_unique_non_overlapping_ranges() {
        let replacements = vec![
            old_prompts::TargetedReplacement {
                target: "古い文。".into(),
                replacement: "新しい文。".into(),
            },
            old_prompts::TargetedReplacement {
                target: "重複。".into(),
                replacement: "変更しない。".into(),
            },
        ];
        assert_eq!(
            apply_targeted_replacements("前。古い文。重複。重複。後。", &replacements),
            Some("前。新しい文。重複。重複。後。".into())
        );
    }
}

async fn revise_with_review(
    context: &str,
    draft: &str,
    review: &str,
    targeted: bool,
    scaffold: Option<&str>,
    settings_context: Option<&str>,
    related_scenes: Option<&str>,
    extra_sections: &str,
) -> Result<ai::GeneratedText, JsValue> {
    if targeted {
        let mut proposal = ai::generate(
            "writing",
            super::ai_actions::EDITORIAL_PARTNER_SYSTEM_PROMPT.into(),
            prompts::revise(
                context,
                draft,
                review,
                true,
                scaffold,
                settings_context,
                related_scenes,
                extra_sections,
            ),
        )
        .await?;
        if let Some(replacements) = old_prompts::parse_targeted_revision(&proposal.text) {
            if replacements.is_empty() {
                proposal.text = draft.to_string();
                return Ok(proposal);
            }
            if let Some(applied) = apply_targeted_replacements(draft, &replacements) {
                proposal.text = applied;
                return Ok(proposal);
            }
        }
    }
    ai::generate(
        "writing",
        super::ai_actions::EDITORIAL_PARTNER_SYSTEM_PROMPT.into(),
        prompts::revise(
            context,
            draft,
            review,
            false,
            scaffold,
            settings_context,
            related_scenes,
            extra_sections,
        ),
    )
    .await
}

fn apply_targeted_replacements(
    draft: &str,
    replacements: &[old_prompts::TargetedReplacement],
) -> Option<String> {
    let mut applied = Vec::<(usize, usize, &str)>::new();
    for replacement in replacements {
        let matches = draft
            .match_indices(&replacement.target)
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            continue;
        }
        let start = matches[0];
        let end = start + replacement.target.len();
        if applied
            .iter()
            .any(|(other_start, other_end, _)| start < *other_end && end > *other_start)
        {
            continue;
        }
        applied.push((start, end, replacement.replacement.as_str()));
    }
    if applied.is_empty() {
        return None;
    }
    applied.sort_by_key(|(start, _, _)| *start);
    let mut result = String::new();
    let mut cursor = 0;
    for (start, end, replacement) in applied {
        result.push_str(&draft[cursor..start]);
        result.push_str(replacement);
        cursor = end;
    }
    result.push_str(&draft[cursor..]);
    Some(result)
}
