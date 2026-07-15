use wasm_bindgen::{JsCast, JsValue};
use web_sys::{Document, HtmlTextAreaElement};

use super::{memo, summary, State};

pub fn all(document: &Document, state: &State) -> Result<(), JsValue> {
    projects(document, state)?;
    episodes(document, state)?;
    if let Some(title) = document.get_element_by_id("toolbar-project-name") {
        title.set_text_content(Some(
            state
                .current_project
                .as_ref()
                .map(|project| project.title.as_str())
                .unwrap_or("プロジェクト未選択"),
        ));
        if let Some(project) = &state.current_project {
            title.set_attribute(
                "title",
                &format!(
                    "作成: {} / 更新: {}",
                    project.created_at, project.updated_at
                ),
            )?;
        }
    }
    set_textarea(
        document,
        "editor",
        &state.editor_text,
        state.current_project.is_none(),
    )?;
    set_textarea(
        document,
        "episode-summary",
        &summary(state),
        state.current_episode_id.is_none(),
    )?;
    set_textarea(
        document,
        "episode-memo",
        &memo(state),
        state.current_episode_id.is_none(),
    )?;
    Ok(())
}

pub fn projects(document: &Document, state: &State) -> Result<(), JsValue> {
    if let Some(list) = document.get_element_by_id("project-list") {
        let html = state.projects.iter().map(|project| format!(r#"<div class="project-list-item" title="更新: {updated}"><button data-action="open-project" data-id="{id}" class="project-list-title">{title}</button><button data-action="delete-project" data-id="{id}" class="project-list-delete">削除</button></div>"#, id=escape(&project.id), title=escape(&project.title), updated=escape(&project.updated_at))).collect::<String>();
        list.set_inner_html(&html);
    }
    Ok(())
}

fn episodes(document: &Document, state: &State) -> Result<(), JsValue> {
    if let Some(list) = document.get_element_by_id("episode-list") {
        let html = state.episodes.iter().map(|episode| { let active = if state.current_episode_id.as_deref() == Some(&episode.id) { " active" } else { "" }; format!(r#"<div class="nav-episode-item{active}" data-order="{order}"><button data-action="select-episode" data-id="{id}" class="nav-episode-title">{title}</button><button data-action="move-episode-up" data-id="{id}" title="上へ">↑</button><button data-action="move-episode-down" data-id="{id}" title="下へ">↓</button><button data-action="rename-episode" data-id="{id}" title="名前変更">✎</button><button data-action="delete-episode" data-id="{id}" title="削除">×</button></div>"#, id=escape(&episode.id), title=escape(&episode.title), order=episode.order) }).collect::<String>();
        list.set_inner_html(&html);
    }
    Ok(())
}

fn set_textarea(document: &Document, id: &str, value: &str, disabled: bool) -> Result<(), JsValue> {
    if let Some(textarea) = document
        .get_element_by_id(id)
        .and_then(|element| element.dyn_into::<HtmlTextAreaElement>().ok())
    {
        if document
            .active_element()
            .as_ref()
            .map(|element| element.id())
            != Some(id.into())
        {
            textarea.set_value(value);
        }
        textarea.set_disabled(disabled);
    }
    Ok(())
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
