//! Project context persistence: save/load world state alongside project data.
//!
//! The context state is stored as `.litra/context.json` in the project directory,
//! following Codex's pattern of persisting conversation state with project files.

use serde::Deserialize;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

use crate::context::sections::{
    CharacterEntry, CharactersSection, EpisodeSummary, EpisodeSummarySection,
    WritingRulesSection, WorldEntry, WorldSection,
};
use crate::context::{
    WorldState, WorldStateMeta,
};
use serde_json::Value;

/// The full persisted context for a project.
#[derive(Serialize, Deserialize)]
pub struct ProjectContext {
    #[serde(flatten)]
    pub sections: HashMap<String, Value>,
    #[serde(default)]
    pub meta: WorldStateMeta,
}

impl Default for ProjectContext {
    fn default() -> Self {
        Self {
            sections: HashMap::new(),
            meta: WorldStateMeta::default(),
        }
    }
}

/// Build a fresh WorldState from project data.
pub fn build_world_state(
    characters: &[CharacterEntry],
    world_entries: &[WorldEntry],
    episode_summaries: &[EpisodeSummary],
    writing_rules: Option<&str>,
) -> WorldState {
    let mut state = WorldState::new();

    let chars = CharactersSection::new(characters.to_vec());
    if !chars.is_empty() {
        state.register(Box::new(chars));
    }

    let world = WorldSection::new(world_entries.to_vec());
    if !world.is_empty() {
        state.register(Box::new(world));
    }

    let summaries = EpisodeSummarySection::new(episode_summaries.to_vec());
    if !summaries.is_empty() {
        state.register(Box::new(summaries));
    }

    if let Some(rules) = writing_rules {
        let rules_section = WritingRulesSection::new(rules.to_string());
        if !rules_section.is_empty() {
            state.register(Box::new(rules_section));
        }
    }

    state
}

/// Save the world state to a project directory.
pub fn save_context(project_dir: &Path, context: &ProjectContext) -> Result<(), String> {
    let context_dir = project_dir.join(".litra");
    fs::create_dir_all(&context_dir)
        .map_err(|e| format!("failed to create .litra dir: {e}"))?;

    let path = context_dir.join("context.json");
    let json = serde_json::to_string_pretty(context)
        .map_err(|e| format!("failed to serialize context: {e}"))?;

    // Atomic write: write to temp file then rename
    let temp_path = path.with_extension("tmp");
    fs::write(&temp_path, &json).map_err(|e| format!("failed to write context tmp: {e}"))?;
    fs::rename(&temp_path, &path).map_err(|e| format!("failed to rename context: {e}"))?;

    Ok(())
}

/// Load the world state from a project directory.
pub fn load_context(project_dir: &Path) -> Result<ProjectContext, String> {
    let path = project_dir.join(".litra").join("context.json");
    if !path.exists() {
        return Ok(ProjectContext::default());
    }

    let json = fs::read_to_string(&path)
        .map_err(|e| format!("failed to read context.json: {e}"))?;

    serde_json::from_str(&json)
        .map_err(|e| format!("failed to parse context.json: {e}"))
}

/// Capture the current state of a WorldState for persistence.
pub fn capture_context(state: &WorldState, meta: WorldStateMeta) -> ProjectContext {
    ProjectContext {
        sections: state.snapshot_all(),
        meta,
    }
}

/// Restore a WorldState from persisted context.
///
/// Note: sections must be registered first via `build_world_state` before
/// calling this. This only restores data, not structure.
pub fn restore_context(state: &mut WorldState, context: &ProjectContext) -> Result<(), String> {
    state.restore_all(&context.sections)
}

/// Render all context sections for injection into AI system prompt.
pub fn render_context_for_ai(state: &WorldState, previous: Option<&ProjectContext>) -> String {
    let prev_snapshot = previous.map(|c| &c.sections);
    let sections = match prev_snapshot {
        Some(prev) => state.render_changed(prev),
        None => state.render_all(),
    };

    if sections.is_empty() {
        return String::new();
    }

    let mut output = String::from("\n\n---\n\n# プロジェクト情報\n\n");
    for (_, text) in &sections {
        output.push_str(text);
        output.push_str("\n\n");
    }
    output
}

/// Check if context has changed since last save.
pub fn has_context_changed(
    state: &WorldState,
    previous: &ProjectContext,
) -> bool {
    state.snapshot_all() != previous.sections
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("litra-context-test-{}", std::process::id()))
    }

    #[test]
    fn test_save_and_load_context() {
        let dir = test_dir();
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let chars = vec![CharacterEntry {
            id: "c1".to_string(),
            name: "Test Character".to_string(),
            role: "Protagonist".to_string(),
            description: "A test character".to_string(),
        }];

        let state = build_world_state(&chars, &[], &[], None);
        let context = capture_context(&state, WorldStateMeta::default());

        save_context(&dir, &context).unwrap();
        let loaded = load_context(&dir).unwrap();

        assert_eq!(loaded.sections.len(), 1);
        assert!(loaded.sections.contains_key("project.characters"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_render_context_for_ai() {
        let chars = vec![CharacterEntry {
            id: "c1".to_string(),
            name: "Test".to_string(),
            role: "Hero".to_string(),
            description: "Brave hero".to_string(),
        }];

        let state = build_world_state(&chars, &[], &[], None);
        let rendered = render_context_for_ai(&state, None);

        assert!(rendered.contains("Test"));
        assert!(rendered.contains("Hero"));
        assert!(rendered.contains("project_characters"));
    }

    #[test]
    fn test_empty_context() {
        let state = build_world_state(&[], &[], &[], None);
        let rendered = render_context_for_ai(&state, None);
        assert!(rendered.is_empty());
    }

    #[test]
    fn test_context_changed() {
        let chars = vec![CharacterEntry {
            id: "c1".to_string(),
            name: "Test".to_string(),
            role: "Hero".to_string(),
            description: "Brave".to_string(),
        }];

        let state = build_world_state(&chars, &[], &[], None);
        let mut context = capture_context(&state, WorldStateMeta::default());

        assert!(!has_context_changed(&state, &context));

        // Modify and check change detection
        context.sections.remove("project.characters");
        assert!(has_context_changed(&state, &context));
    }
}
