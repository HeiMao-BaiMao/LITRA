mod agent_tools;
mod ai_actions;
mod events;
mod generation;
mod imports;
mod render;
mod settings;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::HashSet,
    rc::Rc,
    sync::atomic::{AtomicBool, Ordering},
};
use wasm_bindgen::{closure::Closure, JsValue};
use wasm_bindgen_futures::future_to_promise;
use web_sys::Document;

use crate::{
    data::{
        project_settings,
        projects::{self, Episode, Project, ProjectSummary},
    },
    runtime::tauri,
};

#[derive(Default)]
struct State {
    projects: Vec<ProjectSummary>,
    current_project: Option<Project>,
    episodes: Vec<Episode>,
    current_episode_id: Option<String>,
    editor_text: String,
    /// テキストエリア内の選択範囲の開始位置（UTF-16 コード単位）
    selection_start: u32,
    /// テキストエリア内の選択範囲の終了位置（UTF-16 コード単位）
    selection_end: u32,
    summaries: Value,
    memos: Value,
    chat: Vec<ChatMessage>,
    is_generating: bool,
    catalog: Vec<crate::runtime::ai::CatalogProvider>,
    selected_provider: Option<String>,
    selected_model: Option<String>,
    characters: Vec<Value>,
    world_entries: Vec<Value>,
    relationships: Value,
    project_memos: Vec<Value>,
    current_character_id: Option<String>,
    current_world_entry_id: Option<String>,
    current_memo_id: Option<String>,
    current_view: String,
    ai_settings: Value,
    direct_writing: bool,
    import: imports::ImportState,
    memo_collapsed: bool,
    chat_collapsed: bool,
    memo_collapsed_before_detach: bool,
    chat_collapsed_before_detach: bool,
    detached: HashSet<String>,
    /// AI 生成を中断するための AbortController。None のとき未生成。
    abort_controller: Option<web_sys::AbortController>,
}

pub static MAIN_CLOSING: AtomicBool = AtomicBool::new(false);

/// AI 応答のトランスポート情報。
/// TypeScript `ChatTransportMetadata` に相当。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatTransportMetadata {
    provider: Option<String>,
    model: Option<String>,
    base_url: Option<String>,
    protocol: Option<String>,
    response_id: Option<String>,
    response_model_id: Option<String>,
    finish_reason: Option<String>,
    max_tokens: Option<u64>,
    max_context_tokens: Option<u64>,
    created_at: Option<String>,
    /// "chat" | "feedback" | "summary" | "continuation" | "rewrite"
    kind: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
struct ChatMessage {
    role: String,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<String>,
    /// チャット文脈に含めない（表示だけする）中間メッセージか
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    exclude_from_context: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    transport: Option<ChatTransportMetadata>,
}

pub async fn mount(document: &Document) -> Result<(), JsValue> {
    tauri::listen_dpi_zoom();
    let state = Rc::new(RefCell::new(State {
        summaries: json!({"summaries":{}}),
        memos: json!({"memos":{}}),
        ..Default::default()
    }));
    state.borrow_mut().catalog = crate::runtime::ai::catalog().await.unwrap_or_default();
    // メインウィンドウの前回位置を復元
    let _ = crate::runtime::windows::apply_window_bounds_main("main").await;
    settings::integrations::pull_on_start(document).await?;
    if let Ok((provider, model)) = crate::runtime::ai::selection("chat").await {
        let mut current = state.borrow_mut();
        current.selected_provider = Some(provider);
        current.selected_model = Some(model);
    }
    refresh_projects(document, &state).await?;
    events::bind(document, Rc::clone(&state))?;
    events::listen_children(document.clone(), Rc::clone(&state)).await?;
    crate::windows::settings::mount_inline(document).await?;
    bind_resizable_panels(document)?;
    bind_selection_tracking(document, Rc::clone(&state))?;
    bind_close_sync(Rc::clone(&state)).await?;
    let result = render::all(document, &state.borrow());
    events::restore_detached_windows(document, &state).await;
    // メインウィンドウの移動・リサイズを追跡開始
    let _ = crate::runtime::windows::track_window_bounds_main("main");
    result
}

