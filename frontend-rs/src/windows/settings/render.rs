use serde_json::Value;
use web_sys::{Document, Element};

use super::types::{string, SettingsState};

const CHARACTER_SECTIONS: &[(&str, &[(&str, &str, bool)])] = &[
    (
        "基本情報",
        &[
            ("name", "名前", false),
            ("reading", "よみがな", false),
            ("alias", "別名・あだ名", false),
            ("role", "役職・役割", false),
            ("gender", "性別", false),
            ("age", "年齢", false),
            ("birthday", "誕生日", false),
            ("bloodType", "血液型", false),
            ("height", "身長", false),
            ("weight", "体重", false),
        ],
    ),
    (
        "性格・外見",
        &[
            ("appearance", "見た目", true),
            ("personality", "性格", true),
            ("individuality", "個性", true),
        ],
    ),
    (
        "能力・経歴",
        &[
            ("skills", "能力・スキル", true),
            ("specialSkills", "特技", true),
            ("upbringing", "生い立ち", true),
            ("background", "背景", true),
        ],
    ),
    ("その他", &[("notes", "メモ", true)]),
];

const WORLD_SECTIONS: &[(&str, &[(&str, &str, bool)])] = &[
    (
        "基本情報",
        &[("name", "名前", false), ("category", "カテゴリ", false)],
    ),
    (
        "自然・社会",
        &[
            ("era", "時代", false),
            ("geography", "地理・場所", true),
            ("climate", "気候", false),
            ("population", "人口", false),
        ],
    ),
    (
        "制度・勢力",
        &[
            ("politics", "政治", true),
            ("laws", "法律", true),
            ("economy", "経済", true),
            ("military", "軍事", true),
            ("religion", "宗教", true),
            ("language", "言語", true),
        ],
    ),
    (
        "文化・歴史",
        &[
            ("culture", "文化", true),
            ("history", "歴史", true),
            ("technology", "技術・魔術体系", true),
        ],
    ),
    ("その他", &[("notes", "メモ", true)]),
];

pub fn render(document: &Document, state: &SettingsState) -> Result<(), wasm_bindgen::JsValue> {
    let panel = document
        .query_selector("#settings-container")?
        .ok_or_else(|| wasm_bindgen::JsValue::from_str("settings container is missing"))?;
    let html = match state.view.as_str() {
        "characters" => render_entity_view(
            &state.characters,
            state.current_character_id.as_deref(),
            "character",
            "＋ 新しいキャラクター",
            "キャラクターを選択または作成してください",
            CHARACTER_SECTIONS,
        ),
        "world" => render_entity_view(
            &state.world_entries,
            state.current_world_entry_id.as_deref(),
            "world",
            "＋ 新しい世界観",
            "世界観を選択または作成してください",
            WORLD_SECTIONS,
        ),
        "relationships" => render_relationships(state),
        _ => String::new(),
    };
    panel.set_inner_html(&html);
    Ok(())
}

pub fn update_tabs(document: &Document, view: &str) -> Result<(), wasm_bindgen::JsValue> {
    for (id, name) in [
        ("#tab-characters", "characters"),
        ("#tab-world", "world"),
        ("#tab-relationships", "relationships"),
    ] {
        if let Some(tab) = document.query_selector(id)? {
            let _ = tab.class_list().toggle_with_force("active", view == name);
        }
    }
    Ok(())
}

