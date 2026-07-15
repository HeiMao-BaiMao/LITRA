mod render;
mod types;

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use js_sys::{Object, Reflect};
use wasm_bindgen::{closure::Closure, JsCast, JsValue};
use web_sys::{
    Document, Element, Event, HtmlButtonElement, HtmlFormElement, HtmlSelectElement,
    HtmlTextAreaElement, KeyboardEvent,
};

use crate::runtime::tauri;
use types::{ChatSettingsSyncPayload, ChatSyncPayload, ProviderConfig};

struct Controls {
    messages: Element,
    form: HtmlFormElement,
    input: HtmlTextAreaElement,
    send: HtmlButtonElement,
    cancel: HtmlButtonElement,
    direct_writing: HtmlButtonElement,
    provider: HtmlSelectElement,
    model: HtmlSelectElement,
}

pub async fn mount(document: &Document) -> Result<(), JsValue> {
    tauri::listen_dpi_zoom();
    let controls = Rc::new(query_controls(document)?);
    let provider_config = Rc::new(RefCell::new(ProviderConfig::default()));
    let is_syncing = Rc::new(Cell::new(false));
    let submit_shortcut = Rc::new(RefCell::new("ctrlEnter".to_owned()));

    {
        let controls = Rc::clone(&controls);
        tauri::listen(
            "chat-sync",
            Closure::wrap(Box::new(move |payload: JsValue| {
                let Ok(payload) = serde_wasm_bindgen::from_value::<ChatSyncPayload>(payload) else {
                    return;
                };
                render::render_messages(&controls.messages, &payload.messages);
                set_generating(&controls, payload.is_generating);
                set_direct_writing(&controls.direct_writing, payload.direct_writing_enabled);
            }) as Box<dyn FnMut(JsValue)>),
        )
        .await?;
    }

    {
        let messages = controls.messages.clone();
        tauri::listen(
            "chat-clear-display",
            Closure::wrap(Box::new(move |_payload: JsValue| {
                messages.set_inner_html("");
            }) as Box<dyn FnMut(JsValue)>),
        )
        .await?;
    }

    {
        let controls = Rc::clone(&controls);
        let provider_config = Rc::clone(&provider_config);
        let is_syncing = Rc::clone(&is_syncing);
        let submit_shortcut = Rc::clone(&submit_shortcut);
        tauri::listen(
            "chat-settings-sync",
            Closure::wrap(Box::new(move |payload: JsValue| {
                let Ok(payload) =
                    serde_wasm_bindgen::from_value::<ChatSettingsSyncPayload>(payload)
                else {
                    return;
                };
                is_syncing.set(true);
                *submit_shortcut.borrow_mut() = payload
                    .chat_submit_shortcut
                    .unwrap_or_else(|| "ctrlEnter".to_owned());
                *provider_config.borrow_mut() = payload.provider_config;
                controls
                    .provider
                    .set_inner_html(&render::provider_options(&provider_config.borrow()));
                controls.provider.set_value(&payload.provider);
                controls.model.set_inner_html(&render::model_options(
                    &provider_config.borrow(),
                    &payload.provider,
                ));
                controls.model.set_value(&payload.model);
                is_syncing.set(false);
            }) as Box<dyn FnMut(JsValue)>),
        )
        .await?;
    }

    bind_provider_change(
        &controls,
        Rc::clone(&provider_config),
        Rc::clone(&is_syncing),
    )?;
    bind_model_change(&controls, is_syncing)?;
    bind_submit(&controls)?;
    bind_submit_shortcut(&controls, submit_shortcut)?;
    bind_cancel(&controls)?;
    bind_direct_writing(&controls)?;
    bind_auto_resize(&controls.input)?;
    tauri::emit("chat-ready", &Object::new());
    Ok(())
}

fn query_controls(document: &Document) -> Result<Controls, JsValue> {
    Ok(Controls {
        messages: required(document, "#chat-messages")?,
        form: required(document, "#chat-form")?.dyn_into()?,
        input: required(document, "#chat-input")?.dyn_into()?,
        send: required(document, "#btn-send")?.dyn_into()?,
        cancel: required(document, "#btn-cancel")?.dyn_into()?,
        direct_writing: required(document, "#btn-direct-writing")?.dyn_into()?,
        provider: required(document, "#chat-provider")?.dyn_into()?,
        model: required(document, "#chat-model")?.dyn_into()?,
    })
}

fn required(document: &Document, selector: &str) -> Result<Element, JsValue> {
    document
        .query_selector(selector)?
        .ok_or_else(|| JsValue::from_str(&format!("chat control is missing: {selector}")))
}

fn set_generating(controls: &Controls, generating: bool) {
    let _ = controls
        .form
        .class_list()
        .toggle_with_force("is-generating", generating);
    controls.input.set_disabled(generating);
    controls.send.set_disabled(generating);
    controls.cancel.set_disabled(!generating);
    let _ = controls
        .cancel
        .class_list()
        .toggle_with_force("hidden", !generating);
    let _ = controls
        .cancel
        .class_list()
        .toggle_with_force("is-active", generating);
    controls.direct_writing.set_disabled(generating);
}