/// リサイズ可能なパネルを初期化する。
/// 旧TS版と同じ実装: resizer は `.main` コンテナに追加し、
/// CSS の `position: absolute; left: var(--xxx-width)` で配置する。
/// （子要素として追加すると、`.project-nav` 等が `position: relative`
/// を持たないため absolute 配置が効かない）
fn bind_resizable_panels(document: &Document) -> Result<(), JsValue> {
    use crate::ui::resizable::{
        apply_stored_ratio, create_vertical_resizer, ResizerConfig, ResizerPosition,
    };
    use crate::data::layout_store;
    use wasm_bindgen::JsCast;

    // resizer を入れる親は `.main`（position: relative）
    let Ok(main_opt) = document.query_selector(".main") else {
        return Ok(());
    };
    let Some(main_el) = main_opt else {
        return Ok(());
    };
    let Ok(main) = main_el.dyn_into::<web_sys::HtmlElement>() else {
        return Ok(());
    };

    // プロジェクトナビゲーション（左サイドバー）
    apply_stored_ratio(
        main.clone(),
        "--project-nav-width",
        layout_store::PANEL_PROJECT_NAV,
        0.18,
    );
    let _ = create_vertical_resizer(
        document,
        ResizerConfig::new(
            main.clone(),
            "--project-nav-width",
            ResizerPosition::Left,
            layout_store::PANEL_PROJECT_NAV,
        ),
    )?;

    // チャットパネル（右サイドバー）
    apply_stored_ratio(
        main.clone(),
        "--chat-panel-width",
        layout_store::PANEL_CHAT_PANEL,
        0.25,
    );
    let _ = create_vertical_resizer(
        document,
        ResizerConfig::new(
            main.clone(),
            "--chat-panel-width",
            ResizerPosition::Right,
            layout_store::PANEL_CHAT_PANEL,
        ),
    )?;

    Ok(())
}

/// テキストエリアの選択範囲を state に追跡する。
/// `select` / `click` / `keyup` / `focus` イベントで selectionStart / selectionEnd を更新する。
fn bind_selection_tracking(
    document: &Document,
    state: Rc<RefCell<State>>,
) -> Result<(), JsValue> {
    use wasm_bindgen::JsCast;
    let element_ids = ["editor", "chat-input"];
    for id in element_ids {
        let Some(textarea_el) = document
            .get_element_by_id(id)
            .and_then(|el| el.dyn_into::<web_sys::HtmlTextAreaElement>().ok())
        else {
            continue;
        };
        let textarea = textarea_el.clone();
        let state_clone = Rc::clone(&state);
        let textarea_for_closure = textarea.clone();
        let on_change = Closure::wrap(Box::new(move |_event: web_sys::Event| {
            let start = textarea_for_closure
                .selection_start()
                .ok()
                .flatten()
                .unwrap_or(0);
            let end = textarea_for_closure
                .selection_end()
                .ok()
                .flatten()
                .unwrap_or(0);
            let mut current = state_clone.borrow_mut();
            current.selection_start = start;
            current.selection_end = end;
        }) as Box<dyn FnMut(web_sys::Event)>);
        for event_name in &["select", "click", "keyup", "focus"] {
            textarea.add_event_listener_with_callback(
                event_name,
                on_change.as_ref().unchecked_ref(),
            )?;
        }
        on_change.forget();
    }
    Ok(())
}
async fn bind_close_sync(state: Rc<RefCell<State>>) -> Result<(), JsValue> {
    let callback = Closure::wrap(Box::new(move || {
        let editor = {
            let current = state.borrow();
            current.current_project.as_ref().and_then(|project| {
                let episode_id = current.current_episode_id.as_ref()?;
                let file_name = current
                    .episodes
                    .iter()
                    .find(|episode| &episode.id == episode_id)?
                    .file_name
                    .clone();
                Some((project.id.clone(), file_name, current.editor_text.clone()))
            })
        };
        future_to_promise(async move {
            MAIN_CLOSING.store(true, Ordering::SeqCst);
            if let Some((project_id, file_name, content)) = editor {
                projects::write_episode(&project_id, &file_name, &content).await?;
            }
            settings::integrations::push_on_close().await?;
            let _ = crate::runtime::windows::destroy_other_windows("main").await;
            Ok(JsValue::UNDEFINED)
        })
    }) as Box<dyn FnMut() -> js_sys::Promise>);
    tauri::listen_close(callback).await
}

async fn refresh_projects(document: &Document, state: &Rc<RefCell<State>>) -> Result<(), JsValue> {
    state.borrow_mut().projects = projects::list().await?;
    render::projects(document, &state.borrow())
}

