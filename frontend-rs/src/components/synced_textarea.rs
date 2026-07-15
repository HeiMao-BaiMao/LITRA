use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use js_sys::{Object, Reflect};
use wasm_bindgen::{closure::Closure, JsCast, JsValue};
use web_sys::{Document, Event, HtmlTextAreaElement};

use crate::runtime::tauri;

pub struct SyncedTextareaConfig {
    pub selector: &'static str,
    pub sync_event: &'static str,
    pub update_event: &'static str,
    pub enabled_placeholder: &'static str,
    pub disabled_placeholder: &'static str,
}

#[derive(Clone)]
pub struct SyncedTextareaHandle {
    episode_id: Rc<RefCell<Option<String>>>,
}

impl SyncedTextareaHandle {
    pub fn episode_id(&self) -> Option<String> {
        self.episode_id.borrow().clone()
    }
}

pub async fn mount(
    document: &Document,
    config: SyncedTextareaConfig,
) -> Result<SyncedTextareaHandle, JsValue> {
    let SyncedTextareaConfig {
        selector,
        sync_event,
        update_event,
        enabled_placeholder,
        disabled_placeholder,
    } = config;
    let textarea = document
        .query_selector(selector)?
        .ok_or_else(|| JsValue::from_str("synced textarea is missing"))?
        .dyn_into::<HtmlTextAreaElement>()?;
    let episode_id = Rc::new(RefCell::new(None::<String>));
    let pending_timeout = Rc::new(Cell::new(None::<i32>));

    {
        let textarea = textarea.clone();
        let episode_id = Rc::clone(&episode_id);
        tauri::listen(
            sync_event,
            Closure::wrap(Box::new(move |payload: JsValue| {
                let id = Reflect::get(&payload, &JsValue::from_str("episodeId"))
                    .ok()
                    .and_then(|value| value.as_string());
                let content = Reflect::get(&payload, &JsValue::from_str("content"))
                    .ok()
                    .and_then(|value| value.as_string())
                    .unwrap_or_default();
                let enabled = id.is_some();
                *episode_id.borrow_mut() = id;
                textarea.set_value(&content);
                textarea.set_disabled(!enabled);
                textarea.set_placeholder(if enabled {
                    enabled_placeholder
                } else {
                    disabled_placeholder
                });
            }) as Box<dyn FnMut(JsValue)>),
        )
        .await?;
    }

    {
        let input_textarea = textarea.clone();
        let episode_id = Rc::clone(&episode_id);
        let pending_timeout = Rc::clone(&pending_timeout);
        let on_input = Closure::wrap(Box::new(move |_event: Event| {
            let Some(id) = episode_id.borrow().clone() else {
                return;
            };
            let Some(window) = web_sys::window() else {
                return;
            };
            if let Some(timeout_id) = pending_timeout.take() {
                window.clear_timeout_with_handle(timeout_id);
            }
            let content = input_textarea.value();
            let callback = Closure::once_into_js(move || {
                let payload = Object::new();
                let _ = Reflect::set(&payload, &"episodeId".into(), &id.into());
                let _ = Reflect::set(&payload, &"content".into(), &content.into());
                tauri::emit(update_event, &payload);
            });
            if let Ok(timeout_id) = window.set_timeout_with_callback_and_timeout_and_arguments_0(
                callback.unchecked_ref(),
                400,
            ) {
                pending_timeout.set(Some(timeout_id));
            }
        }) as Box<dyn FnMut(Event)>);
        textarea.add_event_listener_with_callback("input", on_input.as_ref().unchecked_ref())?;
        on_input.forget();
    }

    Ok(SyncedTextareaHandle { episode_id })
}
