use ammonia::Builder;
use pulldown_cmark::{html, Options, Parser};
use web_sys::Element;

use super::types::{ChatMessage, ChatTransportMetadata, ProviderConfig};

pub fn render_messages(container: &Element, messages: &[ChatMessage]) {
    let html = messages
        .iter()
        .map(render_message)
        .collect::<Vec<_>>()
        .join("");
    container.set_inner_html(&html);
    container.set_scroll_top(container.scroll_height());
}

pub fn provider_options(config: &ProviderConfig) -> String {
    config
        .providers
        .iter()
        .map(|provider| {
            format!(
                r#"<option value="{}">{}</option>"#,
                escape_html(&provider.id),
                escape_html(&provider.name)
            )
        })
        .collect()
}

pub fn model_options(config: &ProviderConfig, provider_id: &str) -> String {
    config
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .map(|provider| {
            provider
                .models
                .iter()
                .map(|model| {
                    format!(
                        r#"<option value="{}">{}</option>"#,
                        escape_html(&model.id),
                        escape_html(model.label.as_deref().unwrap_or(&model.id))
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

fn render_message(message: &ChatMessage) -> String {
    let id = message
        .id
        .as_deref()
        .map(|id| format!(r#" data-message-id="{}""#, escape_html(id)))
        .unwrap_or_default();
    let thinking = render_thinking(
        message.thinking.as_deref(),
        message.content.trim().is_empty(),
    );
    let content = render_tool_call(&message.content)
        .unwrap_or_else(|| render_markdown_or_fallback(&message.content));
    let metadata = render_metadata(message.transport.as_ref());
    let pending = if message.content.trim().is_empty()
        && message
            .thinking
            .as_deref()
            .map(str::trim)
            .unwrap_or_default()
            .is_empty()
    {
        " chat-pending"
    } else {
        ""
    };
    format!(
        r#"<div class="chat-message {}{}"{}>{}{}{}</div>"#,
        escape_html(&message.role),
        pending,
        id,
        thinking,
        content,
        metadata
    )
}

fn render_thinking(thinking: Option<&str>, streaming: bool) -> String {
    let Some(thinking) = thinking.filter(|value| !value.trim().is_empty()) else {
        return String::new();
    };
    let open = if streaming { " open" } else { "" };
    let streaming_class = if streaming { " streaming" } else { "" };
    let label = if streaming { "思考中…" } else { "思考" };
    format!(
        r#"<details class="thinking-panel{streaming_class}"{open}>
          <summary class="thinking-summary">{label}<span class="thinking-chars">{}文字</span></summary>
          <div class="thinking-content">{}</div>
        </details>"#,
        thinking.chars().count(),
        render_markdown_or_fallback(thinking)
    )
}

fn render_metadata(metadata: Option<&ChatTransportMetadata>) -> String {
    let Some(metadata) = metadata else {
        return String::new();
    };
    let model = metadata
        .response_model_id
        .as_deref()
        .or(metadata.model.as_deref())
        .unwrap_or_default();
    if model.is_empty() {
        return String::new();
    }
    let label = metadata
        .provider
        .as_deref()
        .map(|provider| format!("{provider} · {model}"))
        .unwrap_or_else(|| model.to_owned());
    format!(
        r#"<div class="chat-model-metadata" title="使用モデル">{}</div>"#,
        escape_html(&label)
    )
}

fn render_tool_call(content: &str) -> Option<String> {
    let mut lines = content.lines();
    let header = lines.next()?;
    let header = header.strip_prefix("【ツール")?.strip_suffix('】')?;
    let (status, tool_name) = header.split_once(':')?;
    let mut state = status.trim().to_owned();
    let mut id = None;
    let mut input = Vec::new();
    let mut output = Vec::new();
    let mut section = "";
    for line in lines {
        if let Some(value) = line.strip_prefix("状態:") {
            state = value.trim().to_owned();
            section = "";
        } else if let Some(value) = line.strip_prefix("ID:") {
            id = Some(value.trim().to_owned());
            section = "";
        } else if let Some(value) = line.strip_prefix("入力:") {
            input.push(value.trim_start());
            section = "input";
        } else if let Some(value) = line.strip_prefix("結果:") {
            output.push(value.trim_start());
            section = "output";
        } else if section == "input" {
            input.push(line);
        } else if section == "output" {
            output.push(line);
        }
    }
    let status_class = if state.contains("成功") {
        "success"
    } else if state.contains("失敗") {
        "failure"
    } else if state.contains("中断") || state.contains("未到達") {
        "interrupted"
    } else if state.contains("実行") || state.contains("入力生成中") {
        "running"
    } else {
        "neutral"
    };
    Some(format!(
        r#"<details class="tool-call-card {status_class}">
          <summary class="tool-call-summary">
            <div class="tool-call-header"><div class="tool-call-title"><span class="tool-call-icon">TOOL</span><span class="tool-call-name">{}</span></div><span class="tool-call-status">{}</span></div>
            {}
          </summary>
          {}{}
        </details>"#,
        escape_html(tool_name.trim()),
        escape_html(&state),
        id.map(|id| format!(r#"<div class="tool-call-id">{}</div>"#, escape_html(&id)))
            .unwrap_or_default(),
        render_tool_section("入力", &input.join("\n")),
        render_tool_section("結果", &output.join("\n")),
    ))
}

fn render_tool_section(title: &str, value: &str) -> String {
    if value.trim().is_empty() {
        return String::new();
    }
    let value = if value.chars().count() > 800 {
        format!("{}…", value.chars().take(800).collect::<String>())
    } else {
        value.to_owned()
    };
    format!(
        r#"<div class="tool-call-section"><div class="tool-call-section-title">{}</div><pre class="tool-call-value"><code>{}</code></pre></div>"#,
        escape_html(title),
        escape_html(&value)
    )
}

fn render_markdown_or_fallback(content: &str) -> String {
    if content.trim().is_empty() {
        return String::new();
    }
    let mut output = String::new();
    let parser = Parser::new_ext(
        content,
        Options::ENABLE_STRIKETHROUGH
            | Options::ENABLE_TABLES
            | Options::ENABLE_TASKLISTS
            | Options::ENABLE_GFM,
    );
    html::push_html(&mut output, parser);
    let sanitized = Builder::default().clean(&output).to_string();
    if sanitized.trim().is_empty() {
        format!(
            r#"<pre class="chat-message-fallback"><code>{}</code></pre>"#,
            escape_html(content)
        )
    } else {
        sanitized
    }
}

pub fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
