use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderApiType {
    OpenaiResponses,
    OpenaiChat,
    AnthropicMessages,
    GoogleGenerateContent,
}

#[derive(Clone, Debug, Deserialize)]
pub struct AiInputMessage {
    pub role: String,
    pub content: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiToolDefinition {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTextRequest {
    pub request_id: String,
    pub provider: String,
    pub api_type: ProviderApiType,
    #[serde(default)]
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub system: String,
    #[serde(default)]
    pub messages: Vec<AiInputMessage>,
    #[serde(default)]
    pub tools: Vec<AiToolDefinition>,
    pub tool_choice: Option<String>,
    #[serde(default)]
    pub prompt: String,
    pub max_output_tokens: u64,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub top_k: Option<u64>,
    pub frequency_penalty: Option<f64>,
    pub presence_penalty: Option<f64>,
    pub reasoning_effort: Option<String>,
    pub thinking_enabled: Option<bool>,
    pub thinking_budget: Option<u64>,
    pub anthropic_thinking_type: Option<String>,
    pub anthropic_thinking_effort: Option<String>,
    pub thinking_level: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AiStreamEvent {
    Started {
        request_id: String,
    },
    TextDelta {
        delta: String,
    },
    ReasoningDelta {
        delta: String,
    },
    ToolInputStart {
        tool_call_id: String,
        tool_name: String,
    },
    ToolInputDelta {
        tool_call_id: String,
        delta: String,
    },
    ToolCall {
        tool_call_id: String,
        tool_name: String,
        input: Value,
    },
    Usage {
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
        cached_input_tokens: Option<u64>,
    },
    Finished {
        finish_reason: Option<String>,
    },
    Cancelled,
    Error {
        message: String,
        status: Option<u16>,
    },
}

impl AiTextRequest {
    pub fn endpoint(&self) -> String {
        let base = self.base_url.trim().trim_end_matches('/');
        match self.api_type {
            ProviderApiType::OpenaiResponses => append_endpoint(base, "/responses"),
            ProviderApiType::OpenaiChat => append_endpoint(base, "/chat/completions"),
            ProviderApiType::AnthropicMessages if base.ends_with("/v1") => {
                append_endpoint(base, "/messages")
            }
            ProviderApiType::AnthropicMessages => append_endpoint(base, "/v1/messages"),
            ProviderApiType::GoogleGenerateContent => format!(
                "{base}/models/{}:streamGenerateContent?alt=sse",
                self.model.trim_start_matches("models/")
            ),
        }
    }

    pub fn body(&self) -> Value {
        match self.api_type {
            ProviderApiType::OpenaiResponses => self.responses_body(),
            ProviderApiType::OpenaiChat => self.chat_body(),
            ProviderApiType::AnthropicMessages => self.anthropic_body(),
            ProviderApiType::GoogleGenerateContent => self.google_body(),
        }
    }

    fn responses_body(&self) -> Value {
        let input = if self.messages.is_empty() {
            json!(self.prompt)
        } else {
            Value::Array(self.openai_messages())
        };
        let mut body = Map::from_iter([
            ("model".into(), json!(self.model)),
            ("input".into(), input),
            ("stream".into(), json!(true)),
            ("max_output_tokens".into(), json!(self.max_output_tokens)),
        ]);
        insert_nonempty(&mut body, "instructions", &self.system);
        insert_option(&mut body, "temperature", self.temperature);
        insert_option(&mut body, "top_p", self.top_p);
        if self.reasoning_effort.is_some() {
            body.insert(
                "reasoning".into(),
                json!({ "effort": self.reasoning_effort, "summary": "auto" }),
            );
        }
        if !self.tools.is_empty() {
            body.insert("tools".into(), Value::Array(self.responses_tools()));
            insert_option(&mut body, "tool_choice", self.tool_choice.as_deref());
        }
        Value::Object(body)
    }

    fn chat_body(&self) -> Value {
        let mut messages = self.system_message();
        if self.messages.is_empty() {
            messages.push(json!({ "role": "user", "content": self.prompt }));
        } else {
            messages.extend(self.openai_messages());
        }
        let mut body = Map::from_iter([
            ("model".into(), json!(self.model)),
            ("messages".into(), Value::Array(messages)),
            ("stream".into(), json!(true)),
            ("max_tokens".into(), json!(self.max_output_tokens)),
        ]);
        if self.provider != "opencode" && self.thinking_enabled != Some(true) {
            insert_option(&mut body, "temperature", self.temperature);
            insert_option(&mut body, "top_p", self.top_p);
        }
        if !matches!(self.provider.as_str(), "sakura" | "opencode") {
            insert_option(&mut body, "frequency_penalty", self.frequency_penalty);
            insert_option(&mut body, "presence_penalty", self.presence_penalty);
        }
        if self.provider == "deepseek" && self.thinking_enabled.is_some() {
            body.insert(
                "thinking".into(),
                json!({ "type": if self.thinking_enabled == Some(false) { "disabled" } else { "enabled" } }),
            );
        }
        if self.provider == "deepseek" {
            if let Some(effort @ ("high" | "max")) = self.reasoning_effort.as_deref() {
                body.insert("reasoning_effort".into(), json!(effort));
            }
        }
        if !self.tools.is_empty() {
            body.insert("tools".into(), Value::Array(self.chat_tools()));
            insert_option(&mut body, "tool_choice", self.tool_choice.as_deref());
        }
        Value::Object(body)
    }

    fn anthropic_body(&self) -> Value {
        let messages = if self.messages.is_empty() {
            json!([{ "role": "user", "content": self.prompt }])
        } else {
            Value::Array(
                self.messages
                    .iter()
                    .filter(|message| matches!(message.role.as_str(), "user" | "assistant"))
                    .map(|message| json!({ "role": message.role, "content": message.content }))
                    .collect(),
            )
        };
        let mut body = Map::from_iter([
            ("model".into(), json!(self.model)),
            ("messages".into(), messages),
            ("stream".into(), json!(true)),
            ("max_tokens".into(), json!(self.max_output_tokens)),
        ]);
        insert_nonempty(&mut body, "system", &self.system);
        insert_option(&mut body, "temperature", self.temperature);
        match self.anthropic_thinking_type.as_deref() {
            Some("adaptive") => {
                body.insert("thinking".into(), json!({ "type": "adaptive" }));
            }
            Some("disabled") => {
                body.insert("thinking".into(), json!({ "type": "disabled" }));
            }
            Some("enabled") if self.thinking_budget.is_some() => {
                body.insert(
                    "thinking".into(),
                    json!({ "type": "enabled", "budget_tokens": self.thinking_budget }),
                );
            }
            _ => {}
        }
        if let Some(effort) = self.anthropic_thinking_effort.as_deref() {
            body.insert("output_config".into(), json!({ "effort": effort }));
        }
        if !self.tools.is_empty() && self.tool_choice.as_deref() != Some("none") {
            body.insert("tools".into(), Value::Array(self.anthropic_tools()));
            let choice = match self.tool_choice.as_deref() {
                Some("required") => "any",
                _ => "auto",
            };
            body.insert("tool_choice".into(), json!({ "type": choice }));
        } else if self.tool_choice.as_deref() == Some("none") {
            body.insert("tool_choice".into(), json!({ "type": "none" }));
        }
        Value::Object(body)
    }

    fn google_body(&self) -> Value {
        let mut generation = Map::new();
        generation.insert("maxOutputTokens".into(), json!(self.max_output_tokens));
        insert_option(&mut generation, "temperature", self.temperature);
        insert_option(&mut generation, "topP", self.top_p);
        insert_option(&mut generation, "topK", self.top_k);
        if self.thinking_level.is_some() {
            generation.insert(
                "thinkingConfig".into(),
                json!({ "includeThoughts": true, "thinkingLevel": self.thinking_level }),
            );
        }
        let contents = if self.messages.is_empty() {
            json!([{ "role": "user", "parts": [{ "text": self.prompt }] }])
        } else {
            Value::Array(
                self.messages
                    .iter()
                    .filter(|message| matches!(message.role.as_str(), "user" | "assistant"))
                    .map(|message| {
                        let role = if message.role == "assistant" {
                            "model"
                        } else {
                            "user"
                        };
                        json!({ "role": role, "parts": [{ "text": message.content }] })
                    })
                    .collect(),
            )
        };
        let mut body = Map::from_iter([
            ("contents".into(), contents),
            ("generationConfig".into(), Value::Object(generation)),
        ]);
        if !self.system.trim().is_empty() {
            body.insert(
                "systemInstruction".into(),
                json!({ "parts": [{ "text": self.system }] }),
            );
        }
        if !self.tools.is_empty() {
            body.insert(
                "tools".into(),
                json!([{ "functionDeclarations": self.google_tools() }]),
            );
            let mode = match self.tool_choice.as_deref() {
                Some("required") => "ANY",
                Some("none") => "NONE",
                _ => "AUTO",
            };
            body.insert(
                "toolConfig".into(),
                json!({ "functionCallingConfig": { "mode": mode } }),
            );
        }
        Value::Object(body)
    }

    fn openai_messages(&self) -> Vec<Value> {
        self.messages
            .iter()
            .filter(|message| {
                matches!(
                    message.role.as_str(),
                    "system" | "developer" | "user" | "assistant"
                )
            })
            .map(|message| json!({ "role": message.role, "content": message.content }))
            .collect()
    }

    fn system_message(&self) -> Vec<Value> {
        if self.system.trim().is_empty() {
            Vec::new()
        } else {
            vec![json!({ "role": "system", "content": self.system })]
        }
    }

    fn responses_tools(&self) -> Vec<Value> {
        self.tools
            .iter()
            .map(|tool| {
                json!({
                    "type": "function",
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.input_schema,
                })
            })
            .collect()
    }

    fn chat_tools(&self) -> Vec<Value> {
        self.tools
            .iter()
            .map(|tool| {
                json!({
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.input_schema,
                    },
                })
            })
            .collect()
    }

    fn anthropic_tools(&self) -> Vec<Value> {
        self.tools
            .iter()
            .map(|tool| {
                json!({
                    "name": tool.name,
                    "description": tool.description,
                    "input_schema": tool.input_schema,
                })
            })
            .collect()
    }

    fn google_tools(&self) -> Vec<Value> {
        self.tools
            .iter()
            .map(|tool| {
                json!({
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.input_schema,
                })
            })
            .collect()
    }
}

fn append_endpoint(base: &str, suffix: &str) -> String {
    if base.ends_with(suffix) {
        base.to_owned()
    } else {
        format!("{base}{suffix}")
    }
}

fn insert_nonempty(body: &mut Map<String, Value>, key: &str, value: &str) {
    if !value.trim().is_empty() {
        body.insert(key.into(), json!(value));
    }
}

fn insert_option<T: Serialize>(body: &mut Map<String, Value>, key: &str, value: Option<T>) {
    if let Some(value) = value {
        body.insert(key.into(), json!(value));
    }
}
