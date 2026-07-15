use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use js_sys::{Object, Reflect};
use serde_json::{json, Value};
use wasm_bindgen::{closure::Closure, JsCast, JsValue};
use web_sys::{Document, Element, Event};

use crate::runtime::tauri;

use super::{
    render,
    types::{set_string, string, SettingsState},
};

pub fn bind(
    document: &Document,
    container: &Element,
    state: Rc<RefCell<SettingsState>>,
) -> Result<(), JsValue> {
    bind_clicks(document, container, Rc::clone(&state))?;
    bind_inputs(document, container, state)?;
    Ok(())
}

fn bind_clicks(
    document: &Document,
    container: &Element,
    state: Rc<RefCell<SettingsState>>,
) -> Result<(), JsValue> {
    let document = document.clone();
    let on_click = Closure::wrap(Box::new(move |event: Event| {
        let Some(target) = event
            .target()
            .and_then(|target| target.dyn_into::<Element>().ok())
        else {
            return;
        };
        let Some(action) = target.get_attribute("data-action") else {
            return;
        };
        match action.as_str() {
            "create-character" => {
                if let Some(name) = prompt("キャラクター名を入力してください") {
                    emit_string("settings-create-character", "name", &name);
                }
            }
            "create-world" => {
                if let Some(name) = prompt("世界観の名前を入力してください") {
                    let category = prompt("カテゴリ（場所・時代・制度 など）").unwrap_or_default();
                    let payload = Object::new();
                    let _ = Reflect::set(&payload, &"name".into(), &name.into());
                    let _ = Reflect::set(&payload, &"category".into(), &category.into());
                    tauri::emit("settings-create-world", &payload);
                }
            }
            "select-character" => emit_target_id(&target, "settings-select-character"),
            "select-world" => emit_target_id(&target, "settings-select-world"),
            "delete-character" => delete_entity(&target, &state, true),
            "delete-world" => delete_entity(&target, &state, false),
            "add-custom" | "delete-custom" => {
                let entity = target.get_attribute("data-entity").unwrap_or_default();
                let mut state_ref = state.borrow_mut();
                let Some(item) = current_entity_mut(&mut state_ref, &entity) else {
                    return;
                };
                let fields = item
                    .as_object_mut()
                    .and_then(|object| object.get_mut("customFields"))
                    .and_then(Value::as_array_mut);
                if action == "add-custom" {
                    if fields.is_none() {
                        item.as_object_mut().map(|object| {
                            object.insert("customFields".to_owned(), Value::Array(Vec::new()))
                        });
                    }
                    item.get_mut("customFields")
                        .and_then(Value::as_array_mut)
                        .map(|fields| fields.push(json!({ "label": "", "value": "" })));
                } else if let (Some(fields), Some(index)) = (
                    fields,
                    target
                        .get_attribute("data-index")
                        .and_then(|index| index.parse::<usize>().ok()),
                ) {
                    if index < fields.len() {
                        fields.remove(index);
                    }
                }
                let value = item.clone();
                drop(state_ref);
                emit_entity(&entity, &value);
                let _ = render::render(&document, &state.borrow());
            }
            "add-relationship" => {
                add_relationship(&mut state.borrow_mut());
                emit_relationships(&state.borrow().relationships_map);
                let _ = render::render(&document, &state.borrow());
            }
            "delete-relationship" => {
                if let Some(index) = target
                    .get_attribute("data-index")
                    .and_then(|index| index.parse::<usize>().ok())
                {
                    delete_relationship(&mut state.borrow_mut(), index);
                    emit_relationships(&state.borrow().relationships_map);
                    let _ = render::render(&document, &state.borrow());
                }
            }
            _ => {}
        }
    }) as Box<dyn FnMut(Event)>);
    container.add_event_listener_with_callback("click", on_click.as_ref().unchecked_ref())?;
    on_click.forget();
    Ok(())
}

fn bind_inputs(
    document: &Document,
    container: &Element,
    state: Rc<RefCell<SettingsState>>,
) -> Result<(), JsValue> {
    let timeout = Rc::new(Cell::new(None::<i32>));
    let document = document.clone();
    let handler = Closure::wrap(Box::new(move |event: Event| {
        let Some(target) = event
            .target()
            .and_then(|target| target.dyn_into::<Element>().ok())
        else {
            return;
        };
        let value = render::target_value(&target).unwrap_or_default();
        if target.id() == "relationship-episode-select" {
            state.borrow_mut().relationship_episode_id = value;
            let _ = render::render(&document, &state.borrow());
            return;
        }
        if let Some(index) = target
            .get_attribute("data-rel-index")
            .and_then(|index| index.parse::<usize>().ok())
        {
            if let Some(field) = target.get_attribute("data-rel-field") {
                update_relationship(&mut state.borrow_mut(), index, &field, value);
                schedule(
                    Rc::clone(&timeout),
                    "settings-update-relationships",
                    "map",
                    state.borrow().relationships_map.clone(),
                );
            }
            return;
        }
        let Some(entity) = target.get_attribute("data-entity") else {
            return;
        };
        let mut state_ref = state.borrow_mut();
        let Some(item) = current_entity_mut(&mut state_ref, &entity) else {
            return;
        };
        if let (Some(index), Some(part)) = (
            target
                .get_attribute("data-custom-index")
                .and_then(|index| index.parse::<usize>().ok()),
            target.get_attribute("data-custom-part"),
        ) {
            if let Some(field) = item
                .get_mut("customFields")
                .and_then(Value::as_array_mut)
                .and_then(|fields| fields.get_mut(index))
            {
                set_string(field, &part, value);
            }
        } else if let Some(field) = target.get_attribute("data-field") {
            set_string(item, &field, value);
        }
        let item = item.clone();
        drop(state_ref);
        let (event, key) = if entity == "character" {
            ("settings-update-character", "character")
        } else {
            ("settings-update-world", "entry")
        };
        schedule(Rc::clone(&timeout), event, key, item);
    }) as Box<dyn FnMut(Event)>);
    container.add_event_listener_with_callback("input", handler.as_ref().unchecked_ref())?;
    container.add_event_listener_with_callback("change", handler.as_ref().unchecked_ref())?;
    handler.forget();
    Ok(())
}

