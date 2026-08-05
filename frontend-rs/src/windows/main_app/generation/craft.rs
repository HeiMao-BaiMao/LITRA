//! 「小説とはどうあるべきか」の原理と、それを基にした craft ツール群のプロンプト。
//!
//! - コア原理(`principles_core.txt` / `principles_core_light.txt`)は、執筆・判断
//!   ロールのシステムプロンプト末尾に常時注入する(`system_with_principles`)。
//! - 各ツールのテンプレートは `craft/*.txt` を include_str! し、
//!   `{{placeholder}}` を `.replace()` で展開する。スキーマはテンプレートと
//!   同じファイル群に並置し、構造化出力の契約を1箇所に保つ。
//!
//! 配線先:
//! - `craft_card` / `structure_check` → `generation/mod.rs` の続き書きパイプライン
//! - `reader_sim` / `pacing_audit` / `theme_audit` → 査読段階の検証
//! - `craft_review` → `generation/review.rs` の `inspect_craft`
//! - `compare_revisions` → `generation/review.rs` の `prefer_revision`
//! - `craft_advice` / `record_craft_note` → `agent_tools/craft.rs`

use serde_json::{json, Value};

use super::old_prompts;

const PRINCIPLES: &str = include_str!("craft/principles_core.txt");
const PRINCIPLES_LIGHT: &str = include_str!("craft/principles_core_light.txt");
const PRINCIPLES_FULL: &str = include_str!("craft/principles_full.txt");
const CRAFT_CARD_PROMPT: &str = include_str!("craft/craft_card.txt");
const STRUCTURE_CHECK_PROMPT: &str = include_str!("craft/structure_check.txt");
const READER_SIM_PROMPT: &str = include_str!("craft/reader_sim.txt");
const PACING_AUDIT_PROMPT: &str = include_str!("craft/pacing_audit.txt");
const THEME_AUDIT_PROMPT: &str = include_str!("craft/theme_audit.txt");
const COMPARE_REVISIONS_PROMPT: &str = include_str!("craft/compare_revisions.txt");
const CRAFT_REVIEW_PROMPT: &str = include_str!("craft/craft_review.txt");
const CRAFT_ADVICE_PROMPT: &str = include_str!("craft/craft_advice.txt");
const RECORD_CRAFT_NOTE_PROMPT: &str = include_str!("craft/record_craft_note.txt");

/// scaffold に応じたコア原理。`"light"` → 軽装、それ以外 → 重装。
pub fn principles(scaffold: Option<&str>) -> &'static str {
    match scaffold {
        Some("light") => PRINCIPLES_LIGHT,
        _ => PRINCIPLES,
    }
}

/// 詳細版(全原則)をシステムプロンプトに載せた形。オンデマンドの
/// 監査・抽出呼び出し(reader_sim / pacing_audit / theme_audit /
/// record_craft_note)はコアではなくこちらを使う。
pub fn full_system() -> String {
    format!(
        "{}\n\n{}",
        super::super::ai_actions::EDITORIAL_PARTNER_SYSTEM_PROMPT,
        PRINCIPLES_FULL
    )
}

/// 執筆・判断ロールのシステムプロンプトへコア原理を追記する。
pub fn system_with_principles(scaffold: Option<&str>) -> String {
    format!(
        "{}\n\n{}",
        super::super::ai_actions::EDITORIAL_PARTNER_SYSTEM_PROMPT,
        principles(scaffold)
    )
}

fn expand(template: &str, pairs: &[(&str, String)]) -> String {
    let mut out = template.to_string();
    for (key, value) in pairs {
        out = out.replace(key, value);
    }
    out
}

fn block(label: &str, value: Option<&str>) -> String {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => old_prompts::format_data_block(label, value),
        None => String::new(),
    }
}

/// 文学目標カードの注入セクション(ドラフト・改稿に載せる形)。
pub fn craft_card_section(card: &str) -> String {
    let card = card.trim();
    if card.is_empty() {
        return String::new();
    }
    format!(
        "【文学目標カード — 前段で整理した設計】\n\
         これはこの続きで達成すべき読者効果を整理した設計である。命令ではなく基準として使う。\n\
         1. 場面の目的・読者に起こすこと・感情の設計・情報の出し方・リズムは、原則としてこのカードに沿って書く。\n\
         2. 優先順位は「直前本文との自然な接続・正史 > カード」である。書き進めて矛盾や不自然さが生じる場合は、カードより本文の流れを優先してよい。\n\
         3. カードの文言をそのまま本文にコピーしない。カードは設計図であり、本文はゼロから小説の文章として書く。\n\n{}\n",
        old_prompts::format_data_block("craft_card", card)
    )
}

