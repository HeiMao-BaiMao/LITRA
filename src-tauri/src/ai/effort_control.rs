//! Stable reasoning-effort planning for GPT-6 Astra
//! (oh-my-pi `openai-configuration-update.ts` port).
//!
//! The request-level `reasoning.effort` is pinned to the session's first value
//! so the cached prompt prefix survives an effort change. Each later change is
//! carried as a `configuration_update` input item spliced into the transcript
//! and replayed at that position on every subsequent request until another
//! update overrides it.
//!
//! Wire constraints (verified against the Codex backend upstream): only
//! `gpt-6-astra` accepts the item type, consecutive updates are rejected, and
//! `/responses/compact` rejects histories containing them.

use std::{
    collections::{HashMap, VecDeque},
    hash::{Hash, Hasher},
    sync::{LazyLock, Mutex},
};

use serde_json::Value;

/// Per-conversation effort baseline and recorded transitions.
#[derive(Clone, Debug, Default)]
pub struct EffortControlState {
    base_effort: Option<String>,
    current_effort: Option<String>,
    transitions: Vec<EffortTransition>,
}

#[derive(Clone, Debug)]
struct EffortTransition {
    /// Input-array position the item is spliced into (before `input[index]`).
    index: usize,
    /// Fingerprint of `input[index - 1]` at record time; a mismatch means the
    /// history was rewritten.
    anchor: u64,
    effort: String,
}

/// Bounded per-session map of control states (LRU eviction).
#[derive(Debug, Default)]
pub struct EffortControlStates {
    map: HashMap<String, EffortControlState>,
    order: VecDeque<String>,
}

const MAX_EFFORT_CONTROL_STATES: usize = 16;

static STATES: LazyLock<Mutex<EffortControlStates>> =
    LazyLock::new(|| Mutex::new(EffortControlStates::default()));

/// Plan the wire effort for one request against the process-wide states.
/// `input` is the freshly built transcript (without `configuration_update`
/// items); transitions are spliced into it in place. Returns the effort to
/// send at the request level.
pub fn plan_stable_effort(key: &str, input: &mut Vec<Value>, requested: &str) -> String {
    STATES
        .lock()
        .map(|mut states| states.plan(key, input, requested))
        .unwrap_or_else(|_| requested.to_owned())
}

impl EffortControlStates {
    fn get(&mut self, key: &str) -> &mut EffortControlState {
        if self.map.contains_key(key) {
            if let Some(pos) = self.order.iter().position(|k| k == key) {
                self.order.remove(pos);
            }
            self.order.push_back(key.to_owned());
        } else {
            self.map.insert(key.to_owned(), EffortControlState::default());
            self.order.push_back(key.to_owned());
            while self.map.len() > MAX_EFFORT_CONTROL_STATES {
                if let Some(oldest) = self.order.pop_front() {
                    self.map.remove(&oldest);
                } else {
                    break;
                }
            }
        }
        self.map
            .get_mut(key)
            .expect("effort control state was just inserted")
    }

    fn plan(&mut self, key: &str, input: &mut Vec<Value>, requested: &str) -> String {
        let state = self.get(key);
        let mut intact = true;
        for transition in &state.transitions {
            if transition.index > input.len()
                || transition.anchor != effort_control_anchor(input, transition.index)
            {
                intact = false;
                break;
            }
        }
        if !intact {
            // The wire history shrank or was rewritten under a recorded
            // transition (compaction, branch switch, clear). Re-baseline from
            // the requested effort, which is what the API asks for anyway.
            state.base_effort = None;
            state.current_effort = None;
            state.transitions.clear();
        }
        if state.base_effort.is_none() {
            state.base_effort = Some(requested.to_owned());
            state.current_effort = Some(requested.to_owned());
            return requested.to_owned();
        }
        if state.current_effort.as_deref() != Some(requested) {
            let last_is_user =
                input.last().and_then(|item| item.get("role")).and_then(Value::as_str) == Some("user");
            let index = if last_is_user {
                input.len().saturating_sub(1)
            } else {
                input.len()
            };
            if let Some(existing) = state
                .transitions
                .iter_mut()
                .find(|transition| transition.index == index)
            {
                existing.effort = requested.to_owned();
            } else {
                state.transitions.push(EffortTransition {
                    index,
                    anchor: effort_control_anchor(input, index),
                    effort: requested.to_owned(),
                });
            }
            // A change back to the effort already in force at that position is
            // a no-op on the wire; drop it rather than send a redundant item.
            let mut preceding = state.base_effort.clone().unwrap_or_default();
            let mut preceding_index: isize = -1;
            for transition in &state.transitions {
                let at = transition.index as isize;
                if (index as isize) > at && at > preceding_index {
                    preceding = transition.effort.clone();
                    preceding_index = at;
                }
            }
            if requested == preceding {
                state
                    .transitions
                    .retain(|transition| transition.index != index);
            }
            state.current_effort = Some(requested.to_owned());
        }
        // Splice in ascending order so each insertion offsets only the ones
        // after it.
        state.transitions.sort_by_key(|transition| transition.index);
        for (offset, transition) in state.transitions.iter().enumerate() {
            input.insert(
                transition.index + offset,
                serde_json::json!({
                    "type": "configuration_update",
                    "reasoning": { "effort": transition.effort },
                }),
            );
        }
        state.base_effort.clone().unwrap_or_else(|| requested.to_owned())
    }
}