async fn open_project(
    document: &Document,
    state: &Rc<RefCell<State>>,
    project_id: String,
) -> Result<(), JsValue> {
    let project = projects::load(&project_id).await?;
    let episodes = projects::list_episodes(&project_id).await?;
    let summaries = projects::read_document(&project_id, "summaries")
        .await?
        .unwrap_or_else(|| json!({"summaries":{}}));
    let memos = projects::read_document(&project_id, "memos")
        .await?
        .unwrap_or_else(|| json!({"memos":{}}));
    let chat = projects::read_document(&project_id, "chat")
        .await?
        .and_then(|value| serde_json::from_value::<Vec<ChatMessage>>(value).ok())
        .unwrap_or_default();
    let characters_doc = project_settings::characters(&project_id).await?;
    let world_doc = project_settings::world(&project_id).await?;
    let relationships = projects::read_document(&project_id, "relationships")
        .await?
        .unwrap_or_else(|| json!({}));
    let project_memos = project_settings::memos(&project_id).await?;
    let current_id = episodes.first().map(|episode| episode.id.clone());
    let editor_text = match current_id
        .as_ref()
        .and_then(|id| episodes.iter().find(|episode| &episode.id == id))
    {
        Some(episode) => projects::read_episode(&project_id, &episode.file_name).await?,
        None => String::new(),
    };
    let mut current = state.borrow_mut();
    current.current_project = Some(project);
    current.episodes = episodes;
    current.current_episode_id = current_id;
    current.editor_text = editor_text;
    current.summaries = summaries;
    current.memos = memos;
    current.chat = chat;
    current.characters = characters_doc
        .get("characters")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    current.world_entries = world_doc
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    current.relationships = relationships;
    current.current_character_id = current
        .characters
        .first()
        .and_then(|item| item.get("id")?.as_str())
        .map(str::to_owned);
    current.current_world_entry_id = current
        .world_entries
        .first()
        .and_then(|item| item.get("id")?.as_str())
        .map(str::to_owned);
    current.project_memos = project_memos;
    current.current_memo_id = current
        .project_memos
        .first()
        .and_then(|item| item.get("id")?.as_str())
        .map(str::to_owned);
    current.current_view = "episode".into();
    render::all(document, &current)?;
    sync_children(&current);
    Ok(())
}

async fn select_episode(
    document: &Document,
    state: &Rc<RefCell<State>>,
    episode_id: String,
) -> Result<(), JsValue> {
    let (project_id, file_name) = {
        let current = state.borrow();
        let project_id = current
            .current_project
            .as_ref()
            .map(|project| project.id.clone())
            .ok_or_else(|| JsValue::from_str("project missing"))?;
        let file = current
            .episodes
            .iter()
            .find(|episode| episode.id == episode_id)
            .map(|episode| episode.file_name.clone())
            .ok_or_else(|| JsValue::from_str("episode missing"))?;
        (project_id, file)
    };
    let text = projects::read_episode(&project_id, &file_name).await?;
    let mut current = state.borrow_mut();
    current.current_episode_id = Some(episode_id);
    current.editor_text = text;
    render::all(document, &current)?;
    sync_children(&current);
    Ok(())
}

fn summary(state: &State) -> String {
    state
        .current_episode_id
        .as_ref()
        .and_then(|id| {
            state
                .summaries
                .get("summaries")?
                .get(id)?
                .get("content")?
                .as_str()
        })
        .unwrap_or_default()
        .into()
}
fn memo(state: &State) -> String {
    state
        .current_episode_id
        .as_ref()
        .and_then(|id| state.memos.get("memos")?.get(id)?.get("content")?.as_str())
        .unwrap_or_default()
        .into()
}

fn sync_children(state: &State) {
    let episode_id = state.current_episode_id.clone();
    let summary_payload =
        serde_wasm_bindgen::to_value(&json!({"episodeId":episode_id,"content":summary(state)}))
            .unwrap_or_default();
    tauri::emit("summary-sync", &summary_payload);
    let memo_payload = serde_wasm_bindgen::to_value(
        &json!({"episodeId":state.current_episode_id,"content":memo(state)}),
    )
    .unwrap_or_default();
    tauri::emit("memo-sync", &memo_payload);
    let settings = json!({"view": if state.current_view.is_empty() || state.current_view == "episode" { "characters" } else { &state.current_view }, "characters":state.characters, "worldEntries":state.world_entries, "episodes":state.episodes, "relationshipsMap":state.relationships, "currentCharacterId":state.current_character_id, "currentWorldEntryId":state.current_world_entry_id});
    if let Ok(payload) = serde_wasm_bindgen::to_value(&settings) {
        tauri::emit("settings-sync", &payload);
    }
    let memos = json!({"memos":state.project_memos,"currentMemoId":state.current_memo_id});
    if let Ok(payload) = serde_wasm_bindgen::to_value(&memos) {
        tauri::emit("project-memos-sync", &payload);
    }
    let chat = json!({"messages":state.chat,"isGenerating":state.is_generating,"directWritingEnabled":state.direct_writing});
    if let Ok(payload) = serde_wasm_bindgen::to_value(&chat) {
        tauri::emit("chat-sync", &payload);
    }
    let chat_settings = json!({"provider":state.selected_provider.as_deref().unwrap_or(""),"model":state.selected_model.as_deref().unwrap_or(""),"chatSubmitShortcut":state.ai_settings.get("chatSubmitShortcut").and_then(Value::as_str).unwrap_or("ctrlEnter"),"providerConfig":{"providers":state.catalog}});
    if let Ok(payload) = serde_wasm_bindgen::to_value(&chat_settings) {
        tauri::emit("chat-settings-sync", &payload);
    }
}

fn report(error: JsValue) {
    if let Some(window) = web_sys::window() {
        let _ = window.alert_with_message(&format!(
            "エラー: {}",
            error.as_string().unwrap_or_else(|| format!("{error:?}"))
        ));
    }
}
