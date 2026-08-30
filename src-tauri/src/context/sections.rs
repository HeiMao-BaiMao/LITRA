//! World-state sections for LITRA project context.

use super::WorldStateSection;
use serde_json::Value;
use std::collections::HashSet;

/// Characters section: injected when character definitions change.
#[derive(Clone, Default)]
pub struct CharactersSection {
    characters: Vec<CharacterEntry>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct CharacterEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub description: String,
}

impl CharactersSection {
    pub fn new(characters: Vec<CharacterEntry>) -> Self {
        Self { characters }
    }

    pub fn update(&mut self, characters: Vec<CharacterEntry>) {
        self.characters = characters;
    }

    pub fn is_empty(&self) -> bool {
        self.characters.is_empty()
    }
}

impl WorldStateSection for CharactersSection {
    fn id() -> &'static str {
        "project.characters"
    }

    fn section_id(&self) -> &'static str {
        Self::id()
    }

    fn snapshot(&self) -> Option<Value> {
        serde_json::to_value(&self.characters).ok()
    }

    fn restore(&mut self, snapshot: &Value) -> Result<(), String> {
        self.characters = serde_json::from_value(snapshot.clone())
            .map_err(|e| format!("failed to restore characters: {e}"))?;
        Ok(())
    }

    fn render_diff(&self, previous: Option<&Value>) -> Option<String> {
        if self.is_empty() {
            return None;
        }
        if let Some(prev) = previous {
            if let Ok(prev_chars) = serde_json::from_value::<Vec<CharacterEntry>>(prev.clone()) {
                let current: HashSet<_> = self.characters.iter().map(|c| &c.id).collect();
                let prev_set: HashSet<_> = prev_chars.iter().map(|c| &c.id).collect();
                if current == prev_set
                    && serde_json::to_value(&self.characters).ok().as_ref() == Some(prev)
                {
                    return None;
                }
            }
        }
        Some(render_characters(&self.characters))
    }

    fn should_persist(&self) -> bool {
        !self.is_empty()
    }
}

fn render_characters(characters: &[CharacterEntry]) -> String {
    let mut out = String::from("<project_characters>\n");
    out.push_str("以下のキャラクターが定義されています。執筆時に参照してください。\n\n");
    for ch in characters {
        out.push_str(&format!("### {}\n", ch.name));
        if !ch.role.is_empty() {
            out.push_str(&format!("- 役割: {}\n", ch.role));
        }
        if !ch.description.is_empty() {
            out.push_str(&format!("- {}\n", ch.description));
        }
        out.push('\n');
    }
    out.push_str("</project_characters>");
    out
}

/// World settings section: injected when world-building entries change.
#[derive(Clone, Default)]
pub struct WorldSection {
    entries: Vec<WorldEntry>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct WorldEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub description: String,
}

impl WorldSection {
    pub fn new(entries: Vec<WorldEntry>) -> Self {
        Self { entries }
    }

    pub fn update(&mut self, entries: Vec<WorldEntry>) {
        self.entries = entries;
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

impl WorldStateSection for WorldSection {
    fn id() -> &'static str {
        "project.world"
    }

    fn section_id(&self) -> &'static str {
        Self::id()
    }

    fn snapshot(&self) -> Option<Value> {
        serde_json::to_value(&self.entries).ok()
    }

    fn restore(&mut self, snapshot: &Value) -> Result<(), String> {
        self.entries = serde_json::from_value(snapshot.clone())
            .map_err(|e| format!("failed to restore world entries: {e}"))?;
        Ok(())
    }

    fn render_diff(&self, previous: Option<&Value>) -> Option<String> {
        if self.is_empty() {
            return None;
        }
        if let Some(prev) = previous {
            if serde_json::to_value(&self.entries).ok().as_ref() == Some(prev) {
                return None;
            }
        }
        Some(render_world(&self.entries))
    }

    fn should_persist(&self) -> bool {
        !self.is_empty()
    }
}

fn render_world(entries: &[WorldEntry]) -> String {
    let mut out = String::from("<project_world>\n");
    out.push_str("以下の世界観設定が定義されています。\n\n");
    for entry in entries {
        out.push_str(&format!("### {}", entry.name));
        if !entry.category.is_empty() {
            out.push_str(&format!(" [{}]", entry.category));
        }
        out.push('\n');
        if !entry.description.is_empty() {
            out.push_str(&format!("{}\n", entry.description));
        }
        out.push('\n');
    }
    out.push_str("</project_world>");
    out
}

