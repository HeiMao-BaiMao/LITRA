use serde::Deserialize;
use wasm_bindgen::JsValue;
use web_sys::Document;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LicensePayload {
    app_name: String,
    app_version: String,
    entries: Vec<LicenseEntry>,
}

#[derive(Deserialize)]
struct LicenseEntry {
    ecosystem: String,
    name: String,
    version: String,
    license: String,
    source: Option<String>,
    homepage: Option<String>,
}

pub fn show(document: &Document) -> Result<(), JsValue> {
    let payload: LicensePayload = serde_json::from_str(include_str!(
        "../../../../../public/third-party-licenses.json"
    ))
    .map_err(|error| JsValue::from_str(&format!("license JSON is invalid: {error}")))?;
    if let Some(content) = document.get_element_by_id("license-content") {
        let entries = payload
            .entries
            .iter()
            .map(|entry| {
                let url = entry.source.as_deref().or(entry.homepage.as_deref());
                let link = url
                    .map(|url| {
                        format!(
                            r#"<a href="{}" target="_blank" rel="noreferrer">source</a>"#,
                            escape(url)
                        )
                    })
                    .unwrap_or_default();
                format!(
                    r#"<article class="license-item"><h3>{} {}</h3><p>{} / {}</p>{}</article>"#,
                    escape(&entry.name),
                    escape(&entry.version),
                    escape(&entry.ecosystem),
                    escape(&entry.license),
                    link
                )
            })
            .collect::<String>();
        content.set_inner_html(&format!(
            r#"<p class="license-summary">{} {} / {} 件</p><div class="license-list">{}</div>"#,
            escape(&payload.app_name),
            escape(&payload.app_version),
            payload.entries.len(),
            entries
        ));
    }
    toggle(document, false)
}

pub fn close(document: &Document) -> Result<(), JsValue> {
    toggle(document, true)
}

fn toggle(document: &Document, hidden: bool) -> Result<(), JsValue> {
    if let Some(modal) = document.get_element_by_id("license-modal") {
        modal.class_list().toggle_with_force("hidden", hidden)?;
    }
    Ok(())
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
