use serde::Deserialize;
use serde_json::Value;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsState {
    pub view: String,
    #[serde(default)]
    pub characters: Vec<Value>,
    #[serde(default)]
    pub world_entries: Vec<Value>,
    #[serde(default)]
    pub episodes: Vec<Value>,
    #[serde(default)]
    pub relationships_map: Value,
    pub current_character_id: Option<String>,
    pub current_world_entry_id: Option<String>,
    #[serde(skip)]
    pub relationship_episode_id: String,
}

pub fn string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

pub fn set_string(value: &mut Value, key: &str, content: String) {
    if let Some(object) = value.as_object_mut() {
        object.insert(key.to_owned(), Value::String(content));
    }
}
