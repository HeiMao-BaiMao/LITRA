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
    pub content: Value,
    #[serde(default)]
    pub attribution: Option<String>,
    /// Opaque Responses output items that must be replayed verbatim on the
    /// next stateless turn (currently Codex encrypted reasoning).
    #[serde(default, rename = "responsesItems")]
    pub responses_items: Vec<Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiToolDefinition {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub input_schema: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTextRequest {
    pub request_id: String,
    pub provider: String,
    pub api_type: ProviderApiType,
    #[serde(default)]
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    /// Stable conversation scope for stateful wire planning (GPT-6 Astra
    /// stable effort). Absent for single-shot generations, which stand alone.
    #[serde(default)]
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub system: String,
    #[serde(default)]
    pub messages: Vec<AiInputMessage>,
    #[serde(default)]
    pub tools: Vec<AiToolDefinition>,
    /// Search backends ordered by preference. The first backend supported by
    /// the selected provider/model is enabled as a hosted/native tool.
    #[serde(default)]
    pub search_priority: Vec<String>,
    pub tool_choice: Option<String>,
    pub tool_choice_name: Option<String>,
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
    /// An opaque Responses reasoning item returned with
    /// `include: ["reasoning.encrypted_content"]`.
    ResponsesReasoning {
        item: Value,
    },
    /// An opaque Responses hosted-tool output item (currently web search)
    /// that must be replayed on the next stateless turn.
    ResponsesToolContext {
        item: Value,
    },
    /// An opaque Anthropic server-tool content block (currently web search)
    /// that must be replayed when a later client-tool round follows it.
    AnthropicToolContext {
        block: Value,
    },
    /// The complete Anthropic thinking block, including its signature, for
    /// replaying a thinking response before a later tool result.
    AnthropicThinking {
        block: Value,
    },
    /// Gemini server-side tool parts (for example Google Search) that must
    /// be replayed verbatim when a later custom-tool round follows them.
    GoogleToolContext {
        part: Value,
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
    const DEFAULT_SEARCH_PRIORITY: [&'static str; 4] = [
        "openai-web-search",
        "anthropic-web-search",
        "google-search",
        "exa",
    ];

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
    /// DeepSeek V4 is thinking-fixed (non-thinking output corrupts Japanese).
    fn is_deepseek_v4(&self) -> bool {
        let m = self.model.trim().to_lowercase();
        m.starts_with("deepseek-v4-") || m == "deepseek-v4"
    }

    /// Whether this is a Gemini 3 series model.
    fn is_gemini3(&self) -> bool {
        let m = self.model.trim().to_lowercase();
        m.starts_with("gemini-3.") || m.starts_with("gemini-3-") || m == "gemini-3"
    }

    /// Codex added `reasoning.context` support to the GPT-5.4 generation.
    /// Older Codex models reject the field, so keep the compatibility gate
    /// local to the wire builder instead of applying it to every Responses
    /// provider. GPT-6 and Daybreak are newer than 5.6 (oh-my-pi revision
    /// ">=5.4" rule), so they stay inside the gate.
    fn supports_codex_reasoning_context(&self) -> bool {
        let model = self.model.trim().to_lowercase();
        model.starts_with("gpt-5.4")
            || model.starts_with("gpt-5.5")
            || model.starts_with("gpt-5.6")
            || model.starts_with("gpt-6")
            || model.starts_with("gpt-daybreak")
    }

    /// Resolve the Anthropic thinking block from model name + flat settings fields.
    /// Mirrors TS buildProviderOptions() anthropic case.
    fn resolve_anthropic_thinking(&self) -> Option<Value> {
        let model = self.model.trim().to_lowercase();
        // Fable/Mythos 5: always-on adaptive, cannot disable, display summarized
        if model.contains("fable-5") || model.contains("fable5") || model.contains("mythos-5") {
            return Some(json!({ "type": "adaptive", "display": "summarized" }));
        }
        // Opus/Sonnet 5 and Opus 4.7/4.8: adaptive, can disable,
        // display summarized.
        if model.starts_with("claude-opus-5")
            || model.starts_with("claude-sonnet-5")
            || model.starts_with("claude-opus-4-7")
            || model.starts_with("claude-opus-4-8")
        {
            if self.thinking_enabled == Some(false) {
                return None; // disabled -> omit thinking block entirely
            }
            return Some(json!({ "type": "adaptive", "display": "summarized" }));
        }
        // Other Claude models: budget thinking
        if model.starts_with("claude-") {
            if self.thinking_enabled == Some(false) {
                return Some(json!({ "type": "disabled" }));
            }
            if let Some(budget) = self.thinking_budget {
                return Some(json!({ "type": "enabled", "budget_tokens": budget }));
            }
            return None;
        }
        // Non-Claude model on Anthropic protocol: use explicit type if provided
        self.anthropic_thinking_type
            .as_ref()
            .map(|t| match t.as_str() {
                "adaptive" => json!({ "type": "adaptive" }),
                "disabled" => json!({ "type": "disabled" }),
                "enabled" => {
                    let mut thinking = serde_json::Map::new();
                    thinking.insert("type".into(), json!("enabled"));
                    if let Some(budget) = self.thinking_budget {
                        thinking.insert("budget_tokens".into(), json!(budget));
                    }
                    Value::Object(thinking)
                }
                _ => json!({ "type": t }),
            })
    }

    fn responses_body(&self) -> Value {
        let input = if self.messages.is_empty() {
            json!(self.prompt)
        } else {
            Value::Array(crate::ai::messages::openai_responses(&self.messages))
        };
        let mut body = Map::from_iter([
            ("model".into(), json!(self.model)),
            ("input".into(), input),
            ("stream".into(), json!(true)),
        ]);
        if self.provider != "codex" {
            body.insert("max_output_tokens".into(), json!(self.max_output_tokens));
        }
        insert_nonempty(&mut body, "instructions", &self.system);
        if !matches!(self.provider.as_str(), "opencode" | "codex") {
            insert_option(&mut body, "temperature", self.temperature);
            insert_option(&mut body, "top_p", self.top_p);
        }
        let is_stateless_responses = matches!(
            self.provider.as_str(),
            "openai" | "codex" | "github-copilot"
        );
        if is_stateless_responses {
            body.insert("store".into(), json!(false));
            if self.reasoning_effort.is_some() {
                body.insert("include".into(), json!(["reasoning.encrypted_content"]));
            }
        }
        if self.provider == "codex" {
            body.insert("text".into(), json!({ "verbosity": "medium" }));
        }
        if let Some(effort) = self.reasoning_effort.as_deref() {
            let mut reasoning = Map::from_iter([("effort".into(), json!(effort))]);
            if self.provider != "codex" || self.supports_codex_reasoning_context() {
                reasoning.insert("summary".into(), json!("auto"));
            }
            if self.provider == "codex" && self.supports_codex_reasoning_context() {
                reasoning.insert("context".into(), json!("all_turns"));
            }
            body.insert("reasoning".into(), Value::Object(reasoning));
        }
        self.apply_stable_effort(&mut body);
        let native_search = self.native_search_tool();
        let has_custom_tools = self.has_wire_custom_tools();
        if let Some(native_search) = native_search {
            let mut tools = self.responses_tools();
            tools.push(native_search);
            body.insert("tools".into(), Value::Array(tools));
        } else if has_custom_tools {
            body.insert("tools".into(), Value::Array(self.responses_tools()));
        }
        if has_custom_tools || self.native_search_tool().is_some() {
            if let Some(name) = self.tool_choice_name.as_deref() {
                body.insert(
                    "tool_choice".into(),
                    json!({ "type": "function", "name": name }),
                );
            } else {
                insert_option(&mut body, "tool_choice", self.tool_choice.as_deref());
            }
        }
        Value::Object(body)
    }

    /// GPT-6 Astra stable-effort planning (oh-my-pi `planStableOpenAIEffort`
    /// port). Pins request-level `reasoning.effort` to the conversation
    /// baseline and carries later changes as `configuration_update` items so
    /// the cached prompt prefix survives effort switches. Only `gpt-6-astra`
    /// accepts the item type (anything else 400s), so the gate stays on the
    /// exact model id; without a conversation scope every request stands
    /// alone and sends its own effort.
    fn apply_stable_effort(&self, body: &mut Map<String, Value>) {
        if !self.model.trim().eq_ignore_ascii_case("gpt-6-astra") {
            return;
        }
        let requested = match self.reasoning_effort.as_deref().map(str::trim) {
            Some(effort) if !effort.is_empty() && !effort.eq_ignore_ascii_case("none") => effort,
            _ => return,
        };
        let conversation = match self.conversation_id.as_deref().map(str::trim) {
            Some(id) if !id.is_empty() => id,
            _ => return,
        };
        let Some(input) = body.get_mut("input").and_then(Value::as_array_mut) else {
            return;
        };
        let key = format!(
            "{}\0{}\0{}",
            self.provider,
            self.model.trim().to_lowercase(),
            conversation
        );
        let send = super::effort_control::plan_stable_effort(&key, input, requested);
        if let Some(reasoning) = body.get_mut("reasoning").and_then(Value::as_object_mut) {
            reasoning.insert("effort".into(), json!(send));
        }
    }

    fn chat_body(&self) -> Value {
        let mut messages = self.system_message();
        if self.messages.is_empty() {
            messages.push(json!({ "role": "user", "content": self.prompt }));
        } else {
            messages.extend(crate::ai::messages::openai_chat(&self.messages));
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
        if self.provider == "deepseek" || (self.provider == "opencode" && self.is_deepseek_v4()) {
            let thinking_type = if self.thinking_enabled == Some(false) && !self.is_deepseek_v4() {
                "disabled"
            } else {
                "enabled"
            };
            body.insert("thinking".into(), json!({ "type": thinking_type }));
        }
        if self.provider == "deepseek" || self.provider == "opencode" {
            if let Some(effort @ ("high" | "max")) = self.reasoning_effort.as_deref() {
                body.insert("reasoning_effort".into(), json!(effort));
            }
        }
        let has_native_search = self.openai_chat_native_search();
        if has_native_search {
            body.insert("web_search_options".into(), json!({}));
        }
        if self.has_wire_custom_tools() {
            body.insert("tools".into(), Value::Array(self.chat_tools()));
            if let Some(name) = self.tool_choice_name.as_deref() {
                body.insert(
                    "tool_choice".into(),
                    json!({ "type": "function", "function": { "name": name } }),
                );
            } else {
                insert_option(&mut body, "tool_choice", self.tool_choice.as_deref());
            }
        }
        Value::Object(body)
    }

    fn anthropic_body(&self) -> Value {
        let messages = if self.messages.is_empty() {
            json!([{ "role": "user", "content": self.prompt }])
        } else {
            Value::Array(crate::ai::messages::anthropic(&self.messages))
        };
        let mut body = Map::from_iter([
            ("model".into(), json!(self.model)),
            ("messages".into(), messages),
            ("stream".into(), json!(true)),
            ("max_tokens".into(), json!(self.max_output_tokens)),
        ]);
        insert_nonempty(&mut body, "system", &self.system);
        insert_option(&mut body, "temperature", self.temperature);
        if let Some(thinking) = self.resolve_anthropic_thinking() {
            body.insert("thinking".into(), thinking);
        }
        if let Some(effort) = self.anthropic_thinking_effort.as_deref() {
            body.insert("output_config".into(), json!({ "effort": effort }));
        }
        let native_search = self.native_search_tool();
        let has_custom_tools = self.has_wire_custom_tools();
        if self.tool_choice.as_deref() != Some("none")
            && (has_custom_tools || native_search.is_some())
        {
            let mut tools = self.anthropic_tools();
            if let Some(native_search) = native_search {
                tools.insert(0, native_search);
            }
            body.insert("tools".into(), Value::Array(tools));
            if let Some(name) = self.tool_choice_name.as_deref() {
                body.insert(
                    "tool_choice".into(),
                    json!({ "type": "tool", "name": name }),
                );
            } else {
                let choice = match self.tool_choice.as_deref() {
                    Some("required") => "any",
                    _ => "auto",
                };
                body.insert("tool_choice".into(), json!({ "type": choice }));
            }
        } else if self.tool_choice.as_deref() == Some("none") {
            body.insert("tool_choice".into(), json!({ "type": "none" }));
        }
        Value::Object(body)
    }

    fn google_body(&self) -> Value {
        let mut generation = Map::new();
        generation.insert("maxOutputTokens".into(), json!(self.max_output_tokens));
        if !self.is_gemini3() {
            insert_option(&mut generation, "temperature", self.temperature);
            insert_option(&mut generation, "topP", self.top_p);
            insert_option(&mut generation, "topK", self.top_k);
        }
        if self.thinking_level.is_some() {
            generation.insert(
                "thinkingConfig".into(),
                json!({ "includeThoughts": true, "thinkingLevel": self.thinking_level }),
            );
        }
        let contents = if self.messages.is_empty() {
            json!([{ "role": "user", "parts": [{ "text": self.prompt }] }])
        } else {
            Value::Array(crate::ai::messages::google(&self.messages))
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
        let native_search = self.native_search_tool();
        let has_native_search = native_search.is_some();
        let has_custom_tools = self.has_wire_custom_tools();
        if has_custom_tools || has_native_search {
            let mut tools = Vec::new();
            if let Some(native_search) = native_search {
                tools.push(native_search);
            }
            if has_custom_tools {
                tools.push(json!({ "functionDeclarations": self.google_tools() }));
            }
            body.insert("tools".into(), Value::Array(tools));
            if has_custom_tools || has_native_search {
                let mut tool_config = Map::new();
                if has_native_search && has_custom_tools {
                    tool_config.insert("includeServerSideToolInvocations".into(), json!(true));
                }
                if has_custom_tools {
                    let mode = match self.tool_choice.as_deref() {
                        Some("required") => "ANY",
                        Some("none") => "NONE",
                        _ => "AUTO",
                    };
                    let function_calling_config =
                        if let Some(name) = self.tool_choice_name.as_deref() {
                            json!({ "mode": "ANY", "allowedFunctionNames": [name] })
                        } else {
                            json!({ "mode": mode })
                        };
                    if !has_native_search || self.tool_choice.is_some() {
                        tool_config.insert("functionCallingConfig".into(), function_calling_config);
                    }
                }
                if !tool_config.is_empty() {
                    body.insert("toolConfig".into(), Value::Object(tool_config));
                }
            }
        }
        Value::Object(body)
    }

    /// Returns the provider-hosted search tool selected by the persisted
    /// priority list. Unknown and unsupported candidates are skipped.
    pub(crate) fn native_search_tool(&self) -> Option<Value> {
        if self.tool_choice.as_deref() == Some("none")
            || self.tool_choice_name.as_deref() == Some("webSearch")
        {
            return None;
        }
        let priority = if self.search_priority.is_empty() {
            Self::DEFAULT_SEARCH_PRIORITY.to_vec()
        } else {
            self.search_priority
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
        };
        for candidate in priority {
            match candidate {
                // Exa is the provider-independent fallback. Because it is
                // always available, placing it first intentionally disables
                // all hosted/native candidates for this request.
                "exa" => return None,
                "openai-web-search"
                    if self.provider == "openai"
                        && self.api_type == ProviderApiType::OpenaiResponses =>
                {
                    return Some(json!({ "type": "web_search" }));
                }
                "anthropic-web-search"
                    if self.provider == "anthropic"
                        && self.api_type == ProviderApiType::AnthropicMessages =>
                {
                    return Some(json!({
                        "type": "web_search_20250305",
                        "name": "web_search",
                        "max_uses": 5
                    }));
                }
                "google-search"
                    if self.provider == "google"
                        && self.api_type == ProviderApiType::GoogleGenerateContent
                        // Google Search is available on current Gemini models.
                        // Combining it with client-side declarations is
                        // currently documented for Gemini 3 only.
                        && (self.is_gemini3() || !self.has_non_search_tools()) =>
                {
                    return Some(json!({ "google_search": {} }));
                }
                _ => {}
            }
        }
        None
    }

    /// OpenAI's Chat Completions search model exposes native search through a
    /// request option rather than a `tools` entry.
    fn openai_chat_native_search(&self) -> bool {
        if self.provider != "openai"
            || self.api_type != ProviderApiType::OpenaiChat
            || self.model.trim() != "gpt-5-search-api"
            || self.tool_choice.as_deref() == Some("none")
            || self.tool_choice_name.as_deref() == Some("webSearch")
            || self.has_non_search_tools()
        {
            return false;
        }
        let priority = if self.search_priority.is_empty() {
            Self::DEFAULT_SEARCH_PRIORITY.to_vec()
        } else {
            self.search_priority
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
        };
        for candidate in priority {
            match candidate {
                "exa" => return false,
                "openai-web-search" => return true,
                _ => {}
            }
        }
        false
    }

    pub(crate) fn native_search_enabled(&self) -> bool {
        self.native_search_tool().is_some() || self.openai_chat_native_search()
    }

    /// The frontend keeps the Exa function definition available so the
    /// fallback path can execute it, but a selected native backend should not
    /// expose that competing function to the provider on the initial turn.
    fn has_wire_custom_tools(&self) -> bool {
        self.tools
            .iter()
            .any(|tool| !self.native_search_enabled() || tool.name != "webSearch")
    }

    fn has_non_search_tools(&self) -> bool {
        self.tools.iter().any(|tool| tool.name != "webSearch")
    }

    fn should_send_tool(&self, tool: &AiToolDefinition) -> bool {
        !self.native_search_enabled() || tool.name != "webSearch"
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
            .filter(|tool| self.should_send_tool(tool))
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
            .filter(|tool| self.should_send_tool(tool))
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
            .filter(|tool| self.should_send_tool(tool))
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
            .filter(|tool| self.should_send_tool(tool))
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
