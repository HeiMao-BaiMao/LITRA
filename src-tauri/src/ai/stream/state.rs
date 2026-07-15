use std::collections::HashMap;

use serde_json::Value;

#[derive(Debug)]
pub struct CompletedToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
}

#[derive(Debug, Default)]
struct PendingToolCall {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Debug, Default)]
pub struct StreamState {
    pending: HashMap<String, PendingToolCall>,
    next_generated_id: u64,
}

impl StreamState {
    pub fn start(&mut self, key: String, id: String, name: String) -> bool {
        if let Some(pending) = self.pending.get_mut(&key) {
            if !id.is_empty() {
                pending.id = id;
            }
            if !name.is_empty() {
                pending.name = name;
            }
            return false;
        }
        self.pending.insert(
            key,
            PendingToolCall {
                id,
                name,
                arguments: String::new(),
            },
        );
        true
    }

    pub fn append(&mut self, key: &str, delta: &str) {
        if let Some(pending) = self.pending.get_mut(key) {
            pending.arguments.push_str(delta);
        }
    }

    pub fn identity(&self, key: &str) -> Option<(&str, &str)> {
        self.pending
            .get(key)
            .map(|pending| (pending.id.as_str(), pending.name.as_str()))
    }

    pub fn finish(&mut self, key: &str, arguments: Option<&str>) -> Option<CompletedToolCall> {
        let mut pending = self.pending.remove(key)?;
        if let Some(arguments) = arguments {
            pending.arguments = arguments.to_owned();
        }
        let input = if pending.arguments.trim().is_empty() {
            Value::Object(Default::default())
        } else {
            serde_json::from_str(&pending.arguments).unwrap_or(Value::String(pending.arguments))
        };
        Some(CompletedToolCall {
            id: pending.id,
            name: pending.name,
            input,
        })
    }

    pub fn generated_id(&mut self, prefix: &str) -> String {
        self.next_generated_id += 1;
        format!("{prefix}-{}", self.next_generated_id)
    }

    pub fn finish_all(&mut self) -> Vec<CompletedToolCall> {
        let keys = self.pending.keys().cloned().collect::<Vec<_>>();
        keys.iter()
            .filter_map(|key| self.finish(key, None))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconstructs_fragmented_tool_arguments() {
        let mut state = StreamState::default();
        assert!(state.start("0".into(), "call-1".into(), "lookup".into()));
        state.append("0", "{\"id\":");
        state.append("0", "\"42\"}");
        let call = state.finish("0", None).expect("completed tool call");
        assert_eq!(call.id, "call-1");
        assert_eq!(call.name, "lookup");
        assert_eq!(call.input["id"], "42");
    }
}
