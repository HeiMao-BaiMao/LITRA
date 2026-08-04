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

#[derive(Debug)]
struct PendingServerBlock {
    block: Value,
    input_json: String,
}

#[derive(Debug, Default)]
struct PendingThinkingBlock {
    thinking: String,
    signature: Option<String>,
}

#[derive(Debug, Default)]
pub struct StreamState {
    pending: HashMap<String, PendingToolCall>,
    pending_server_blocks: HashMap<String, PendingServerBlock>,
    pending_thinking_blocks: HashMap<String, PendingThinkingBlock>,
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

    pub fn start_server_block(&mut self, key: String, block: Value) {
        self.pending_server_blocks.insert(
            key,
            PendingServerBlock {
                block,
                input_json: String::new(),
            },
        );
    }

    pub fn is_server_block(&self, key: &str) -> bool {
        self.pending_server_blocks.contains_key(key)
    }

    pub fn append_server_input(&mut self, key: &str, delta: &str) {
        if let Some(block) = self.pending_server_blocks.get_mut(key) {
            block.input_json.push_str(delta);
        }
    }

    pub fn finish_server_block(&mut self, key: &str) -> Option<Value> {
        let mut pending = self.pending_server_blocks.remove(key)?;
        if !pending.input_json.trim().is_empty() {
            if let Ok(input) = serde_json::from_str::<Value>(&pending.input_json) {
                if let Some(block) = pending.block.as_object_mut() {
                    block.insert("input".into(), input);
                }
            }
        }
        Some(pending.block)
    }

    pub fn start_thinking(&mut self, key: String, block: &Value) {
        let thinking = block
            .get("thinking")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let signature = block
            .get("signature")
            .and_then(Value::as_str)
            .map(str::to_owned);
        self.pending_thinking_blocks.insert(
            key,
            PendingThinkingBlock {
                thinking,
                signature,
            },
        );
    }

    pub fn append_thinking(&mut self, key: &str, delta: &str) {
        if let Some(block) = self.pending_thinking_blocks.get_mut(key) {
            block.thinking.push_str(delta);
        }
    }

    pub fn set_thinking_signature(&mut self, key: &str, signature: &str) {
        if let Some(block) = self.pending_thinking_blocks.get_mut(key) {
            block.signature = Some(signature.to_owned());
        }
    }

    pub fn finish_thinking(&mut self, key: &str) -> Option<Value> {
        let block = self.pending_thinking_blocks.remove(key)?;
        let mut value = serde_json::Map::new();
        value.insert("type".into(), Value::String("thinking".into()));
        value.insert("thinking".into(), Value::String(block.thinking));
        if let Some(signature) = block.signature {
            value.insert("signature".into(), Value::String(signature));
        }
        Some(Value::Object(value))
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

    #[test]
    fn reconstructs_server_tool_input_without_exposing_it_as_a_client_call() {
        let mut state = StreamState::default();
        state.start_server_block(
            "1".into(),
            serde_json::json!({
                "type": "server_tool_use",
                "id": "srv-1",
                "name": "web_search",
                "input": {}
            }),
        );
        state.append_server_input("1", "{\"query\":");
        state.append_server_input("1", "\"latest\"}");
        let block = state.finish_server_block("1").expect("server block");
        assert_eq!(block["type"], "server_tool_use");
        assert_eq!(block["input"]["query"], "latest");
        assert!(!state.is_server_block("1"));
    }
}
