use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    generation::{old_prompts::limit_prompt_text, FictionReferences},
    State,
};
use crate::runtime::invoke;

const DEFAULT_MAX_CONTEXT_TOKENS: f64 = 65_536.0;
const CONTEXT_CHAR_PER_TOKEN: f64 = 1.6;
const CONTEXT_OVERHEAD_TOKENS: f64 = 2_048.0;

#[derive(Clone, Copy)]
struct Budgets {
    settings_field: usize,
    settings_section: usize,
    project_memos: usize,
    previous_summary: usize,
    current_memo: usize,
}

fn budgets(settings: &Value) -> Budgets {
    let max_context = positive(settings, "maxContextTokens")
        .unwrap_or(DEFAULT_MAX_CONTEXT_TOKENS)
        .floor();
    let max_output = positive(settings, "maxTokens").unwrap_or(8_192.0).floor();
    let reserved =
        (max_output.max(1_024.0) + CONTEXT_OVERHEAD_TOKENS).min((max_context * 0.5).floor());
    let usable_tokens = (max_context - reserved).max(2_048.0);
    let usable_chars = (usable_tokens * CONTEXT_CHAR_PER_TOKEN)
        .floor()
        .max(4_096.0);
    let scaled = |ratio: f64, min: usize, max: usize| {
        (usable_chars * ratio).clamp(min as f64, max as f64).floor() as usize
    };
    Budgets {
        settings_field: scaled(0.015, 800, 24_000),
        settings_section: scaled(0.12, 8_000, 240_000),
        project_memos: scaled(0.08, 5_000, 160_000),
        previous_summary: scaled(0.035, 2_200, 70_000),
        current_memo: scaled(0.06, 3_500, 120_000),
    }
}

fn positive(settings: &Value, key: &str) -> Option<f64> {
    settings
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| *value > 0.0)
}

