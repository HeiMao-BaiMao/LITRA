//! ドラッグでリサイズ可能なパネル区切り線。
//! TypeScript `src/ui/resizable.ts` の移植。

use std::cell::RefCell;
use std::rc::Rc;

use wasm_bindgen::{closure::Closure, JsCast, JsValue};
use web_sys::{Document, Element, HtmlElement, PointerEvent};

use crate::data::layout_store;

#[derive(Clone, Copy, Debug)]
pub enum ResizerPosition {
    Left,
    Right,
    #[allow(dead_code)]
    Inside,
}

pub struct ResizerConfig {
    pub container: HtmlElement,
    pub property_name: String,
    pub position: ResizerPosition,
    pub save_key: String,
    pub min_ratio: f64,
    pub max_ratio: f64,
}

impl ResizerConfig {
    pub fn new(
        container: HtmlElement,
        property_name: impl Into<String>,
        position: ResizerPosition,
        save_key: impl Into<String>,
    ) -> Self {
        Self {
            container,
            property_name: property_name.into(),
            position,
            save_key: save_key.into(),
            min_ratio: 0.1,
            max_ratio: 0.5,
        }
    }
}

fn parse_ratio(value: &str) -> f64 {
    if value.is_empty() {
        return 0.0;
    }
    let parsed = value.trim_end_matches('%').parse::<f64>().unwrap_or(0.0);
    if parsed.is_nan() {
        0.0
    } else {
        parsed / 100.0
    }
}

fn clamp_ratio(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}

pub fn apply_stored_ratio(
    container: HtmlElement,
    property_name: &str,
    save_key: &str,
    fallback_ratio: f64,
) {
    let property = property_name.to_string();
    let key = save_key.to_string();
    wasm_bindgen_futures::spawn_local(async move {
        let ratio = layout_store::load_panel_ratio(&key)
            .await
            .unwrap_or(fallback_ratio);
        let _ = container
            .style()
            .set_property(&property, &format!("{:.2}%", ratio * 100.0));
    });
}

pub fn create_vertical_resizer(
    document: &Document,
    config: ResizerConfig,
) -> Result<Element, JsValue> {
    let ResizerConfig {
        container,
        property_name,
        position,
        save_key,
        min_ratio,
        max_ratio,
    } = config;

    let resizer_div = document.create_element("div")?;
    let position_class = match position {
        ResizerPosition::Left => "left",
        ResizerPosition::Right => "right",
        ResizerPosition::Inside => "inside",
    };
    resizer_div.set_class_name(&format!(
        "resizer resizer-vertical resizer-{position_class}"
    ));
    let _ = resizer_div.set_attribute("role", "separator");
    let _ = resizer_div.set_attribute("aria-orientation", "vertical");
    let _ = resizer_div.set_attribute("aria-label", "パネル幅を調整");

    let line = document.create_element("div")?;
    line.set_class_name("resizer-line");
    resizer_div.append_child(&line)?;
    container.append_child(&resizer_div)?;

    let resizer: HtmlElement = resizer_div.dyn_into()?;
    let state = Rc::new(RefCell::new(DragState {
        start_x: 0.0,
        start_ratio: 0.0,
        dragging: false,
    }));

    // pointerdown
    {
        let resizer_clone = resizer.clone();
        let container_clone = container.clone();
        let state_clone = state.clone();
        let property = property_name.clone();
        let on_pointer_down =
            Closure::wrap(Box::new(move |event: PointerEvent| {
                if event.button() != 0 {
                    return;
                }
                event.prevent_default();
                state_clone.borrow_mut().start_x = event.client_x() as f64;
                let style_value = container_clone
                    .style()
                    .get_property_value(&property)
                    .unwrap_or_default();
                let mut start_ratio = parse_ratio(&style_value);
                if start_ratio == 0.0 {
                    if let Some(window) = web_sys::window() {
                        if let Ok(Some(computed)) =
                            window.get_computed_style(&container_clone)
                        {
                            start_ratio = parse_ratio(
                                &computed
                                    .get_property_value(&property)
                                    .unwrap_or_default(),
                            );
                        }
                    }
                }
                state_clone.borrow_mut().start_ratio = start_ratio;
                state_clone.borrow_mut().dragging = true;
                let _ = resizer_clone.set_pointer_capture(event.pointer_id());
                let _ = resizer_clone.class_list().add_1("resizer-dragging");
                if let Some(document) = web_sys::window().and_then(|w| w.document()) {
                    if let Some(body) = document.body() {
                        let _ = body.style().set_property("user-select", "none");
                    }
                }
            }) as Box<dyn FnMut(PointerEvent)>);
        resizer.add_event_listener_with_callback(
            "pointerdown",
            on_pointer_down.as_ref().unchecked_ref(),
        )?;
        on_pointer_down.forget();
    }

    // pointermove
    {
        let container_clone = container.clone();
        let state_clone = state.clone();
        let property = property_name.clone();
        let on_pointer_move =
            Closure::wrap(Box::new(move |event: PointerEvent| {
                if !state_clone.borrow().dragging {
                    return;
                }
                let client_width = container_clone.client_width() as f64;
                if client_width <= 0.0 {
                    return;
                }
                let delta_x = event.client_x() as f64
                    - state_clone.borrow().start_x;
                let delta_ratio = delta_x / client_width;
                let new_ratio = match position {
                    ResizerPosition::Right => {
                        state_clone.borrow().start_ratio - delta_ratio
                    }
                    _ => state_clone.borrow().start_ratio + delta_ratio,
                };
                let clamped = clamp_ratio(new_ratio, min_ratio, max_ratio);
                let _ = container_clone.style().set_property(
                    &property,
                    &format!("{:.2}%", clamped * 100.0),
                );
            }) as Box<dyn FnMut(PointerEvent)>);
        resizer.add_event_listener_with_callback(
            "pointermove",
            on_pointer_move.as_ref().unchecked_ref(),
        )?;
        on_pointer_move.forget();
    }

    // pointerup / pointercancel
    {
        let resizer_clone = resizer.clone();
        let state_clone = state.clone();
        let container_clone = container.clone();
        let property = property_name.clone();
        let save_key_clone = save_key.clone();
        let on_pointer_end =
            Closure::wrap(Box::new(move |event: PointerEvent| {
                if !state_clone.borrow().dragging {
                    return;
                }
                state_clone.borrow_mut().dragging = false;
                let _ = resizer_clone.release_pointer_capture(event.pointer_id());
                let _ = resizer_clone
                    .class_list()
                    .remove_1("resizer-dragging");
                if let Some(document) = web_sys::window().and_then(|w| w.document()) {
                    if let Some(body) = document.body() {
                        let _ = body.style().remove_property("user-select");
                    }
                }
                let current = container_clone
                    .style()
                    .get_property_value(&property)
                    .unwrap_or_default();
                let ratio = parse_ratio(&current);
                if ratio > 0.0 {
                    let key = save_key_clone.clone();
                    wasm_bindgen_futures::spawn_local(async move {
                        layout_store::save_panel_ratio(&key, ratio).await;
                    });
                }
            }) as Box<dyn FnMut(PointerEvent)>);
        for event_name in &["pointerup", "pointercancel"] {
            resizer.add_event_listener_with_callback(
                event_name,
                on_pointer_end.as_ref().unchecked_ref(),
            )?;
        }
        on_pointer_end.forget();
    }

    // Element として返す（呼び出し側で動的型に変換可能）
    Ok(Element::from(resizer))
}

struct DragState {
    start_x: f64,
    start_ratio: f64,
    dragging: bool,
}
