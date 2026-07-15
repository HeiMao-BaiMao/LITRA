use js_sys::{Object, Reflect};
use wasm_bindgen::{closure::Closure, JsCast, JsValue};
use web_sys::{Document, Event, HtmlButtonElement};

use crate::{
    components::synced_textarea::{self, SyncedTextareaConfig},
    runtime::tauri,
};

pub fn mount(document: &Document) -> Result<(), JsValue> {
    tauri::listen_dpi_zoom();
    let textarea = synced_textarea::mount(
        document,
        SyncedTextareaConfig {
            selector: "#summary-textarea",
            sync_event: "summary-sync",
            update_event: "summary-update",
            ready_event: "summary-ready",
            enabled_placeholder: "このエピソードの要約を入力...",
            disabled_placeholder: "エピソードを選択してください...",
        },
    )?;
    let generate_button = document
        .query_selector("#btn-generate-summary")?
        .ok_or_else(|| JsValue::from_str("summary generate button is missing"))?
        .dyn_into::<HtmlButtonElement>()?;

    {
        let generate_button = generate_button.clone();
        tauri::listen(
            "summary-sync",
            Closure::wrap(Box::new(move |payload: JsValue| {
                let enabled = Reflect::get(&payload, &JsValue::from_str("episodeId"))
                    .ok()
                    .and_then(|value| value.as_string())
                    .is_some();
                generate_button.set_disabled(!enabled);
            }) as Box<dyn FnMut(JsValue)>),
        );
    }

    {
        let on_click = Closure::wrap(Box::new(move |_event: Event| {
            let Some(id) = textarea.episode_id() else {
                return;
            };
            let payload = Object::new();
            let _ = Reflect::set(&payload, &"episodeId".into(), &id.into());
            tauri::emit("summary-generate", &payload);
        }) as Box<dyn FnMut(Event)>);
        generate_button
            .add_event_listener_with_callback("click", on_click.as_ref().unchecked_ref())?;
        on_click.forget();
    }

    Ok(())
}
