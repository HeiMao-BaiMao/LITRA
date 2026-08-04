use serde_json::{Map, Number, Value};
use wasm_bindgen::{JsCast, JsValue};
use web_sys::{Document, HtmlInputElement, HtmlSelectElement};

use crate::runtime::ai::CatalogProvider;

const CHECKBOXES: &[(&str, &str, bool)] = &[
    ("setting-deepseek-thinking", "deepseekThinkingEnabled", true),
    (
        "setting-anthropic-thinking-enabled",
        "anthropicThinkingEnabled",
        false,
    ),
    (
        "setting-two-stage-continuation",
        "twoStageContinuation",
        false,
    ),
    (
        "setting-continuation-review",
        "continuationReviewEnabled",
        false,
    ),
    (
        "setting-continuation-scene-state",
        "continuationSceneStateEnabled",
        false,
    ),
    (
        "setting-continuation-character-voice",
        "continuationCharacterVoiceEnabled",
        false,
    ),
    (
        "setting-continuation-best-of-two",
        "continuationBestOfTwo",
        false,
    ),
    (
        "setting-continuation-targeted-revision",
        "continuationTargetedRevision",
        false,
    ),
    (
        "setting-continuation-beat-split",
        "continuationBeatSplitEnabled",
        false,
    ),
];

pub fn populate(
    document: &Document,
    settings: &Value,
    catalog: &[CatalogProvider],
) -> Result<(), JsValue> {
    for (id, key, default) in CHECKBOXES {
        set_checked(
            document,
            id,
            settings
                .get(*key)
                .and_then(Value::as_bool)
                .unwrap_or(*default),
        );
    }
    for (id, key) in [
        ("setting-openai-reasoning-effort", "openaiReasoningEffort"),
        (
            "setting-deepseek-reasoning-effort",
            "deepseekReasoningEffort",
        ),
        (
            "setting-anthropic-thinking-effort",
            "anthropicThinkingEffort",
        ),
        ("setting-google-thinking-level", "googleThinkingLevel"),
    ] {
        set_value(document, id, string(settings, key));
    }
    let provider_options = catalog
        .iter()
        .map(|provider| {
            format!(
                r#"<option value="{}">{}</option>"#,
                escape(&provider.id),
                escape(&provider.name)
            )
        })
        .collect::<String>();
    for (id, empty_label) in [
        ("setting-background-provider", "チャット欄に同期"),
        ("setting-writing-provider", "本文モデルと同じ"),
        ("setting-judgment-provider", "本文モデルと同じ"),
    ] {
        if let Some(select) = select(document, id) {
            select.set_inner_html(&format!(
                r#"<option value="">{}</option>{provider_options}"#,
                escape(empty_label)
            ));
        }
    }
    set_value(
        document,
        "setting-background-provider",
        string(settings, "backgroundProvider"),
    );
    populate_models(
        document,
        catalog,
        "setting-background-provider",
        "setting-background-model",
        string(settings, "backgroundModel"),
    )?;
    let writing_source = nonempty(string(settings, "writingModelSource"), "main");
    set_value(document, "setting-writing-source", writing_source);
    set_value(
        document,
        "setting-writing-provider",
        nonempty(
            string(settings, "writingProvider"),
            string(settings, "provider"),
        ),
    );
    populate_models(
        document,
        catalog,
        "setting-writing-provider",
        "setting-writing-model",
        string(settings, "writingModel"),
    )?;
    let judgment_source = if settings.get("judgmentModelSource").is_some() {
        nonempty(string(settings, "judgmentModelSource"), "main")
    } else if settings
        .get("continuationUseBackgroundModel")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        "background"
    } else {
        "main"
    };
    set_value(document, "setting-judgment-source", judgment_source);
    set_value(
        document,
        "setting-judgment-provider",
        string(settings, "judgmentProvider"),
    );
    populate_models(
        document,
        catalog,
        "setting-judgment-provider",
        "setting-judgment-model",
        string(settings, "judgmentModel"),
    )?;
    populate_overrides(document, settings.get("writingOverrides"), "writing");
    populate_overrides(document, settings.get("judgmentOverrides"), "judgment");
    update_source_visibility(document, "writing")?;
    update_source_visibility(document, "judgment")?;
    render_preview(document, catalog)?;
    Ok(())
}