fn current_entity_mut<'a>(state: &'a mut SettingsState, entity: &str) -> Option<&'a mut Value> {
    let id = if entity == "character" {
        state.current_character_id.clone()
    } else {
        state.current_world_entry_id.clone()
    }?;
    let items = if entity == "character" {
        &mut state.characters
    } else {
        &mut state.world_entries
    };
    items.iter_mut().find(|item| string(item, "id") == id)
}

fn relationship_group_mut(state: &mut SettingsState) -> Option<&mut Value> {
    let groups = state
        .relationships_map
        .as_object_mut()?
        .get_mut("groups")?
        .as_array_mut()?;
    let episode_id = state.relationship_episode_id.clone();
    if let Some(index) = groups
        .iter()
        .position(|group| string(group, "episodeId") == episode_id)
    {
        return groups.get_mut(index);
    }
    groups.push(json!({ "episodeId": episode_id, "relationships": [] }));
    groups.last_mut()
}

fn add_relationship(state: &mut SettingsState) {
    if !state.relationships_map.is_object() {
        state.relationships_map = json!({ "groups": [] });
    }
    if state
        .relationships_map
        .get("groups")
        .and_then(Value::as_array)
        .is_none()
    {
        state.relationships_map["groups"] = Value::Array(Vec::new());
    }
    if let Some(relationships) = relationship_group_mut(state)
        .and_then(|group| group.get_mut("relationships"))
        .and_then(Value::as_array_mut)
    {
        relationships.push(json!({
            "id": tauri::random_uuid(),
            "characterAId": "",
            "characterBId": "",
            "direction": "mutual",
            "description": ""
        }));
    }
}

fn update_relationship(state: &mut SettingsState, index: usize, field: &str, value: String) {
    if let Some(relationship) = relationship_group_mut(state)
        .and_then(|group| group.get_mut("relationships"))
        .and_then(Value::as_array_mut)
        .and_then(|relationships| relationships.get_mut(index))
    {
        set_string(relationship, field, value);
    }
}

fn delete_relationship(state: &mut SettingsState, index: usize) {
    if let Some(relationships) = relationship_group_mut(state)
        .and_then(|group| group.get_mut("relationships"))
        .and_then(Value::as_array_mut)
    {
        if index < relationships.len() {
            relationships.remove(index);
        }
    }
}

fn delete_entity(target: &Element, state: &Rc<RefCell<SettingsState>>, character: bool) {
    let Some(id) = target.get_attribute("data-id") else {
        return;
    };
    let state_ref = state.borrow();
    let items = if character {
        &state_ref.characters
    } else {
        &state_ref.world_entries
    };
    let name = items
        .iter()
        .find(|item| string(item, "id") == id)
        .map(|item| string(item, "name"))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "（無題）".to_owned());
    let confirmed = web_sys::window()
        .and_then(|window| {
            window
                .confirm_with_message(&format!("「{name}」を削除しますか？"))
                .ok()
        })
        .unwrap_or(false);
    if confirmed {
        emit_string(
            if character {
                "settings-delete-character"
            } else {
                "settings-delete-world"
            },
            "id",
            &id,
        );
    }
}

fn prompt(message: &str) -> Option<String> {
    web_sys::window()?
        .prompt_with_message(message)
        .ok()
        .flatten()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn emit_target_id(target: &Element, event: &str) {
    if let Some(id) = target.get_attribute("data-id") {
        emit_string(event, "id", &id);
    }
}

fn emit_string(event: &str, key: &str, value: &str) {
    let payload = Object::new();
    let _ = Reflect::set(&payload, &key.into(), &value.into());
    tauri::emit(event, &payload);
}

fn emit_entity(entity: &str, value: &Value) {
    let (event, key) = if entity == "character" {
        ("settings-update-character", "character")
    } else {
        ("settings-update-world", "entry")
    };
    emit_value(event, key, value);
}

fn emit_relationships(value: &Value) {
    emit_value("settings-update-relationships", "map", value);
}

fn emit_value(event: &str, key: &str, value: &Value) {
    let Ok(value) = serde_wasm_bindgen::to_value(value) else {
        return;
    };
    let payload = Object::new();
    let _ = Reflect::set(&payload, &key.into(), &value);
    tauri::emit(event, &payload);
}

fn schedule(timeout: Rc<Cell<Option<i32>>>, event: &'static str, key: &'static str, value: Value) {
    let Some(window) = web_sys::window() else {
        return;
    };
    if let Some(timeout_id) = timeout.take() {
        window.clear_timeout_with_handle(timeout_id);
    }
    let callback = Closure::once_into_js(move || emit_value(event, key, &value));
    if let Ok(timeout_id) =
        window.set_timeout_with_callback_and_timeout_and_arguments_0(callback.unchecked_ref(), 400)
    {
        timeout.set(Some(timeout_id));
    }
}