fn set_direct_writing(button: &HtmlButtonElement, enabled: bool) {
    button.set_text_content(Some(if enabled {
        "⚡ 直接執筆 ON"
    } else {
        "⚡ 直接執筆 OFF"
    }));
    let _ = button.class_list().toggle_with_force("is-active", enabled);
    let _ = button.set_attribute("aria-pressed", if enabled { "true" } else { "false" });
}

fn bind_provider_change(
    controls: &Rc<Controls>,
    config: Rc<RefCell<ProviderConfig>>,
    is_syncing: Rc<Cell<bool>>,
) -> Result<(), JsValue> {
    let provider_select = controls.provider.clone();
    let controls = Rc::clone(controls);
    let on_change = Closure::wrap(Box::new(move |_event: Event| {
        if is_syncing.get() {
            return;
        }
        let provider = controls.provider.value();
        controls
            .model
            .set_inner_html(&render::model_options(&config.borrow(), &provider));
        emit_settings(&provider, &controls.model.value());
    }) as Box<dyn FnMut(Event)>);
    provider_select
        .add_event_listener_with_callback("change", on_change.as_ref().unchecked_ref())?;
    on_change.forget();
    Ok(())
}

fn bind_model_change(controls: &Rc<Controls>, is_syncing: Rc<Cell<bool>>) -> Result<(), JsValue> {
    let model_select = controls.model.clone();
    let controls = Rc::clone(controls);
    let on_change = Closure::wrap(Box::new(move |_event: Event| {
        if !is_syncing.get() {
            emit_settings(&controls.provider.value(), &controls.model.value());
        }
    }) as Box<dyn FnMut(Event)>);
    model_select.add_event_listener_with_callback("change", on_change.as_ref().unchecked_ref())?;
    on_change.forget();
    Ok(())
}

fn bind_submit(controls: &Rc<Controls>) -> Result<(), JsValue> {
    let form = controls.form.clone();
    let controls = Rc::clone(controls);
    let on_submit = Closure::wrap(Box::new(move |event: Event| {
        event.prevent_default();
        let text = controls.input.value().trim().to_owned();
        if text.is_empty() {
            return;
        }
        controls.input.set_value("");
        resize_input(&controls.input);
        emit_string("chat-send", "content", &text);
    }) as Box<dyn FnMut(Event)>);
    form.add_event_listener_with_callback("submit", on_submit.as_ref().unchecked_ref())?;
    on_submit.forget();
    Ok(())
}

fn bind_submit_shortcut(
    controls: &Rc<Controls>,
    shortcut: Rc<RefCell<String>>,
) -> Result<(), JsValue> {
    let form = controls.form.clone();
    let on_keydown = Closure::wrap(Box::new(move |event: KeyboardEvent| {
        if event.key() != "Enter" || event.is_composing() {
            return;
        }
        let submit = if shortcut.borrow().as_str() == "enter" {
            !event.shift_key()
        } else {
            !event.shift_key() && (event.ctrl_key() || event.meta_key())
        };
        if submit {
            event.prevent_default();
            let _ = form.request_submit();
        }
    }) as Box<dyn FnMut(KeyboardEvent)>);
    controls
        .input
        .add_event_listener_with_callback("keydown", on_keydown.as_ref().unchecked_ref())?;
    on_keydown.forget();
    Ok(())
}

fn bind_cancel(controls: &Rc<Controls>) -> Result<(), JsValue> {
    let on_click = Closure::wrap(Box::new(move |_event: Event| {
        tauri::emit("chat-stop", &Object::new());
    }) as Box<dyn FnMut(Event)>);
    controls
        .cancel
        .add_event_listener_with_callback("click", on_click.as_ref().unchecked_ref())?;
    on_click.forget();
    Ok(())
}

fn bind_direct_writing(controls: &Rc<Controls>) -> Result<(), JsValue> {
    let button = controls.direct_writing.clone();
    let on_click = Closure::wrap(Box::new(move |_event: Event| {
        if !button.disabled() {
            tauri::emit("chat-direct-writing-toggle", &Object::new());
        }
    }) as Box<dyn FnMut(Event)>);
    controls
        .direct_writing
        .add_event_listener_with_callback("click", on_click.as_ref().unchecked_ref())?;
    on_click.forget();
    Ok(())
}

fn bind_auto_resize(input: &HtmlTextAreaElement) -> Result<(), JsValue> {
    let input_for_event = input.clone();
    let on_input = Closure::wrap(Box::new(move |_event: Event| {
        resize_input(&input_for_event);
    }) as Box<dyn FnMut(Event)>);
    input.add_event_listener_with_callback("input", on_input.as_ref().unchecked_ref())?;
    on_input.forget();
    Ok(())
}

fn resize_input(input: &HtmlTextAreaElement) {
    let style = input.style();
    let _ = style.set_property("height", "auto");
    let height = input.scroll_height().min(15 * 24);
    let _ = style.set_property("height", &format!("{height}px"));
}

fn emit_settings(provider: &str, model: &str) {
    let payload = Object::new();
    let _ = Reflect::set(&payload, &"provider".into(), &provider.into());
    let _ = Reflect::set(&payload, &"model".into(), &model.into());
    tauri::emit("chat-settings-change", &payload);
}

fn emit_string(event: &str, key: &str, value: &str) {
    let payload = Object::new();
    let _ = Reflect::set(&payload, &key.into(), &value.into());
    tauri::emit(event, &payload);
}
