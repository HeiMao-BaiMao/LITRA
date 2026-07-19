//! 生成パイプライン用プロンプト。
//! 旧TS `prompts.ts` から抽出した完成・洗礼済みプロンプトを使用。
//!
//! 実装は `old_prompts` モジュールにあり、
//! このモジュールは互換ラッパーを提供する。

use super::old_prompts;

pub fn scene_state(context: &str) -> String {
    old_prompts::scene_state(context)
}

pub fn character_voices(context: &str) -> String {
    old_prompts::character_voices(context)
}

pub fn plan(
    context: &str,
    instruction: &str,
    beat_split: bool,
    scene: &str,
    voices: &str,
) -> String {
    old_prompts::plan(context, instruction, beat_split, scene, voices)
}

pub fn draft(context: &str, instruction: &str, plan: &str, scene: &str, voices: &str) -> String {
    old_prompts::draft(context, instruction, plan, scene, voices)
}

pub fn select(first: &str, second: &str) -> String {
    old_prompts::select_draft(first, second)
}

pub fn review(context: &str, draft: &str) -> String {
    old_prompts::review(context, draft)
}

pub fn revise(context: &str, draft: &str, review: &str, targeted: bool) -> String {
    old_prompts::revise(context, draft, review, targeted)
}

pub fn regression(context: &str, original: &str, revised: &str) -> String {
    // 旧TS版: 修正前後を比較し、悪化していない方を選ぶ
    format!(
        "修正前と修正後を比較し、修正によって新しい矛盾、欠落、文体悪化が生じていない方を選んでください。返答は修正前なら 1、修正後なら 2 の一文字だけにしてください。\n\n既存本文末尾:\n{context}\n\n修正前:\n{original}\n\n修正後:\n{revised}"
    )
}

pub fn rewrite(context: &str, passage: &str) -> String {
    old_prompts::rewrite(context, passage)
}