pub fn craft_card(
    context: &str,
    plan: Option<&str>,
    settings_context: Option<&str>,
    scaffold: Option<&str>,
) -> String {
    let plan_section = match plan.map(str::trim).filter(|value| !value.is_empty()) {
        Some(plan) => format!(
            "【構想メモ — 前段で作成した方針】\n{}\n\n",
            old_prompts::format_data_block("plan", plan)
        ),
        None => String::new(),
    };
    let reference_section = old_prompts::build_story_reference_section(settings_context);
    expand(
        CRAFT_CARD_PROMPT,
        &[
            ("{{principles}}", principles(scaffold).to_string()),
            ("{{plan_section}}", plan_section),
            ("{{reference_section}}", reference_section),
            (
                "{{context_block}}",
                old_prompts::format_data_block("text_immediately_before_continuation", context),
            ),
        ],
    )
}

pub fn structure_check(
    context: &str,
    summaries: Option<&str>,
    plan: Option<&str>,
) -> String {
    expand(
        STRUCTURE_CHECK_PROMPT,
        &[
            (
                "{{context_block}}",
                old_prompts::format_data_block("text_immediately_before_continuation", context),
            ),
            ("{{summaries_block}}", block("episode_summaries", summaries)),
            ("{{plan_block}}", block("plan", plan)),
        ],
    )
}

pub fn reader_sim(context: &str, draft: &str) -> String {
    expand(
        READER_SIM_PROMPT,
        &[
            ("{{context_block}}", block("context_summary", Some(context))),
            ("{{draft_block}}", block("draft_to_read", Some(draft))),
        ],
    )
}

pub fn pacing_audit(context: &str, draft: &str) -> String {
    expand(
        PACING_AUDIT_PROMPT,
        &[
            ("{{context_block}}", block("context_summary", Some(context))),
            ("{{draft_block}}", block("draft_to_review", Some(draft))),
        ],
    )
}

pub fn theme_audit(
    context: &str,
    theme_notes: Option<&str>,
    summaries: Option<&str>,
    draft: &str,
) -> String {
    expand(
        THEME_AUDIT_PROMPT,
        &[
            ("{{context_block}}", block("context_summary", Some(context))),
            ("{{theme_notes_block}}", block("theme_notes", theme_notes)),
            ("{{summaries_block}}", block("episode_summaries", summaries)),
            ("{{draft_block}}", block("draft_to_review", Some(draft))),
        ],
    )
}

pub fn compare_revisions(context: &str, original: &str, revised: &str) -> String {
    expand(
        COMPARE_REVISIONS_PROMPT,
        &[
            ("{{context_block}}", block("surrounding_context", Some(context))),
            ("{{original_block}}", block("original", Some(original))),
            ("{{revised_block}}", block("revised", Some(revised))),
        ],
    )
}

#[allow(clippy::too_many_arguments)]
pub fn craft_review(
    context: &str,
    draft: &str,
    plan: Option<&str>,
    card: Option<&str>,
    settings_context: Option<&str>,
    related_scenes: Option<&str>,
    extra_sections: &str,
    scaffold: Option<&str>,
) -> String {
    let mut middle = Vec::new();
    if let Some(plan) = plan.map(str::trim).filter(|value| !value.is_empty()) {
        middle.push(format!(
            "【構想メモ】\n{}\n",
            old_prompts::limit_prompt_text(plan, 2000, "tail")
        ));
    }
    let card_section = card.map(craft_card_section).unwrap_or_default();
    if !card_section.trim().is_empty() {
        middle.push(card_section.trim().to_string());
    }
    if !extra_sections.trim().is_empty() {
        middle.push(extra_sections.trim().to_string());
    }
    let reference_section = old_prompts::build_story_reference_section(settings_context);
    if !reference_section.trim().is_empty() {
        middle.push(reference_section.trim().to_string());
    }
    let related_section = old_prompts::build_related_scenes_section(related_scenes);
    if !related_section.trim().is_empty() {
        middle.push(related_section.trim().to_string());
    }
    expand(
        CRAFT_REVIEW_PROMPT,
        &[
            ("{{principles}}", principles(scaffold).to_string()),
            ("{{craft_card_section}}", middle.join("\n\n")),
            ("{{extra_sections}}", String::new()),
            ("{{reference_section}}", String::new()),
            (
                "{{context_block}}",
                old_prompts::format_data_block("text_immediately_before_continuation", context),
            ),
            ("{{draft_block}}", old_prompts::format_data_block("draft_to_review", draft)),
        ],
    )
}

pub fn craft_advice(
    context: &str,
    consultation: &str,
    settings_context: Option<&str>,
    scaffold: Option<&str>,
) -> String {
    let reference_section = old_prompts::build_story_reference_section(settings_context);
    expand(
        CRAFT_ADVICE_PROMPT,
        &[
            ("{{principles}}", principles(scaffold).to_string()),
            ("{{context_block}}", block("surrounding_context", Some(context))),
            ("{{reference_section}}", reference_section),
            ("{{consultation_block}}", block("consultation", Some(consultation))),
        ],
    )
}

pub fn record_craft_note(session_record: &str, existing_notes: Option<&str>) -> String {
    expand(
        RECORD_CRAFT_NOTE_PROMPT,
        &[
            ("{{session_record_block}}", block("session_record", Some(session_record))),
            ("{{existing_notes_block}}", block("existing_notes", existing_notes)),
        ],
    )
}