/// Episode summaries section: compact representation of past episodes.
#[derive(Clone, Default)]
pub struct EpisodeSummarySection {
    summaries: Vec<EpisodeSummary>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct EpisodeSummary {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub one_liner: String,
    #[serde(default)]
    pub summary: String,
}

impl EpisodeSummarySection {
    pub fn new(summaries: Vec<EpisodeSummary>) -> Self {
        Self { summaries }
    }

    pub fn update(&mut self, summaries: Vec<EpisodeSummary>) {
        self.summaries = summaries;
    }

    pub fn is_empty(&self) -> bool {
        self.summaries.is_empty()
    }
}

impl WorldStateSection for EpisodeSummarySection {
    fn id() -> &'static str {
        "project.episode_summaries"
    }

    fn section_id(&self) -> &'static str {
        Self::id()
    }

    fn snapshot(&self) -> Option<Value> {
        serde_json::to_value(&self.summaries).ok()
    }

    fn restore(&mut self, snapshot: &Value) -> Result<(), String> {
        self.summaries = serde_json::from_value(snapshot.clone())
            .map_err(|e| format!("failed to restore episode summaries: {e}"))?;
        Ok(())
    }

    fn render_diff(&self, previous: Option<&Value>) -> Option<String> {
        if self.is_empty() {
            return None;
        }
        if let Some(prev) = previous {
            if serde_json::to_value(&self.summaries).ok().as_ref() == Some(prev) {
                return None;
            }
        }
        Some(render_summaries(&self.summaries))
    }

    fn should_persist(&self) -> bool {
        !self.summaries.is_empty()
    }
}

fn render_summaries(summaries: &[EpisodeSummary]) -> String {
    let mut out = String::from("<episode_summaries>\n");
    out.push_str("過去のエピソード要約:\n\n");
    for s in summaries {
        out.push_str(&format!("- **{}**", s.title));
        if !s.one_liner.is_empty() {
            out.push_str(&format!(": {}", s.one_liner));
        }
        out.push('\n');
        if !s.summary.is_empty() {
            let truncated = if s.summary.len() > 200 {
                format!("{}...", &s.summary[..200])
            } else {
                s.summary.clone()
            };
            out.push_str(&format!("  {}\n", truncated));
        }
    }
    out.push_str("\n</episode_summaries>");
    out
}

/// Writing rules / style guide section (persistent developer instructions).
#[derive(Clone, Default)]
pub struct WritingRulesSection {
    rules: String,
}

impl WritingRulesSection {
    pub fn new(rules: String) -> Self {
        Self { rules }
    }

    pub fn update(&mut self, rules: String) {
        self.rules = rules;
    }

    pub fn is_empty(&self) -> bool {
        self.rules.trim().is_empty()
    }
}

impl WorldStateSection for WritingRulesSection {
    fn id() -> &'static str {
        "project.writing_rules"
    }

    fn section_id(&self) -> &'static str {
        Self::id()
    }

    fn snapshot(&self) -> Option<Value> {
        Some(Value::String(self.rules.clone()))
    }

    fn restore(&mut self, snapshot: &Value) -> Result<(), String> {
        self.rules = snapshot
            .as_str()
            .ok_or("writing_rules snapshot must be a string")?
            .to_string();
        Ok(())
    }

    fn render_diff(&self, previous: Option<&Value>) -> Option<String> {
        if self.is_empty() {
            return None;
        }
        if let Some(Value::String(prev)) = previous {
            if prev == &self.rules {
                return None;
            }
        }
        Some(format!("<writing_rules>\n{}\n</writing_rules>", self.rules))
    }

    fn should_persist(&self) -> bool {
        !self.is_empty()
    }
}

/// Compaction summary section (Codex pattern: preserve context after compaction).
#[derive(Clone, Default)]
pub struct CompactionSummarySection {
    summary: Option<String>,
}

impl CompactionSummarySection {
    pub fn set_summary(&mut self, summary: String) {
        self.summary = Some(summary);
    }

    pub fn clear(&mut self) {
        self.summary = None;
    }
}

impl WorldStateSection for CompactionSummarySection {
    fn id() -> &'static str {
        "context.compaction_summary"
    }

    fn section_id(&self) -> &'static str {
        Self::id()
    }

    fn snapshot(&self) -> Option<Value> {
        self.summary.as_ref().map(|s| Value::String(s.clone()))
    }

    fn restore(&mut self, snapshot: &Value) -> Result<(), String> {
        self.summary = snapshot.as_str().map(|s| s.to_string());
        Ok(())
    }

    fn render_diff(&self, _previous: Option<&Value>) -> Option<String> {
        self.summary.as_ref().map(|s| {
            format!(
                "<conversation_summary>\n以下は以前の会話の要約:\n{}\n</conversation_summary>",
                s
            )
        })
    }

    fn should_persist(&self) -> bool {
        self.summary.is_some()
    }
}