pub fn capture(document: &Document, object: &mut Map<String, Value>) -> Result<(), JsValue> {
    for (id, key) in [
        ("setting-background-provider", "backgroundProvider"),
        ("setting-background-model", "backgroundModel"),
        ("setting-writing-provider", "writingProvider"),
        ("setting-writing-model", "writingModel"),
        ("setting-judgment-provider", "judgmentProvider"),
        ("setting-judgment-model", "judgmentModel"),
    ] {
        insert_optional_string(object, key, &value(document, id));
    }
    for (id, key) in [
        ("setting-writing-source", "writingModelSource"),
        ("setting-judgment-source", "judgmentModelSource"),
    ] {
        object.insert(key.into(), Value::String(value(document, id)));
    }
    object.insert(
        "continuationUseBackgroundModel".into(),
        Value::Bool(value(document, "setting-judgment-source") == "background"),
    );
    object.insert(
        "writingOverrides".into(),
        Value::Object(capture_overrides(document, "writing")),
    );
    object.insert(
        "judgmentOverrides".into(),
        Value::Object(capture_overrides(document, "judgment")),
    );
    Ok(())
}

pub fn control_changed(
    document: &Document,
    catalog: &[CatalogProvider],
    id: &str,
) -> Result<(), JsValue> {
    match id {
        "setting-model-select" => {
            set_value(document, "setting-model", &value(document, id));
            Ok(())
        }
        "setting-background-provider" => {
            populate_models(document, catalog, id, "setting-background-model", "")
        }
        "setting-writing-provider" => {
            populate_models(document, catalog, id, "setting-writing-model", "")
        }
        "setting-judgment-provider" => {
            populate_models(document, catalog, id, "setting-judgment-model", "")
        }
        "setting-writing-source" => update_source_visibility(document, "writing"),
        "setting-judgment-source" => update_source_visibility(document, "judgment"),
        _ => Ok(()),
    }?;
    render_preview(document, catalog)
}

pub fn render_preview(document: &Document, catalog: &[CatalogProvider]) -> Result<(), JsValue> {
    let main = (
        value(document, "setting-provider"),
        value(document, "setting-model"),
    );
    let background = {
        let provider = value(document, "setting-background-provider");
        if provider.is_empty() {
            main.clone()
        } else {
            (provider, value(document, "setting-background-model"))
        }
    };
    let resolve = |prefix: &str| match value(document, &format!("setting-{prefix}-source")).as_str()
    {
        "background" => background.clone(),
        "custom" => {
            let provider = value(document, &format!("setting-{prefix}-provider"));
            if provider.is_empty() {
                main.clone()
            } else {
                (
                    provider,
                    value(document, &format!("setting-{prefix}-model")),
                )
            }
        }
        _ => main.clone(),
    };
    let rows = [
        ("本文", main.clone()),
        ("バックグラウンド", background.clone()),
        ("執筆系", resolve("writing")),
        ("判断系", resolve("judgment")),
    ];
    if let Some(body) = document.get_element_by_id("model-resolution-preview-body") {
        body.set_inner_html(&format!(
            r#"<table><thead><tr><th>工程</th><th>モデル</th><th>接続先</th></tr></thead><tbody>{}</tbody></table>"#,
            rows.iter()
                .map(|(role, (provider, model))| {
                    let entry = catalog.iter().find(|entry| entry.id == *provider);
                    let provider_name = entry.map(|entry| entry.name.as_str()).unwrap_or(provider);
                    let model = if model.is_empty() {
                        entry.map(|entry| entry.default_model.as_str()).unwrap_or("既定")
                    } else {
                        model
                    };
                    let endpoint = entry
                        .map(|entry| entry.default_base_url.as_str())
                        .unwrap_or_default();
                    format!(
                        r#"<tr><td>{}</td><td>{} / {}</td><td>{}</td></tr>"#,
                        escape(role),
                        escape(provider_name),
                        escape(model),
                        escape(endpoint)
                    )
                })
                .collect::<String>()
        ));
    }
    Ok(())
}

