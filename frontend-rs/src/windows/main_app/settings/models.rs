use std::{cell::RefCell, rc::Rc};

use serde::{Deserialize, Serialize};
use wasm_bindgen::{JsCast, JsValue};
use web_sys::{Document, HtmlInputElement, HtmlSelectElement};

use super::super::State;
use crate::runtime::invoke;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelRequest<'a> {
    provider: &'a str,
    api_key: &'a str,
    base_url: &'a str,
}

#[derive(Serialize)]
struct Args<'a> {
    request: ModelRequest<'a>,
}

#[derive(Deserialize)]
struct ModelInfo {
    id: String,
}

pub async fn fetch(document: &Document, state: &Rc<RefCell<State>>) -> Result<(), JsValue> {
    let provider = select_value(document, "setting-provider");
    let fixed = state
        .borrow()
        .catalog
        .iter()
        .find(|item| item.id == provider)
        .is_some_and(|item| item.fixed_models);
    if fixed {
        update_button(document, Some(true))?;
        return Ok(());
    }
    set_button(document, true, "取得中…")?;
    let api_key = input_value(document, "setting-api-key");
    let base_url = input_value(document, "setting-base-url");
    let result: Result<Vec<ModelInfo>, JsValue> = invoke::invoke(
        "ai_list_models",
        &Args {
            request: ModelRequest {
                provider: &provider,
                api_key: &api_key,
                base_url: &base_url,
            },
        },
    )
    .await;
    match result {
        Ok(models) => {
            let configured = state
                .borrow()
                .catalog
                .iter()
                .find(|item| item.id == provider)
                .map(|item| {
                    item.models
                        .iter()
                        .map(|model| model.id.clone())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let mut ids = models.into_iter().map(|model| model.id).collect::<Vec<_>>();
            ids.extend(configured);
            ids.sort();
            ids.dedup();
            if let Some(list) = document.get_element_by_id("setting-model-list") {
                list.set_inner_html(
                    &ids.iter()
                        .map(|id| format!(r#"<option value="{}"></option>"#, escape(id)))
                        .collect::<String>(),
                );
            }
            set_button(document, false, &format!("取得済み ({})", ids.len()))
        }
        Err(error) => {
            set_button(document, false, "取得失敗")?;
            Err(error)
        }
    }
}

pub fn update_button(document: &Document, fixed: Option<bool>) -> Result<(), JsValue> {
    if fixed.unwrap_or(false) {
        set_button(document, true, "モデルは固定")
    } else {
        set_button(document, false, "取得")
    }
}

fn set_button(document: &Document, disabled: bool, text: &str) -> Result<(), JsValue> {
    if let Some(button) = document.get_element_by_id("btn-fetch-models") {
        button.set_text_content(Some(text));
        if disabled {
            button.set_attribute("disabled", "")?;
        } else {
            button.remove_attribute("disabled")?;
        }
    }
    Ok(())
}
fn input_value(document: &Document, id: &str) -> String {
    document
        .get_element_by_id(id)
        .and_then(|item| item.dyn_into::<HtmlInputElement>().ok())
        .map(|input| input.value())
        .unwrap_or_default()
}
fn select_value(document: &Document, id: &str) -> String {
    document
        .get_element_by_id(id)
        .and_then(|item| item.dyn_into::<HtmlSelectElement>().ok())
        .map(|select| select.value())
        .unwrap_or_default()
}
fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
