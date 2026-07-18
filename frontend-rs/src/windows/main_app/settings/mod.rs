use std::{cell::RefCell, rc::Rc};

use serde::Serialize;
use serde_json::{json, Value};
use wasm_bindgen::{JsCast, JsValue};
use web_sys::{Document, HtmlInputElement, HtmlSelectElement};

use super::State;
use crate::runtime::invoke;

pub(super) mod form;
pub(super) mod integrations;
mod licenses;
mod models;
mod oauth_ui;
pub(super) use oauth_ui::{cancel_oauth, logout_oauth, start_oauth};

#[derive(Serialize)]
struct Empty {}
#[derive(Serialize)]
struct SaveArgs<'a> {
    settings: &'a Value,
}

#[derive(Serialize)]
struct SecretArgs<'a> {
    key: &'a str,
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
        let raw = control_value(document, id).unwrap_or_default();
        if raw.trim().is_empty()
            && matches!(
                key,
                "topP"
                    | "topK"
                    | "frequencyPenalty"
                    | "presencePenalty"
                    | "anthropicThinkingBudget"
            )
        {
            object.remove(key);
        } else if let Ok(value) = raw.parse::<f64>() {
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
    form::capture(document, object)?;
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

pub async fn save_chat_selection(provider: &str, model: Option<&str>) -> Result<(), JsValue> {
    let mut settings: Value = invoke::invoke("ai_settings_snapshot", &Empty {}).await?;
    let object = settings
        .as_object_mut()
        .ok_or_else(|| JsValue::from_str("settings invalid"))?;
    object.insert("chatProvider".into(), Value::String(provider.into()));
    if let Some(model) = model.filter(|model| !model.trim().is_empty()) {
        object.insert("chatModel".into(), Value::String(model.into()));
    } else {
        object.remove("chatModel");
    }
    invoke::invoke::<_, ()>(
        "ai_settings_save",
        &SaveArgs {
            settings: &settings,
        },
    )
    .await
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

pub async fn fetch_models(document: &Document, state: &Rc<RefCell<State>>) -> Result<(), JsValue> {
    models::fetch(document, state).await
}

pub fn toggle_advanced(document: &Document) -> Result<(), JsValue> {
    let Some(section) = document.get_element_by_id("advanced-settings") else {
        return Ok(());
    };
    let hidden = !section.class_list().contains("hidden");
    section.class_list().toggle_with_force("hidden", hidden)?;
    if let Some(button) = document.get_element_by_id("advanced-settings-toggle") {
        button.set_attribute("aria-expanded", if hidden { "false" } else { "true" })?;
    }
    Ok(())
}

pub async fn reset(document: &Document, state: &Rc<RefCell<State>>) -> Result<(), JsValue> {
    let confirmed = web_sys::window()
        .and_then(|window| {
            window
                .confirm_with_message("AI・同期・ウィンドウ設定を初期化しますか？")
                .ok()
        })
        .unwrap_or(false);
    if !confirmed {
        return Ok(());
    }
    invoke::invoke::<_, ()>("ai_settings_reset", &Empty {}).await?;
    let settings: Value = invoke::invoke("ai_settings_snapshot", &Empty {}).await?;
    let catalog = crate::runtime::ai::catalog().await?;
    {
        let mut current = state.borrow_mut();
        current.ai_settings = settings;
        current.catalog = catalog;
    }
    populate(document, &state.borrow())?;
    integrations::populate(document).await
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
    let fixed = provider.is_some_and(|provider| provider.fixed_models);
    if let Some(input) = document.get_element_by_id("setting-model") {
        input.class_list().toggle_with_force("hidden", fixed)?;
    }
    if let Some(select) = document
        .get_element_by_id("setting-model-select")
        .and_then(|item| item.dyn_into::<HtmlSelectElement>().ok())
    {
        select.class_list().toggle_with_force("hidden", !fixed)?;
        if let Some(provider) = provider {
            select.set_inner_html(
                &provider
                    .models
                    .iter()
                    .map(|model| {
                        format!(
                            r#"<option value="{}">{}</option>"#,
                            escape(&model.id),
                            escape(model.label.as_deref().unwrap_or(&model.id))
                        )
                    })
                    .collect::<String>(),
            );
            select.set_value(&control_value(document, "setting-model").unwrap_or_default());
        }
    }
    models::update_button(document, provider.map(|provider| provider.fixed_models))?;
    for (selector, visible) in [
        (
            ".provider-field-openai",
            matches!(provider_id, "openai" | "codex" | "github-copilot"),
        ),
        (".provider-field-deepseek", provider_id == "deepseek"),
        (".provider-field-anthropic", provider_id == "anthropic"),
        (
            ".provider-field-anthropic-adaptive",
            provider_id == "anthropic",
        ),
        (".provider-field-google", provider_id == "google"),
    ] {
        if let Some(element) = document.query_selector(selector)? {
            element.class_list().toggle_with_force("hidden", !visible)?;
        }
    }
    oauth_ui::provider_changed(document, provider_id)
}

pub async fn switch_provider(
    document: &Document,
    state: &Rc<RefCell<State>>,
    provider_id: &str,
) -> Result<(), JsValue> {
    let mut settings = state.borrow().ai_settings.clone();
    let previous = settings
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("openai")
        .to_owned();
    capture_provider(document, &mut settings, &previous)?;
    let catalog = state.borrow().catalog.clone();
    let fallback = catalog.iter().find(|provider| provider.id == provider_id);
    let config = settings
        .get("providerConfigs")
        .and_then(Value::as_object)
        .and_then(|configs| configs.get(provider_id))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let key_changed = config
        .get("apiKeyChanged")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut api_key = config
        .get("apiKey")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if api_key.is_empty() && !key_changed {
        api_key = invoke::invoke::<_, Option<String>>(
            "secret_get",
            &SecretArgs {
                key: &format!("apikey:{provider_id}"),
            },
        )
        .await?
        .unwrap_or_default();
    }
    let base_url = config
        .get("baseUrl")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or_else(|| fallback.map(|provider| provider.default_base_url.clone()))
        .unwrap_or_default();
    let model = config
        .get("model")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or_else(|| fallback.map(|provider| provider.default_model.clone()))
        .unwrap_or_default();
    if let Some(object) = settings.as_object_mut() {
        object.insert("provider".into(), Value::String(provider_id.into()));
        object.insert("apiKey".into(), Value::String(api_key.clone()));
        object.insert("baseUrl".into(), Value::String(base_url.clone()));
        object.insert("model".into(), Value::String(model.clone()));
    }
    state.borrow_mut().ai_settings = settings;
    set_control(document, "setting-api-key", api_key);
    set_control(document, "setting-base-url", base_url);
    set_control(document, "setting-model", model.clone());
    provider_changed(document, state, provider_id)?;
    if let Some(select) = document
        .get_element_by_id("setting-model-select")
        .and_then(|item| item.dyn_into::<HtmlSelectElement>().ok())
    {
        select.set_value(&model);
    }
    Ok(())
}

fn capture_provider(
    document: &Document,
    settings: &mut Value,
    provider_id: &str,
) -> Result<(), JsValue> {
    let object = settings
        .as_object_mut()
        .ok_or_else(|| JsValue::from_str("settings invalid"))?;
    let configs = object
        .entry("providerConfigs")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| JsValue::from_str("providerConfigs invalid"))?;
    let config = configs
        .entry(provider_id)
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| JsValue::from_str("provider config invalid"))?;
    config.insert(
        "apiKey".into(),
        Value::String(control_value(document, "setting-api-key").unwrap_or_default()),
    );
    config.insert("apiKeyChanged".into(), Value::Bool(true));
    config.insert(
        "baseUrl".into(),
        Value::String(control_value(document, "setting-base-url").unwrap_or_default()),
    );
    config.insert(
        "model".into(),
        Value::String(control_value(document, "setting-model").unwrap_or_default()),
    );
    Ok(())
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
    form::populate(document, settings, &state.catalog)?;
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
