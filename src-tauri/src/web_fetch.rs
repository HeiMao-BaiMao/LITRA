use serde::{Deserialize, Serialize};
use std::time::Duration;

const MAX_RESPONSE_SIZE: u64 = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_TIMEOUT_SECS: u64 = 120;
const TEXT_WRAP_WIDTH: usize = 10_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebFetchRequest {
    pub url: String,
    pub format: Option<String>,
    pub timeout: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebFetchResult {
    pub output: String,
    pub title: String,
    pub mime: String,
}

fn accept_header(format: &str) -> &'static str {
    match format {
        "markdown" => "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1",
        "text" => "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1",
        "html" => "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1",
        _ => "*/*",
    }
}

#[tauri::command]
pub async fn web_fetch(req: WebFetchRequest) -> Result<WebFetchResult, String> {
    if !req.url.starts_with("http://") && !req.url.starts_with("https://") {
        return Err("URL must start with http:// or https://".to_string());
    }
    let format = req.format.unwrap_or_else(|| "markdown".to_string());
    let timeout_secs = req
        .timeout
        .unwrap_or(DEFAULT_TIMEOUT_SECS)
        .min(MAX_TIMEOUT_SECS);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))?;

    let response = client
        .get(&req.url)
        .header("User-Agent", ua_generator::ua::spoof_ua())
        .header("Accept", accept_header(&format))
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
        .map_err(|e| format!("GET {} failed: {e}", req.url))?;

    if !response.status().is_success() {
        return Err(format!("GET {} failed: {}", req.url, response.status()));
    }

    if let Some(content_length) = response.content_length() {
        if content_length > MAX_RESPONSE_SIZE {
            return Err("Response too large (exceeds 5MB limit)".to_string());
        }
    }

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let mime = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let title = format!("{} ({})", req.url, content_type);

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("failed to read response body: {e}"))?;
    if bytes.len() as u64 > MAX_RESPONSE_SIZE {
        return Err("Response too large (exceeds 5MB limit)".to_string());
    }

    if mime.starts_with("image/") {
        return Ok(WebFetchResult {
            output: format!(
                "[Image content, {} bytes, MIME {}. Image content is not supported by this tool.]",
                bytes.len(),
                mime
            ),
            title,
            mime,
        });
    }

    let content = String::from_utf8_lossy(&bytes).into_owned();
    let is_html = mime == "text/html";

    let output = match (format.as_str(), is_html) {
        ("markdown", true) => {
            htmd::convert(&content).map_err(|e| format!("HTML→Markdown conversion failed: {e}"))?
        }
        ("text", true) => html2text::from_read(content.as_bytes(), TEXT_WRAP_WIDTH)
            .map_err(|e| format!("HTML→text conversion failed: {e}"))?,
        _ => content,
    };

    Ok(WebFetchResult {
        output,
        title,
        mime,
    })
}
