//! World-state context system (inspired by Codex's `core/context/world_state`).
//!
//! Each section implements `WorldStateSection` and contributes to the AI's system
//! prompt. Sections are persisted as JSON alongside the project, and only
//! *changed* sections are re-injected on subsequent turns (diff-based injection).

pub mod minimizer;
pub mod project_context;
pub mod sections;
pub mod token_budget;

use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

/// Snapshot of a single world-state section, keyed by section ID.
pub type WorldStateSnapshot = HashMap<String, Value>;

/// Trait for a piece of project state that should persist across sessions
/// and be injected into AI context.
///
/// Note: `id()` is a static method (not object-safe) to allow downcasting.
/// Use `section_id()` for runtime ID access on trait objects.
pub trait WorldStateSection: Send + Sync {
    /// Stable identifier for this section (e.g. `"project.characters"`).
    fn id() -> &'static str
    where
        Self: Sized;

    /// Instance ID for trait objects.
    ///
    /// Default implementation returns `Self::id()`. Override for per-instance IDs.
    fn section_id(&self) -> &'static str;

    /// Serialize the current state to a JSON snapshot.
    fn snapshot(&self) -> Option<Value>;

    /// Restore state from a JSON snapshot.
    fn restore(&mut self, snapshot: &Value) -> Result<(), String>;

    /// Render this section as text for the AI system prompt.
    ///
    /// `previous` is the snapshot from the last turn. Implementations should
    /// return `None` when nothing changed (avoids cache misses), or `Some(text)`
    /// when the content needs updating.
    fn render_diff(&self, previous: Option<&Value>) -> Option<String>;

    /// Whether this section should be persisted to disk.
    fn should_persist(&self) -> bool {
        true
    }
}

/// Container that manages all world-state sections for a project.
#[derive(Default)]
pub struct WorldState {
    sections: HashMap<String, Box<dyn WorldStateSection>>,
}

impl WorldState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, section: Box<dyn WorldStateSection>) {
        let id = section.section_id().to_string();
        self.sections.insert(id, section);
    }

    /// Render all sections that changed since `previous_snapshot`.
    pub fn render_changed(&self, previous: &WorldStateSnapshot) -> Vec<(String, String)> {
        let mut output = Vec::new();
        for (id, section) in &self.sections {
            let prev = previous.get(id);
            if let Some(text) = section.render_diff(prev) {
                output.push((id.clone(), text));
            }
        }
        output
    }

    /// Render all sections (full context, for new sessions).
    pub fn render_all(&self) -> Vec<(String, String)> {
        self.sections
            .iter()
            .filter_map(|(id, section)| {
                section.render_diff(None).map(|text| (id.clone(), text))
            })
            .collect()
    }

    /// Capture a full snapshot for persistence.
    pub fn snapshot_all(&self) -> WorldStateSnapshot {
        self.sections
            .iter()
            .filter_map(|(id, section)| {
                if section.should_persist() {
                    section.snapshot().map(|val| (id.clone(), val))
                } else {
                    None
                }
            })
            .collect()
    }

    /// Restore all sections from a snapshot.
    pub fn restore_all(&mut self, snapshot: &WorldStateSnapshot) -> Result<(), String> {
        for (id, value) in snapshot {
            if let Some(section) = self.sections.get_mut(id) {
                section.restore(value)?;
            }
        }
        Ok(())
    }
}

/// Metadata persisted alongside project context.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorldStateMeta {
    pub schema_version: u32,
    #[serde(default)]
    pub last_compaction: Option<CompactionSnapshot>,
}

impl Default for WorldStateMeta {
    fn default() -> Self {
        Self {
            schema_version: 1,
            last_compaction: None,
        }
    }
}

/// Record of a compaction event (Codex's CompactionSummary pattern).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CompactionSnapshot {
    pub timestamp: String,
    pub original_message_count: usize,
    pub summary: String,
    pub preserved_recent_count: usize,
    pub tokens_before: Option<u64>,
    pub tokens_after: Option<u64>,
}
