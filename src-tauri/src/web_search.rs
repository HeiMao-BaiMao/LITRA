use serde::Deserialize;
use serde_json::json;
use std::sync::OnceLock;
use std::time::Duration;

const EXA_MCP_URL: &str = "https://mcp.exa.ai/mcp";
const EXA_API_KEY_SECRET: &str = "websearch:exaApiKey";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(25);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchRequest {
    pub query: String,
    pub num_results: Option<u32>,
    pub livecrawl: Option<String>,
    #[serde(rename = "type")]
    pub search_type: Option<String>,
    pub context_max_characters: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct McpContent {
    text: String,
}

#[derive(Debug, Deserialize)]
struct McpResultInner {
    content: Vec<McpContent>,
}

#[derive(Debug, Deserialize)]
struct McpResult {
    result: McpResultInner,
}

fn client() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(REQUEST_TIMEOUT)
                .build()
                .expect("failed to build reqwest client")
        })
        .clone()
}

fn build_url() -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(EXA_MCP_URL).map_err(|e| format!("invalid Exa URL: {e}"))?;
    if let Some(key) = crate::secrets::get_secret(EXA_API_KEY_SECRET)?.filter(|k| !k.is_empty()) {
        url.query_pairs_mut().append_pair("exaApiKey", &key);
    }
    Ok(url)
}

/// 直接JSONまたはSSE(`data: {...}`行)のどちらでも { result: { content: [{ text }] } } を取り出す。
fn parse_response(body: &str) -> Option<String> {
    let trimmed = body.trim();
    if trimmed.starts_with('{') {
        if let Ok(parsed) = serde_json::from_str::<McpResult>(trimmed) {
            if let Some(text) = parsed
                .result
                .content
                .into_iter()
                .map(|c| c.text)
                .find(|t| !t.is_empty())
            {
                return Some(text);
            }
        }
    }
    for line in body.lines() {
        let Some(payload) = line.strip_prefix("data: ") else {
            continue;
        };
        if let Ok(parsed) = serde_json::from_str::<McpResult>(payload.trim()) {
            if let Some(text) = parsed
                .result
                .content
                .into_iter()
                .map(|c| c.text)
                .find(|t| !t.is_empty())
            {
                return Some(text);
            }
        }
    }
    None
}

#[tauri::command]
pub async fn web_search(req: WebSearchRequest) -> Result<String, String> {
    let url = build_url()?;

    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "web_search_exa",
            "arguments": {
                "query": req.query,
                "type": req.search_type.unwrap_or_else(|| "auto".to_string()),
                "numResults": req.num_results.unwrap_or(8),
                "livecrawl": req.livecrawl.unwrap_or_else(|| "fallback".to_string()),
                "contextMaxCharacters": req.context_max_characters.unwrap_or(10000),
            }
        }
    });

    let response = client()
        .post(url)
        .header("Accept", "application/json, text/event-stream")
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(&body).map_err(|e| format!("failed to encode request: {e}"))?)
        .send()
        .await
        .map_err(|e| format!("web_search request failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("web_search request failed: {}", response.status()));
    }

    let text = response
        .text()
        .await
        .map_err(|e| format!("web_search response read failed: {e}"))?;

    Ok(parse_response(&text)
        .unwrap_or_else(|| "No search results found. Please try a different query.".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_response_handles_direct_json() {
        let body = r#"{"result":{"content":[{"type":"text","text":"hello world"}]}}"#;
        assert_eq!(parse_response(body), Some("hello world".to_string()));
    }

    #[test]
    fn parse_response_handles_sse_data_lines() {
        let body = "event: message\ndata: {\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"sse result\"}]}}\n\n";
        assert_eq!(parse_response(body), Some("sse result".to_string()));
    }

    #[test]
    fn parse_response_returns_none_when_unparseable() {
        assert_eq!(parse_response("not json at all"), None);
    }

    #[test]
    fn parse_response_skips_empty_text_entries() {
        let body =
            r#"{"result":{"content":[{"type":"text","text":""},{"type":"text","text":"second"}]}}"#;
        assert_eq!(parse_response(body), Some("second".to_string()));
    }
}
