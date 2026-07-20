mod events;
mod render;

use std::{cell::RefCell, rc::Rc};

use wasm_bindgen::JsValue;
use web_sys::Document;

use crate::{
    data::genres::{
        knowledge,
        models::{Genre, GenreIndexEntry, GenreSource, KnowledgeDocument},
        repository, sources,
    },
    runtime::tauri,
};

#[derive(Clone, Copy, PartialEq)]
enum Tab {
    Overview,
    Sources,
    Analysis,
    Knowledge,
}

struct State {
    genres: Vec<GenreIndexEntry>,
    current_genre_id: Option<String>,
    current_source_id: Option<String>,
    current_tab: Tab,
    genre: Option<Genre>,
    sources: Vec<GenreSource>,
    knowledge: Option<KnowledgeDocument>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            genres: Vec::new(),
            current_genre_id: None,
            current_source_id: None,
            current_tab: Tab::Overview,
            genre: None,
            sources: Vec::new(),
            knowledge: None,
        }
    }
}

pub async fn mount(document: &Document) -> Result<(), JsValue> {
    tauri::listen_dpi_zoom();
    let state = Rc::new(RefCell::new(State::default()));
    refresh_list(document, &state).await?;
    events::bind(document, Rc::clone(&state))?;
    events::listen_sync(document.clone(), Rc::clone(&state)).await?;
    bind_resizer(document)?;
    tauri::emit("genre-library-ready", &js_sys::Object::new());
    Ok(())
}

fn bind_resizer(document: &Document) -> Result<(), JsValue> {
    use crate::data::layout_store;
    use crate::ui::resizable::{
        apply_stored_ratio, create_vertical_resizer, ResizerConfig, ResizerPosition,
    };
    use wasm_bindgen::JsCast;

    let Some(el) = document
        .get_element_by_id("genre-library-main")
        .and_then(|el| el.dyn_into::<web_sys::HtmlElement>().ok())
    else {
        return Ok(());
    };
    apply_stored_ratio(
        el.clone(),
        "--genre-sidebar-width",
        layout_store::PANEL_GENRE_SIDEBAR,
        0.22,
    );
    let _ = create_vertical_resizer(
        document,
        ResizerConfig::new(
            el,
            "--genre-sidebar-width",
            ResizerPosition::Left,
            layout_store::PANEL_GENRE_SIDEBAR,
        ),
    )?;
    Ok(())
}

async fn refresh_list(document: &Document, state: &Rc<RefCell<State>>) -> Result<(), JsValue> {
    state.borrow_mut().genres = repository::list().await?;
    render::all(document, &state.borrow())
}

async fn select(
    document: &Document,
    state: &Rc<RefCell<State>>,
    genre_id: String,
) -> Result<(), JsValue> {
    let genre = repository::load(&genre_id).await?;
    let source_list = sources::list(&genre_id).await?;
    let knowledge_doc = knowledge::load(&genre_id).await?;
    let mut current = state.borrow_mut();
    current.current_genre_id = Some(genre_id);
    current.current_source_id = None;
    current.genre = Some(genre);
    current.sources = source_list;
    current.knowledge = Some(knowledge_doc);
    render::all(document, &current)
}

async fn refresh_current(document: &Document, state: &Rc<RefCell<State>>) -> Result<(), JsValue> {
    let Some(id) = state.borrow().current_genre_id.clone() else {
        return refresh_list(document, state).await;
    };
    let genre = repository::load(&id).await?;
    let source_list = sources::list(&id).await?;
    let knowledge_doc = knowledge::load(&id).await?;
    let genres = repository::list().await?;
    let mut current = state.borrow_mut();
    current.genres = genres;
    current.genre = Some(genre);
    current.sources = source_list;
    current.knowledge = Some(knowledge_doc);
    render::all(document, &current)
}

fn report_error(error: JsValue) {
    let message = error.as_string().unwrap_or_else(|| format!("{error:?}"));
    if let Some(window) = web_sys::window() {
        let _ = window.alert_with_message(&format!("エラー: {message}"));
    }
}
