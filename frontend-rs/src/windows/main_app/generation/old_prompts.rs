//! 旧TS `prompts.ts` から抽出した完成・洗礼済みプロンプト群。
//! 各プロンプトは `include_str!("old_prompts/<name>.txt")` で埋め込まれ、
//! ラッパー関数が `format!()` で変数を展開する。
//!
//! 元の TypeScript テンプレートリテラル `${var}` は `{var}` に変換済み。

// ---- 生成パイプライン ---------------------------------------------------

pub fn plan(context: &str, instruction: &str, beat_split: bool, scene: &str, voices: &str) -> String {
    let format_instruction = if beat_split {
        "3〜6個の番号付きビートに分けること。"
    } else {
        "短い箇条書きで示すこと。"
    };
    let template = include_str!("old_prompts/plan.txt");
    template
        .replace("{format}", format_instruction)
        .replace("{instruction}", instruction)
        .replace("{scene}", scene)
        .replace("{voices}", voices)
        .replace("{context}", context)
}

pub fn draft(context: &str, instruction: &str, plan: &str, scene: &str, voices: &str) -> String {
    let template = include_str!("old_prompts/draft.txt");
    template
        .replace("{context}", context)
        .replace("{instruction}", instruction)
        .replace("{plan}", plan)
        .replace("{scene}", scene)
        .replace("{voices}", voices)
}

pub fn review(context: &str, draft: &str) -> String {
    let template = include_str!("old_prompts/review.txt");
    template
        .replace("{context}", context)
        .replace("{draft}", draft)
}

pub fn revise(context: &str, draft: &str, review: &str, targeted: bool) -> String {
    let scope_text = if targeted {
        "レビューで指摘された箇所だけを必要最小限に修正し、それ以外は維持"
    } else {
        "レビューを反映して全体を推敲"
    };
    let template = include_str!("old_prompts/revise.txt");
    template
        .replace("{scope}", scope_text)
        .replace("{context}", context)
        .replace("{review}", review)
        .replace("{draft}", draft)
}

pub fn select_draft(first: &str, second: &str) -> String {
    let template = include_str!("old_prompts/select_draft.txt");
    template
        .replace("{first}", first)
        .replace("{second}", second)
}

pub fn rewrite(context: &str, passage: &str) -> String {
    let template = include_str!("old_prompts/rewrite.txt");
    template
        .replace("{context}", context)
        .replace("{passage}", passage)
}

// ---- シーン・キャラクターカード -----------------------------------------

pub fn scene_state(context: &str) -> String {
    let template = include_str!("old_prompts/scene_state.txt");
    template.replace("{context}", context)
}

pub fn character_voices(context: &str) -> String {
    let template = include_str!("old_prompts/character_voices.txt");
    template.replace("{context}", context)
}

// ---- フィードバック・要約 -------------------------------------------------

pub fn feedback(selection: &str, settings_context: &str) -> String {
    let template = include_str!("old_prompts/feedback.txt");
    template
        .replace("{selection}", selection)
        .replace("{settingsContext}", settings_context)
}

pub fn summary_episode(text: &str) -> String {
    let template = include_str!("old_prompts/summary.txt");
    template.replace("{text}", text)
}

// ---- ターゲットリビジョン・執筆指示 -------------------------------------

pub fn targeted_revision(context: &str, draft: &str, review: &str) -> String {
    let template = include_str!("old_prompts/targeted_revision.txt");
    template
        .replace("{context}", context)
        .replace("{draft}", draft)
        .replace("{review}", review)
}

pub fn author_instruction(instruction: &str) -> String {
    if instruction.is_empty() {
        return String::new();
    }
    let template = include_str!("old_prompts/author_instruction.txt");
    template.replace("{instruction}", instruction)
}

// ---- ライン編集 ----------------------------------------------------------

pub fn line_edit_review(passage: &str, context: &str) -> String {
    let template = include_str!("old_prompts/line_edit_review.txt");
    template
        .replace("{passage}", passage)
        .replace("{context}", context)
}

pub fn line_edit_revision(passage: &str, review: &str, context: &str) -> String {
    let template = include_str!("old_prompts/line_edit_revision.txt");
    template
        .replace("{passage}", passage)
        .replace("{review}", review)
        .replace("{context}", context)
}

// ---- ツール関連 ----------------------------------------------------------

pub fn tool_call_need(user_message: &str) -> String {
    let template = include_str!("old_prompts/tool_call_need.txt");
    template.replace("{userMessage}", user_message)
}

// ---- ヘルパー ------------------------------------------------------------

/// `buildStyleFingerprintSection` — 文体指紋をプロンプト用文字列に変換。
/// 旧TSの実装をRustに移植。
pub fn style_fingerprint_section(
    average_sentence_length: f64,
    kanji_ratio: f64,
    dialogue_ratio: f64,
    average_sentences_per_paragraph: f64,
    endings: &str,
) -> String {
    let pct = |v: f64| -> String {
        let clamped = v.max(0.0).min(1.0);
        format!("{}%", (clamped * 100.0).round())
    };
    let ending_text = if endings.is_empty() {
        String::new()
    } else {
        format!("\n- 地の文の文末の分布: {endings}")
    };
    format!(
        "【文体指標 — この作品の本文から機械計測した実測値】\n\
         この作品の文章は、次の数値的特徴を持つ。\n\
         - 1文の平均の長さ: 約{}文字\n\
         - 本文に占める漢字の割合: 約{}\n\
         - 会話(「」の行)の割合: 約{}\n\
         - 1段落あたりの平均文数: 約{}文{}\n\
         使い方 — 全項目を必ず守る:\n\
         1. 新しく書く本文は、全体としてこの指標に近づける。1文ごとに厳密に合わせる必要はないが、平均がここから大きく離れてはならない。\n\
         2. 査読・修正では、この指標からの明らかな逸脱(極端に長い文や短い文の連続、漢語の急増、会話率の急変)を文体の問題として扱う。\n\
         3. この指標の存在や数値そのものを、本文にも出力にも書かない。",
        average_sentence_length.round(),
        pct(kanji_ratio),
        pct(dialogue_ratio),
        average_sentences_per_paragraph.round(),
        ending_text,
    )
}
