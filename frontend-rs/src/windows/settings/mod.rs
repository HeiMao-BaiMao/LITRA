mod events;
mod render;
mod types;

use std::{cell::RefCell, rc::Rc};

use js_sys::{Object, Reflect};
use wasm_bindgen::{closure::Closure, JsCast, JsValue};
use web_sys::{Document, Element, Event};

use crate::runtime::tauri;
use types::SettingsState;

pub async fn mount(document: &Document) -> Result<(), JsValue> {
    tauri::listen_dpi_zoom();
    mount_editor(document, true).await
}

pub async fn mount_inline(document: &Document) -> Result<(), JsValue> {
    mount_editor(document, false).await
}

async fn mount_editor(document: &Document, bind_tabs: bool) -> Result<(), JsValue> {
    let container = required(document, "#settings-container")?;
    let state = Rc::new(RefCell::new(SettingsState::default()));

    {
        let document = document.clone();
        let state = Rc::clone(&state);
        tauri::listen(
            "settings-sync",
            Closure::wrap(Box::new(move |payload: JsValue| {
                let Ok(mut payload) = serde_wasm_bindgen::from_value::<SettingsState>(payload)
                else {
                    return;
                };
                payload.relationship_episode_id = state.borrow().relationship_episode_id.clone();
                let editing = document
                    .active_element()
                    .and_then(|element| element.closest("#settings-container").ok().flatten())
                    .is_some();
                if !editing {
                    let _ = render::update_tabs(&document, &payload.view);
                    let _ = render::render(&document, &payload);
                }
                *state.borrow_mut() = payload;
            }) as Box<dyn FnMut(JsValue)>),
        )
        .await?;
    }

    if bind_tabs {
        bind_tab(document, "#tab-characters", "characters", Rc::clone(&state))?;
        bind_tab(document, "#tab-world", "world", Rc::clone(&state))?;
        bind_tab(
            document,
            "#tab-relationships",
            "relationships",
            Rc::clone(&state),
        )?;
        bind_tab(document, "#tab-update", "update", Rc::clone(&state))?;
    }
    events::bind(document, &container, state)?;
    bind_resizer(document)?;
    tauri::emit("settings-ready", &Object::new());
    Ok(())
}

fn bind_resizer(document: &Document) -> Result<(), JsValue> {
    use crate::data::layout_store;
    use crate::ui::resizable::{
        apply_stored_ratio, create_vertical_resizer, ResizerConfig, ResizerPosition,
    };

    let Some(el) = document
        .get_element_by_id("settings-container")
        .and_then(|el| el.dyn_into::<web_sys::HtmlElement>().ok())
    else {
        return Ok(());
    };
    apply_stored_ratio(
        el.clone(),
        "--settings-sidebar-width",
        layout_store::PANEL_SETTINGS_SIDEBAR,
        0.25,
    );
    let _ = create_vertical_resizer(
        document,
        ResizerConfig::new(
            el,
            "--settings-sidebar-width",
            ResizerPosition::Inside,
            layout_store::PANEL_SETTINGS_SIDEBAR,
        ),
    )?;
    Ok(())
}

fn required(document: &Document, selector: &str) -> Result<Element, JsValue> {
    document
        .query_selector(selector)?
        .ok_or_else(|| JsValue::from_str(&format!("settings control is missing: {selector}")))
}

fn bind_tab(
    document: &Document,
    selector: &str,
    view: &'static str,
    state: Rc<RefCell<SettingsState>>,
) -> Result<(), JsValue> {
    let tab = required(document, selector)?;
    let document = document.clone();
    let on_click = Closure::wrap(Box::new(move |_event: Event| {
        state.borrow_mut().view = view.into();
        let _ = render::update_tabs(&document, view);
        let _ = render::render(&document, &state.borrow());
        let payload = Object::new();
        let _ = Reflect::set(&payload, &"view".into(), &view.into());
        tauri::emit("settings-select-view", &payload);
    }) as Box<dyn FnMut(Event)>);
    tab.add_event_listener_with_callback("click", on_click.as_ref().unchecked_ref())?;
    on_click.forget();
    Ok(())
}
