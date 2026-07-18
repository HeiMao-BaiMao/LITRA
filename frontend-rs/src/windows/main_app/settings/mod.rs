use std::{cell::RefCell, rc::Rc};

use serde::Serialize;
use serde_json::{json, Value};
use wasm_bindgen::{JsCast, JsValue};
use web_sys::{Document, HtmlInputElement, HtmlSelectElement};

use super::State;
use crate::runtime::invoke;

pub(super) mod integrations;
mod licenses;
mod oauth_ui;
pub(super) use oauth_ui::{cancel_oauth, logout_oauth, start_oauth};

#[derive(Serialize)]
struct Empty {}
#[derive(Serialize)]
struct SaveArgs<'a> {
    settings: &'a Value,
}

pub async fn open(document: &Document, state: &Rc<RefCell<State>>) -> Result<(), JsValue> {
    let settings: Value = invoke::invoke("ai_settings_snapshot", &Empty {}).await?;
    state.borrow_mut().ai_settings = settings;
    populate(document, &state.borrow())?;
    integrations::populate(document).await?;
    set_hidden(document, false)
}

pub async fn save(document: &Document, state: &Rc<RefCell<State>>) -> Result<(), JsValue> {
    let mut settings = state.borrow().ai_settings.clone();
    let object = settings
        .as_object_mut()
        .ok_or_else(|| JsValue::from_str("settings invalid"))?;
    for (id, key) in [
        ("setting-provider", "provider"),
        ("setting-api-key", "apiKey"),
        ("setting-base-url", "baseUrl"),
        ("setting-model", "model"),
        ("setting-chat-submit-shortcut", "chatSubmitShortcut"),
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
        if let Some(value) = control_value(document, id) {
            object.insert(key.into(), Value::String(value));
        }
    }
    for (id, key) in [
        ("setting-temperature", "temperature"),
        ("setting-max-tokens", "maxTokens"),
        ("setting-max-context-tokens", "maxContextTokens"),
        ("setting-top-p", "topP"),
        ("setting-top-k", "topK"),
        ("setting-frequency-penalty", "frequencyPenalty"),
        ("setting-presence-penalty", "presencePenalty"),
        (
            "setting-anthropic-thinking-budget",
            "anthropicThinkingBudget",
        ),
    ] {
        if let Some(value) = control_value(document, id).and_then(|value| value.parse::<f64>().ok())
        {
            if let Some(number) = serde_json::Number::from_f64(value) {
                object.insert(key.into(), Value::Number(number));
            }
        }
    }
    for (id, key) in [
        ("setting-deepseek-thinking", "deepseekThinkingEnabled"),
        (
            "setting-anthropic-thinking-enabled",
            "anthropicThinkingEnabled",
        ),
        ("setting-two-stage-continuation", "twoStageContinuation"),
        ("setting-continuation-review", "continuationReviewEnabled"),
        (
            "setting-continuation-scene-state",
            "continuationSceneStateEnabled",
        ),
        (
            "setting-continuation-character-voice",
            "continuationCharacterVoiceEnabled",
        ),
        ("setting-continuation-best-of-two", "continuationBestOfTwo"),
        (
            "setting-continuation-targeted-revision",
            "continuationTargetedRevision",
        ),
        (
            "setting-continuation-beat-split",
            "continuationBeatSplitEnabled",
        ),
    ] {
        if let Some(input) = document
            .get_element_by_id(id)
            .and_then(|item| item.dyn_into::<HtmlInputElement>().ok())
        {
            object.insert(key.into(), Value::Bool(input.checked()));
        }
    }
    invoke::invoke::<_, ()>(
        "ai_settings_save",
        &SaveArgs {
            settings: &settings,
        },
    )
    .await?;
    integrations::save(document).await?;
    state.borrow_mut().ai_settings = settings;
    set_hidden(document, true)
}

pub fn cancel(document: &Document) -> Result<(), JsValue> {
    set_hidden(document, true)
}

pub fn show_licenses(document: &Document) -> Result<(), JsValue> {
    licenses::show(document)
}

pub fn close_licenses(document: &Document) -> Result<(), JsValue> {
    licenses::close(document)
}

pub fn provider_changed(
    document: &Document,
    state: &Rc<RefCell<State>>,
    provider_id: &str,
) -> Result<(), JsValue> {
    let current = state.borrow();
    let provider = current
        .catalog
        .iter()
        .find(|provider| provider.id == provider_id);
    if let Some(list) = document.get_element_by_id("setting-model-list") {
        let options = provider
            .map(|provider| {
                provider
                    .models
                    .iter()
                    .map(|model| {
                        format!(
                            r#"<option value="{}">{}</option>"#,
                            escape(&model.id),
                            escape(model.label.as_deref().unwrap_or(&model.id))
                        )
                    })
                    .collect::<String>()
            })
            .unwrap_or_default();
        list.set_inner_html(&options);
    }
    oauth_ui::provider_changed(document, provider_id)
}

fn populate(document: &Document, state: &State) -> Result<(), JsValue> {
    let settings = &state.ai_settings;
    if let Some(select) = document
        .get_element_by_id("setting-provider")
        .and_then(|item| item.dyn_into::<HtmlSelectElement>().ok())
    {
        select.set_inner_html(
            &state
                .catalog
                .iter()
                .map(|provider| {
                    format!(
                        r#"<option value="{}">{}</option>"#,
                        escape(&provider.id),
                        escape(&provider.name)
                    )
                })
                .collect::<String>(),
        );
        select.set_value(
            settings
                .get("provider")
                .and_then(Value::as_str)
                .unwrap_or("openai"),
        );
    }
    for (id, key, fallback) in [
        ("setting-api-key", "apiKey", ""),
        ("setting-base-url", "baseUrl", ""),
        ("setting-model", "model", ""),
        ("setting-temperature", "temperature", "1"),
        ("setting-max-tokens", "maxTokens", "8192"),
        ("setting-max-context-tokens", "maxContextTokens", "128000"),
        ("setting-top-p", "topP", ""),
        ("setting-top-k", "topK", ""),
        ("setting-frequency-penalty", "frequencyPenalty", ""),
        ("setting-presence-penalty", "presencePenalty", ""),
        (
            "setting-chat-submit-shortcut",
            "chatSubmitShortcut",
            "ctrlEnter",
        ),
    ] {
        set_control(
            document,
            id,
            display(settings.get(key)).unwrap_or_else(|| fallback.into()),
        );
    }
    provider_changed(
        document,
        &Rc::new(RefCell::new(State {
            ai_settings: json!({}),
            catalog: state.catalog.clone(),
            ..Default::default()
        })),
        settings
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or("openai"),
    )?;
    Ok(())
}

fn display(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}
fn set_control(document: &Document, id: &str, value: String) {
    if let Some(input) = document
        .get_element_by_id(id)
        .and_then(|item| item.dyn_into::<HtmlInputElement>().ok())
    {
        input.set_value(&value);
    } else if let Some(select) = document
        .get_element_by_id(id)
        .and_then(|item| item.dyn_into::<HtmlSelectElement>().ok())
    {
        select.set_value(&value);
    }
}
fn control_value(document: &Document, id: &str) -> Option<String> {
    document.get_element_by_id(id).and_then(|item| {
        item.dyn_into::<HtmlInputElement>()
            .map(|input| input.value())
            .or_else(|item| {
                item.dyn_into::<HtmlSelectElement>()
                    .map(|select| select.value())
            })
            .ok()
    })
}
fn set_hidden(document: &Document, hidden: bool) -> Result<(), JsValue> {
    if let Some(modal) = document.get_element_by_id("settings-modal") {
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