fn populate_overrides(document: &Document, value: Option<&Value>, prefix: &str) {
    let value = value.unwrap_or(&Value::Null);
    set_value(
        document,
        &format!("setting-{prefix}-temperature"),
        &display(value.get("temperature")),
    );
    set_value(
        document,
        &format!("setting-{prefix}-top-p"),
        &display(value.get("topP")),
    );
    set_value(
        document,
        &format!("setting-{prefix}-scaffold"),
        string(value, "promptScaffold"),
    );
    let thinking = match value
        .get("deepseekThinkingEnabled")
        .and_then(Value::as_bool)
    {
        Some(true) => "on",
        Some(false) => "off",
        None => "",
    };
    set_value(
        document,
        &format!("setting-{prefix}-deepseek-thinking"),
        thinking,
    );
}

fn capture_overrides(document: &Document, prefix: &str) -> Map<String, Value> {
    let mut result = Map::new();
    insert_optional_number(
        &mut result,
        "temperature",
        &value(document, &format!("setting-{prefix}-temperature")),
    );
    insert_optional_number(
        &mut result,
        "topP",
        &value(document, &format!("setting-{prefix}-top-p")),
    );
    insert_optional_string(
        &mut result,
        "promptScaffold",
        &value(document, &format!("setting-{prefix}-scaffold")),
    );
    match value(document, &format!("setting-{prefix}-deepseek-thinking")).as_str() {
        "on" => {
            result.insert("deepseekThinkingEnabled".into(), Value::Bool(true));
        }
        "off" => {
            result.insert("deepseekThinkingEnabled".into(), Value::Bool(false));
        }
        _ => {}
    }
    result
}

fn populate_models(
    document: &Document,
    catalog: &[CatalogProvider],
    provider_id: &str,
    model_id: &str,
    selected: &str,
) -> Result<(), JsValue> {
    let provider = value(document, provider_id);
    let models = catalog
        .iter()
        .find(|item| item.id == provider)
        .map(|item| item.models.as_slice())
        .unwrap_or(&[]);
    if let Some(select) = select(document, model_id) {
        select.set_inner_html(
            &std::iter::once(r#"<option value="">プロバイダ既定</option>"#.to_owned())
                .chain(models.iter().map(|model| {
                    format!(
                        r#"<option value="{}">{}</option>"#,
                        escape(&model.id),
                        escape(model.label.as_deref().unwrap_or(&model.id))
                    )
                }))
                .collect::<String>(),
        );
        select.set_value(selected);
    }
    Ok(())
}

fn update_source_visibility(document: &Document, prefix: &str) -> Result<(), JsValue> {
    let custom = value(document, &format!("setting-{prefix}-source")) == "custom";
    let provider_id = format!("setting-{prefix}-provider");
    if let Some(row) = document
        .get_element_by_id(&provider_id)
        .and_then(|element| element.closest("label").ok().flatten())
    {
        row.class_list().toggle_with_force("hidden", !custom)?;
    }
    Ok(())
}

fn input(document: &Document, id: &str) -> Option<HtmlInputElement> {
    document.get_element_by_id(id)?.dyn_into().ok()
}
fn select(document: &Document, id: &str) -> Option<HtmlSelectElement> {
    document.get_element_by_id(id)?.dyn_into().ok()
}
fn value(document: &Document, id: &str) -> String {
    input(document, id)
        .map(|item| item.value())
        .or_else(|| select(document, id).map(|item| item.value()))
        .unwrap_or_default()
}
fn set_value(document: &Document, id: &str, value: &str) {
    if let Some(input) = input(document, id) {
        input.set_value(value);
    } else if let Some(select) = select(document, id) {
        select.set_value(value);
    }
}
fn set_checked(document: &Document, id: &str, checked: bool) {
    if let Some(input) = input(document, id) {
        input.set_checked(checked);
    }
}
fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}
fn nonempty<'a>(value: &'a str, fallback: &'a str) -> &'a str {
    if value.is_empty() {
        fallback
    } else {
        value
    }
}
fn display(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Number(value)) => value.to_string(),
        _ => String::new(),
    }
}
fn insert_optional_string(object: &mut Map<String, Value>, key: &str, value: &str) {
    if value.trim().is_empty() {
        object.remove(key);
    } else {
        object.insert(key.into(), Value::String(value.trim().into()));
    }
}
fn insert_optional_number(object: &mut Map<String, Value>, key: &str, value: &str) {
    if let Ok(value) = value.trim().parse::<f64>() {
        if let Some(number) = Number::from_f64(value) {
            object.insert(key.into(), Value::Number(number));
        }
    }
}
fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