pub fn build_settings_context(state: &State, settings: &Value) -> String {
    let budgets = budgets(settings);
    let recent_conversation = state
        .chat
        .iter()
        .filter(|message| !message.exclude_from_context)
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|message| message.content.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let relevance = format!("{}\n{recent_conversation}", state.editor_text);

    let mut characters = state.characters.iter().collect::<Vec<_>>();
    characters.sort_by(|a, b| stable_id(a).cmp(&stable_id(b)));
    let mut worlds = state.world_entries.iter().collect::<Vec<_>>();
    worlds.sort_by(|a, b| stable_id(a).cmp(&stable_id(b)));

    let character_lines = limit_prompt_text(
        &characters
            .iter()
            .map(|entry| format_entry(entry, CHARACTER_FIELDS, budgets.settings_field))
            .collect::<Vec<_>>()
            .join("\n\n"),
        budgets.settings_section,
        "head",
    );
    let world_lines = limit_prompt_text(
        &worlds
            .iter()
            .map(|entry| format_entry(entry, WORLD_FIELDS, budgets.settings_field))
            .collect::<Vec<_>>()
            .join("\n\n"),
        budgets.settings_section,
        "head",
    );
    let relationship_lines = limit_prompt_text(
        &format_relationships(state),
        budgets.settings_section,
        "head",
    );

    let mut parts = vec![
        format!("【世界観設定】\n{}", nonempty_or_unset(&world_lines)),
        format!(
            "【キャラクター設定】\n{}",
            nonempty_or_unset(&character_lines)
        ),
        format!("【人間関係】\n{}", nonempty_or_unset(&relationship_lines)),
    ];

    let project_memos = limit_prompt_text(
        &state
            .project_memos
            .iter()
            .map(|memo| {
                format!(
                    "■ {}\n{}",
                    text(memo, "title")
                        .filter(|value| !value.is_empty())
                        .unwrap_or("（無題）"),
                    text(memo, "content").unwrap_or_default()
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n"),
        budgets.project_memos,
        "head",
    );
    if !project_memos.trim().is_empty() {
        parts.push(format!("【作品メモ】\n{project_memos}"));
    }

    if let Some(current_id) = state.current_episode_id.as_deref() {
        let current_order = state
            .episodes
            .iter()
            .find(|episode| episode.id == current_id)
            .map(|episode| episode.order)
            .unwrap_or(0);
        let mut previous = state
            .episodes
            .iter()
            .filter(|episode| episode.order < current_order)
            .collect::<Vec<_>>();
        previous.sort_by_key(|episode| episode.order);
        let summaries = previous
            .into_iter()
            .rev()
            .take(3)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .filter_map(|episode| {
                let content = state
                    .summaries
                    .get("summaries")?
                    .get(&episode.id)?
                    .get("content")?
                    .as_str()?
                    .trim();
                (!content.is_empty()).then(|| {
                    format!(
                        "■ {}\n{}",
                        episode.title,
                        limit_prompt_text(content, budgets.previous_summary, "head")
                    )
                })
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        if !summaries.is_empty() {
            parts.push(format!("【直近3話のあらすじ】\n{summaries}"));
        }
        if let Some(memo) = state
            .memos
            .get("memos")
            .and_then(|memos| memos.get(current_id))
            .and_then(|memo| memo.as_str().or_else(|| memo.get("content")?.as_str()))
            .map(str::trim)
            .filter(|memo| !memo.is_empty())
        {
            parts.push(format!(
                "【本章の覚え書き】\n{}",
                limit_prompt_text(memo, budgets.current_memo, "head")
            ));
        }
    }

    let mut relevant = Vec::new();
    for entry in characters.into_iter().chain(worlds) {
        for key in ["name", "reading", "alias", "category"] {
            if let Some(term) = text(entry, key)
                .map(str::trim)
                .filter(|term| !term.is_empty())
            {
                if relevance.contains(term) {
                    if let Some(name) = text(entry, "name") {
                        relevant.push(name.to_owned());
                    }
                    break;
                }
            }
        }
    }
    let mut seen = HashSet::new();
    relevant.retain(|name| seen.insert(name.clone()));
    if !relevant.is_empty() {
        parts.push(format!(
            "【現在の本文・会話で言及された項目】\n{}",
            relevant.join("、")
        ));
    }
    parts.join("\n\n")
}

pub fn mentioned_character_names(state: &State, context: &str) -> Vec<String> {
    let tail = tail_chars(context, 3_000);
    let mut found = state
        .characters
        .iter()
        .filter_map(|character| {
            let mut last = None;
            for key in ["name", "reading", "alias"] {
                for candidate in text(character, key)
                    .unwrap_or_default()
                    .split(['\n', ',', '、'])
                    .map(str::trim)
                    .filter(|candidate| candidate.chars().count() >= 2)
                {
                    if let Some(index) = tail.rfind(candidate) {
                        last = Some(last.map_or(index, |current: usize| current.max(index)));
                    }
                }
            }
            Some((text(character, "name")?.to_owned(), last?))
        })
        .collect::<Vec<_>>();
    found.sort_by_key(|(_, index)| std::cmp::Reverse(*index));
    found.into_iter().take(3).map(|(name, _)| name).collect()
}

pub fn fiction_references(state: &State, settings: &Value, context: &str) -> FictionReferences {
    FictionReferences {
        settings_context: build_settings_context(state, settings),
        character_names: mentioned_character_names(state, context),
        character_excerpts: context.to_string(),
        related_scenes: None,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchRequest<'a> {
    project_id: &'a str,
    query: &'a str,
    limit: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchResult {
    episode_id: String,
    title: String,
    doc_type: String,
    snippet: String,
}

pub async fn build_related_scenes(
    project_id: &str,
    current_episode_id: Option<&str>,
    character_names: &[String],
) -> Option<String> {
    let mut used = HashSet::new();
    let mut sections = Vec::new();
    for name in character_names.iter().take(3) {
        let result: Result<Vec<SearchResult>, _> = invoke::invoke(
            "search_episodes",
            &serde_json::json!({"req":SearchRequest { project_id, query:name, limit:5 }}),
        )
        .await;
        let Ok(results) = result else { continue };
        let candidates = results
            .iter()
            .filter(|item| Some(item.episode_id.as_str()) != current_episode_id)
            .filter(|item| !used.contains(&item.episode_id))
            .collect::<Vec<_>>();
        let chosen = candidates
            .iter()
            .find(|item| item.doc_type == "fullText")
            .copied()
            .or_else(|| candidates.first().copied());
        let Some(chosen) = chosen else { continue };
        used.insert(chosen.episode_id.clone());
        sections.push(format!(
            "● {name}（「{}」より）:\n{}",
            chosen.title,
            limit_prompt_text(&chosen.snippet, 400, "middle")
        ));
    }
    let block = limit_prompt_text(&sections.join("\n\n"), 2_400, "head");
    (!block.trim().is_empty()).then_some(block)
}

fn stable_id(value: &Value) -> String {
    text(value, "id")
        .or_else(|| text(value, "name"))
        .unwrap_or_default()
        .to_owned()
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn nonempty_or_unset(value: &str) -> &str {
    if value.trim().is_empty() {
        "（未登録）"
    } else {
        value
    }
}

const CHARACTER_FIELDS: &[(&str, &str)] = &[
    ("名前", "name"),
    ("よみがな", "reading"),
    ("別名", "alias"),
    ("役割", "role"),
    ("性別", "gender"),
    ("年齢", "age"),
    ("誕生日", "birthday"),
    ("血液型", "bloodType"),
    ("身長", "height"),
    ("体重", "weight"),
    ("見た目", "appearance"),
    ("性格", "personality"),
    ("個性", "individuality"),
    ("能力・スキル", "skills"),
    ("特技", "specialSkills"),
    ("生い立ち", "upbringing"),
    ("背景", "background"),
    ("メモ", "notes"),
];

const WORLD_FIELDS: &[(&str, &str)] = &[
    ("名前", "name"),
    ("カテゴリ", "category"),
    ("時代", "era"),
    ("地理・場所", "geography"),
    ("気候", "climate"),
    ("人口", "population"),
    ("政治", "politics"),
    ("法律", "laws"),
    ("経済", "economy"),
    ("軍事", "military"),
    ("宗教", "religion"),
    ("言語", "language"),
    ("文化", "culture"),
    ("歴史", "history"),
    ("技術・魔術体系", "technology"),
    ("メモ", "notes"),
];

fn format_entry(value: &Value, fields: &[(&str, &str)], field_budget: usize) -> String {
    let name = text(value, "name")
        .filter(|name| !name.is_empty())
        .unwrap_or("（無題）");
    let mut lines = Vec::new();
    for (label, key) in fields {
        if let Some(content) = text(value, key)
            .map(str::trim)
            .filter(|content| !content.is_empty())
        {
            lines.push(format!(
                "  - {label}: {}",
                limit_prompt_text(content, field_budget, "head")
            ));
        }
    }
    if let Some(custom) = value.get("customFields").and_then(Value::as_array) {
        for field in custom {
            let label = text(field, "label")
                .filter(|label| !label.is_empty())
                .unwrap_or("カスタム");
            if let Some(content) = text(field, "value")
                .map(str::trim)
                .filter(|content| !content.is_empty())
            {
                lines.push(format!(
                    "  - {label}: {}",
                    limit_prompt_text(content, field_budget, "head")
                ));
            }
        }
    }
    if lines.is_empty() {
        format!("■ {name}")
    } else {
        format!("■ {name}\n{}", lines.join("\n"))
    }
}

fn format_relationships(state: &State) -> String {
    if let Some(groups) = state.relationships.get("groups").and_then(Value::as_array) {
        return groups
            .iter()
            .map(|group| {
                let episode_id = text(group, "episodeId").unwrap_or_default();
                let title = if episode_id.is_empty() {
                    "■ 全体（全話共通）".to_owned()
                } else {
                    format!(
                        "■ {}",
                        state
                            .episodes
                            .iter()
                            .find(|episode| episode.id == episode_id)
                            .map(|episode| episode.title.as_str())
                            .unwrap_or("（無題）")
                    )
                };
                let lines = group
                    .get("relationships")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(|relation| relationship_line(relation, state))
                    .collect::<Vec<_>>()
                    .join("\n");
                format!("{title}\n{lines}")
            })
            .collect::<Vec<_>>()
            .join("\n\n");
    }
    state
        .relationships
        .get("relationships")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|relation| relationship_line(relation, state))
        .collect::<Vec<_>>()
        .join("\n")
}

fn relationship_line(relation: &Value, state: &State) -> String {
    let name = |id: &str| {
        state
            .characters
            .iter()
            .find(|character| text(character, "id") == Some(id))
            .and_then(|character| text(character, "name"))
            .unwrap_or("（不明）")
    };
    let a = name(text(relation, "characterAId").unwrap_or_default());
    let b = name(text(relation, "characterBId").unwrap_or_default());
    let arrow = match text(relation, "direction") {
        Some("a-to-b") => "→",
        Some("b-to-a") => "←",
        _ => "↔",
    };
    format!(
        "  - {a} {arrow} {b}: {}",
        text(relation, "description")
            .filter(|value| !value.is_empty())
            .unwrap_or("（説明なし）")
    )
}

fn tail_chars(value: &str, count: usize) -> String {
    value
        .chars()
        .rev()
        .take(count)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mentioned_names_follow_last_mention_order() {
        let mut state = State::default();
        state.characters = vec![
            serde_json::json!({"id":"1","name":"春香"}),
            serde_json::json!({"id":"2","name":"美咲"}),
        ];
        assert_eq!(
            mentioned_character_names(&state, "美咲が来た。春香が振り返った。"),
            vec!["春香", "美咲"]
        );
    }

    #[test]
    fn settings_context_contains_canon_sections() {
        let mut state = State::default();
        state.characters = vec![serde_json::json!({"id":"1","name":"春香","personality":"慎重"})];
        state.world_entries = vec![serde_json::json!({"id":"w","name":"王都","culture":"夜市"})];
        let context = build_settings_context(
            &state,
            &serde_json::json!({"maxContextTokens":65536,"maxTokens":8192}),
        );
        assert!(context.contains("【世界観設定】"));
        assert!(context.contains("王都"));
        assert!(context.contains("【キャラクター設定】"));
        assert!(context.contains("春香"));
    }
}