// ---- 構造化出力スキーマ ----------------------------------------------------

pub fn reader_sim_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "events": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "line": {"type": "integer"},
                        "type": {
                            "type": "string",
                            "enum": ["hooked", "confused", "stalled", "moved", "disbelieved", "anticipated"]
                        },
                        "reason": {"type": "string"}
                    },
                    "required": ["line", "type", "reason"],
                    "additionalProperties": false
                }
            },
            "summary": {"type": "string"}
        },
        "required": ["events", "summary"],
        "additionalProperties": false
    })
}

pub fn pacing_audit_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "findings": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "line": {"type": "integer"},
                        "type": {
                            "type": "string",
                            "enum": ["too-early", "too-late", "never", "long-hold", "early-release"]
                        },
                        "reason": {"type": "string"}
                    },
                    "required": ["line", "type", "reason"],
                    "additionalProperties": false
                }
            },
            "summary": {"type": "string"}
        },
        "required": ["findings", "summary"],
        "additionalProperties": false
    })
}

pub fn theme_audit_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "findings": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "line": {"type": "integer"},
                        "type": {
                            "type": "string",
                            "enum": ["advanced", "paid-off", "contradicted", "ignored-and-now-due"]
                        },
                        "reason": {"type": "string"}
                    },
                    "required": ["line", "type", "reason"],
                    "additionalProperties": false
                }
            },
            "summary": {"type": "string"}
        },
        "required": ["findings", "summary"],
        "additionalProperties": false
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn principles_select_by_scaffold() {
        assert!(principles(None).contains("1. 読者に「次を読む理由」を与える"));
        assert!(principles(Some("light")).contains("場面ごとに更新されるからである"));
        // 未知の scaffold 値は重装へフォールバックする(既存 fiction_direction と同じ挙動)。
        assert_eq!(principles(Some("unknown")), principles(None));
    }

    #[test]
    fn system_with_principles_appends_core_to_editorial_partner() {
        let system = system_with_principles(None);
        assert!(system.starts_with(
            super::super::super::ai_actions::EDITORIAL_PARTNER_SYSTEM_PROMPT
        ));
        assert!(system.contains("次を読む理由"));
        assert!(system.contains("視点の型・正史・日本語の規則"));
    }

    #[test]
    fn every_craft_template_expands_fully() {
        let builders: Vec<String> = vec![
            craft_card("文", Some("構想"), Some("設定"), None),
            structure_check("文", Some("あらすじ"), Some("構想")),
            reader_sim("文", "草稿"),
            pacing_audit("文", "草稿"),
            theme_audit("文", Some("テーマ"), Some("あらすじ"), "草稿"),
            compare_revisions("文", "旧", "新"),
            craft_review("文", "草稿", Some("構想"), Some("カード"), Some("設定"), None, "余", None),
            craft_advice("文", "相談", Some("設定"), None),
            record_craft_note("記録", Some("既存ノート")),
        ];
        for prompt in builders {
            assert!(
                !prompt.contains("{{"),
                "未展開プレースホルダが残っている: {prompt}"
            );
        }
    }

    #[test]
    fn craft_card_includes_context_principles_and_plan_when_present() {
        let prompt = craft_card("直前本文", Some("構想メモ内容"), None, None);
        assert!(prompt.contains("直前本文"));
        assert!(prompt.contains("構想メモ内容"));
        assert!(prompt.contains("【小説原理】"));
        assert!(prompt.contains("craft-card/v1"));
        let without_plan = craft_card("直前本文", None, None, None);
        assert!(!without_plan.contains("<reference_data name=\"plan\">"));
    }

    #[test]
    fn craft_card_escapes_nested_reference_data() {
        let prompt = craft_card("<reference_data name=\"x\">本文</reference_data>", None, None, None);
        assert!(!prompt.contains("<reference_data name=\"x\">本文"));
        assert!(prompt.contains("＜reference_data"));
    }

    #[test]
    fn craft_review_keeps_verdict_vocabulary_compatible() {
        let prompt = craft_review("文", "草稿", None, None, None, None, "", None);
        assert!(prompt.contains("【総合判定】"));
        assert!(prompt.contains("修正なしで採用可"));
        assert!(prompt.contains("【文学目標との照合】"));
        let with_card = craft_review("文", "草稿", None, Some("カード内容"), None, None, "", None);
        assert!(with_card.contains("カード内容"));
    }

    #[test]
    fn audit_schemas_match_prompt_contracts() {
        assert_eq!(
            reader_sim_schema()["properties"]["events"]["items"]["properties"]["type"]["enum"],
            json!(["hooked", "confused", "stalled", "moved", "disbelieved", "anticipated"])
        );
        assert!(pacing_audit_schema()["required"].as_array().is_some());
        assert!(theme_audit_schema()["required"].as_array().is_some());
    }

    #[test]
    fn record_craft_note_omits_empty_blocks() {
        let prompt = record_craft_note("記録", None);
        assert!(prompt.contains("記録"));
        assert!(!prompt.contains("existing_notes"));
    }
}