/// Fingerprint of the item a transition sits after. Output-only lifecycle
/// fields are excluded: a live response item carries `id`/`status` that the
/// sanitized replay of the same item drops.
fn effort_control_anchor(input: &[Value], index: usize) -> u64 {
    if index == 0 || index > input.len() {
        return 0;
    }
    let mut item = input[index - 1].clone();
    if let Value::Object(map) = &mut item {
        map.remove("id");
        map.remove("status");
    }
    let canonical = serde_json::to_string(&item).unwrap_or_default();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    canonical.hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn user(text: &str) -> Value {
        json!({ "role": "user", "content": text })
    }

    fn assistant(text: &str) -> Value {
        json!({ "role": "assistant", "content": text })
    }

    fn tool_result() -> Value {
        json!({ "type": "function_call_output", "call_id": "1", "output": "ok" })
    }

    fn updates(input: &[Value]) -> Vec<&Value> {
        input
            .iter()
            .filter(|item| item.get("type").and_then(Value::as_str) == Some("configuration_update"))
            .collect()
    }

    #[test]
    fn first_request_pins_baseline_without_items() {
        let mut states = EffortControlStates::default();
        let mut input = vec![user("hello")];
        assert_eq!(states.plan("k", &mut input, "medium"), "medium");
        assert!(updates(&input).is_empty());
    }

    #[test]
    fn change_is_carried_as_item_before_trailing_user_message() {
        let mut states = EffortControlStates::default();
        let mut first = vec![user("hello")];
        assert_eq!(states.plan("k", &mut first, "medium"), "medium");
        let mut second = vec![user("hello"), assistant("hi"), user("again")];
        // Request level stays pinned to the baseline.
        assert_eq!(states.plan("k", &mut second, "high"), "medium");
        let found = updates(&second);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0]["reasoning"]["effort"], json!("high"));
        // Spliced before the trailing user message (index 2 of 3).
        assert_eq!(second[2], found[0].clone());
        assert_eq!(second[3]["role"], json!("user"));
    }

    #[test]
    fn change_inside_tool_loop_appends_after_latest_tool_result() {
        let mut states = EffortControlStates::default();
        let mut first = vec![user("go")];
        assert_eq!(states.plan("k", &mut first, "low"), "low");
        let mut second = vec![user("go"), assistant("working"), tool_result()];
        assert_eq!(states.plan("k", &mut second, "high"), "low");
        let found = updates(&second);
        assert_eq!(found.len(), 1);
        assert_eq!(second[3], found[0].clone());
    }

    #[test]
    fn change_back_to_in_force_effort_is_dropped() {
        let mut states = EffortControlStates::default();
        let mut first = vec![user("a")];
        assert_eq!(states.plan("k", &mut first, "medium"), "medium");
        let mut second = vec![user("a"), assistant("b"), user("c")];
        assert_eq!(states.plan("k", &mut second, "high"), "medium");
        assert_eq!(updates(&second).len(), 1);
        // Back to the baseline that is still in force at that position.
        let mut third = vec![user("a"), assistant("b"), user("c")];
        assert_eq!(states.plan("k", &mut third, "medium"), "medium");
        assert!(updates(&third).is_empty());
    }

    #[test]
    fn rewritten_history_resets_and_rebaselines() {
        let mut states = EffortControlStates::default();
        let mut first = vec![user("a")];
        assert_eq!(states.plan("k", &mut first, "medium"), "medium");
        let mut second = vec![user("a"), assistant("b"), user("c")];
        assert_eq!(states.plan("k", &mut second, "high"), "medium");
        // Compaction rewrote the history under the recorded transition.
        let mut compacted = vec![user("summary"), user("c")];
        assert_eq!(states.plan("k", &mut compacted, "high"), "high");
        assert!(updates(&compacted).is_empty());
    }

    #[test]
    fn retry_with_same_input_is_stable() {
        let mut states = EffortControlStates::default();
        let mut first = vec![user("a")];
        assert_eq!(states.plan("k", &mut first, "medium"), "medium");
        let build = || vec![user("a"), assistant("b"), user("c")];
        let mut second = build();
        assert_eq!(states.plan("k", &mut second, "high"), "medium");
        // A retry rebuilds the same input: no duplicate item, same output.
        let mut retry = build();
        assert_eq!(states.plan("k", &mut retry, "high"), "medium");
        assert_eq!(retry, second);
    }

    #[test]
    fn states_are_isolated_per_key_and_bounded() {
        let mut states = EffortControlStates::default();
        for i in 0..(MAX_EFFORT_CONTROL_STATES + 4) {
            let mut input = vec![user("a")];
            states.plan(&format!("key-{i}"), &mut input, "low");
        }
        assert_eq!(states.map.len(), MAX_EFFORT_CONTROL_STATES);
        // Evicted keys re-baseline instead of reusing a stale baseline.
        let mut input = vec![user("a")];
        assert_eq!(states.plan("key-0", &mut input, "high"), "high");
    }
}
