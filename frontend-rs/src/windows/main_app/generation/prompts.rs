//! TypeScript `src/ai/prompts.ts` と同じ引数を保った生成パイプライン用ラッパー。

use super::old_prompts;

pub fn scene_state(context: &str, settings_context: Option<&str>) -> String {
    old_prompts::scene_state(context, settings_context, None)
}

pub fn character_voices(
    names: &[String],
    excerpts: &str,
    settings_context: Option<&str>,
) -> String {
    old_prompts::character_voices(names, excerpts, settings_context, None)
}

pub fn plan(
    context: &str,
    instruction: &str,
    beat_split: bool,
    scene: &str,
    voices: &str,
    settings_context: Option<&str>,
    related_scenes: Option<&str>,
) -> String {
    old_prompts::plan(
        context,
        instruction,
        beat_split,
        scene,
        voices,
        settings_context,
        related_scenes,
        Some(instruction),
    )
}

#[allow(clippy::too_many_arguments)]
pub fn draft(
    context: &str,
    instruction: &str,
    plan: &str,
    scene: &str,
    voices: &str,
    settings_context: Option<&str>,
    related_scenes: Option<&str>,
    scaffold: Option<&str>,
    style_fingerprint: Option<&str>,
    beat_directive: Option<(&str, usize, usize)>,
) -> String {
    old_prompts::draft(
        context,
        instruction,
        plan,
        scene,
        voices,
        scaffold,
        settings_context,
        related_scenes,
        Some(instruction),
        style_fingerprint,
        beat_directive,
    )
}

pub fn select(
    first: &str,
    second: &str,
    context: &str,
    settings_context: Option<&str>,
    plan: Option<&str>,
    scaffold: Option<&str>,
    instruction: Option<&str>,
) -> String {
    old_prompts::select_drafts(
        &[first, second],
        context,
        settings_context,
        plan,
        scaffold,
        instruction,
    )
}

pub fn candidate_selection(
    first: &str,
    second: &str,
    task: &str,
    original: &str,
    context: &str,
    settings_context: Option<&str>,
    scaffold: Option<&str>,
) -> String {
    old_prompts::candidate_selection(
        &[first, second],
        task,
        original,
        context,
        settings_context,
        scaffold,
    )
}

pub fn review(
    context: &str,
    draft: &str,
    settings_context: Option<&str>,
    plan: Option<&str>,
    related_scenes: Option<&str>,
    extra_sections: &str,
) -> String {
    old_prompts::review(
        context,
        draft,
        settings_context,
        plan,
        related_scenes,
        extra_sections,
    )
}

pub fn revise(
    context: &str,
    draft: &str,
    review: &str,
    targeted: bool,
    scaffold: Option<&str>,
    settings_context: Option<&str>,
    related_scenes: Option<&str>,
    extra_sections: &str,
) -> String {
    if targeted {
        old_prompts::targeted_revision(
            context,
            draft,
            review,
            scaffold,
            settings_context,
            related_scenes,
            extra_sections,
        )
    } else {
        old_prompts::revise(
            context,
            draft,
            review,
            scaffold,
            settings_context,
            related_scenes,
            extra_sections,
        )
    }
}

pub fn rewrite(
    context: &str,
    passage: &str,
    scaffold: Option<&str>,
    instruction: Option<&str>,
    settings_context: Option<&str>,
) -> String {
    old_prompts::rewrite(
        context,
        passage,
        scaffold,
        instruction,
        settings_context,
        None,
    )
}