fn render_entity_view(
    items: &[Value],
    current_id: Option<&str>,
    entity: &str,
    add_label: &str,
    empty_label: &str,
    sections: &[(&str, &[(&str, &str, bool)])],
) -> String {
    let list = items
        .iter()
        .map(|item| {
            let id = string(item, "id");
            let name = string(item, "name");
            let active = if current_id == Some(&id) { " active" } else { "" };
            format!(
                r#"<div class="settings-list-item{active}">
                  <button type="button" class="settings-list-name" data-action="select-{entity}" data-id="{id}">{name}</button>
                  <button type="button" class="settings-list-delete" data-action="delete-{entity}" data-id="{id}" title="削除">×</button>
                </div>"#,
                id = escape_html(&id),
                name = escape_html(if name.is_empty() { "（無題）" } else { &name }),
            )
        })
        .collect::<Vec<_>>()
        .join("");
    let selected = current_id.and_then(|id| items.iter().find(|item| string(item, "id") == id));
    let detail = selected
        .map(|item| render_entity_form(item, entity, sections))
        .unwrap_or_else(|| format!(r#"<div class="settings-empty">{empty_label}</div>"#));
    format!(
        r#"<div class="settings-editor">
          <div class="settings-editor-sidebar">
            <button type="button" class="settings-add-button" data-action="create-{entity}">{add_label}</button>
            <div class="settings-list">{list}</div>
          </div>
          <div class="settings-editor-detail">{detail}</div>
        </div>"#
    )
}

fn render_entity_form(
    item: &Value,
    entity: &str,
    sections: &[(&str, &[(&str, &str, bool)])],
) -> String {
    let mut html = String::from(r#"<div class="settings-detail-form">"#);
    for (title, fields) in sections {
        html.push_str(&format!(
            r#"<div class="settings-section"><h4 class="settings-section-title">{}</h4>"#,
            escape_html(title)
        ));
        for (key, label, multiline) in *fields {
            let value = escape_html(&string(item, key));
            let control = if *multiline {
                format!(r#"<textarea data-entity="{entity}" data-field="{key}">{value}</textarea>"#)
            } else {
                format!(
                    r#"<input type="text" data-entity="{entity}" data-field="{key}" value="{value}">"#
                )
            };
            html.push_str(&format!(
                r#"<label class="settings-field"><span>{}</span>{control}</label>"#,
                escape_html(label)
            ));
        }
        html.push_str("</div>");
    }
    html.push_str(&render_custom_fields(item, entity));
    html.push_str("</div>");
    html
}

fn render_custom_fields(item: &Value, entity: &str) -> String {
    let rows = item
        .get("customFields")
        .and_then(Value::as_array)
        .map(|fields| {
            fields
                .iter()
                .enumerate()
                .map(|(index, field)| {
                    format!(
                        r#"<div class="custom-field-row">
                          <input type="text" class="custom-field-label" placeholder="項目名" data-entity="{entity}" data-custom-index="{index}" data-custom-part="label" value="{}">
                          <textarea class="custom-field-value" placeholder="内容" data-entity="{entity}" data-custom-index="{index}" data-custom-part="value">{}</textarea>
                          <button type="button" class="custom-field-delete" data-action="delete-custom" data-entity="{entity}" data-index="{index}" title="削除">×</button>
                        </div>"#,
                        escape_html(&string(field, "label")),
                        escape_html(&string(field, "value"))
                    )
                })
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    format!(
        r#"<div class="settings-section"><h4 class="settings-section-title">カスタム項目</h4>
          <div class="custom-fields">{rows}</div>
          <button type="button" class="custom-field-add" data-action="add-custom" data-entity="{entity}">＋ 項目を追加</button>
        </div>"#
    )
}

fn render_relationships(state: &SettingsState) -> String {
    let mut episodes = state.episodes.clone();
    episodes.sort_by_key(|episode| episode.get("order").and_then(Value::as_i64).unwrap_or(0));
    let episode_options = episodes
        .iter()
        .map(|episode| {
            let id = string(episode, "id");
            let selected = if id == state.relationship_episode_id {
                " selected"
            } else {
                ""
            };
            let title = string(episode, "title");
            format!(
                r#"<option value="{}"{selected}>{}</option>"#,
                escape_html(&id),
                escape_html(if title.is_empty() {
                    "（無題）"
                } else {
                    &title
                })
            )
        })
        .collect::<String>();
    let character_options = |selected_id: &str| {
        let mut options = String::from(r#"<option value="">選択...</option>"#);
        for character in &state.characters {
            let id = string(character, "id");
            let selected = if id == selected_id { " selected" } else { "" };
            let name = string(character, "name");
            options.push_str(&format!(
                r#"<option value="{}"{selected}>{}</option>"#,
                escape_html(&id),
                escape_html(if name.is_empty() {
                    "（無題）"
                } else {
                    &name
                })
            ));
        }
        options
    };
    let relationships = state
        .relationships_map
        .get("groups")
        .and_then(Value::as_array)
        .and_then(|groups| {
            groups
                .iter()
                .find(|group| string(group, "episodeId") == state.relationship_episode_id)
        })
        .and_then(|group| group.get("relationships"))
        .and_then(Value::as_array);
    let rows = relationships
        .map(|relationships| {
            relationships
                .iter()
                .enumerate()
                .map(|(index, relationship)| {
                    let direction = string(relationship, "direction");
                    format!(
                        r#"<div class="relationship-row">
                          <span class="relationship-label">A</span>
                          <select class="relationship-character-select" data-rel-index="{index}" data-rel-field="characterAId">{}</select>
                          <select class="relationship-direction-select" data-rel-index="{index}" data-rel-field="direction">
                            <option value="a-to-b"{}>A → B</option><option value="b-to-a"{}>A ← B</option><option value="mutual"{}>A ↔ B</option>
                          </select>
                          <span class="relationship-label">B</span>
                          <select class="relationship-character-select" data-rel-index="{index}" data-rel-field="characterBId">{}</select>
                          <input type="text" class="relationship-description" placeholder="関係の説明" data-rel-index="{index}" data-rel-field="description" value="{}">
                          <button type="button" class="relationship-delete" data-action="delete-relationship" data-index="{index}" title="削除">×</button>
                        </div>"#,
                        character_options(&string(relationship, "characterAId")),
                        if direction == "a-to-b" { " selected" } else { "" },
                        if direction == "b-to-a" { " selected" } else { "" },
                        if direction == "mutual" { " selected" } else { "" },
                        character_options(&string(relationship, "characterBId")),
                        escape_html(&string(relationship, "description"))
                    )
                })
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    format!(
        r#"<div class="relationship-editor">
          <div class="relationship-editor-header"><h3>人間関係</h3>
            <select id="relationship-episode-select" class="relationship-episode-select">
              <option value="">全体（全話共通）</option>{episode_options}
            </select>
          </div>
          <div class="relationship-rows">{rows}</div>
          <button type="button" class="relationship-add-button" data-action="add-relationship">＋ 関係を追加</button>
        </div>"#
    )
}

pub fn target_value(target: &Element) -> Option<String> {
    ReflectValue::value(target)
}

struct ReflectValue;

impl ReflectValue {
    fn value(target: &Element) -> Option<String> {
        js_sys::Reflect::get(target, &"value".into())
            .ok()
            .and_then(|value| value.as_string())
    }
}

pub fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
