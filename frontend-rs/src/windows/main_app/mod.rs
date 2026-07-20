mod agent_tools;
mod ai_actions;
mod events;
mod generation;
mod imports;
mod prompt_context;
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
    runtime::{invoke, tauri},
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
    /// チャット送信の同時実行防止ガード（TS版 `chatMessageInFlight` 相当）
    chat_in_flight: bool,
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

const CHAT_DOCUMENT_VERSION: u8 = 2;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatMessage {
    role: String,
    content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thinking: Option<String>,
    /// チャット文脈に含めない（表示だけする）中間メッセージか
    #[serde(
        default,
        alias = "exclude_from_context",
        skip_serializing_if = "std::ops::Not::not"
    )]
    exclude_from_context: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(default, alias = "created_at", skip_serializing_if = "Option::is_none")]
    created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    transport: Option<ChatTransportMetadata>,
}

/// TypeScript版 `loadChat` と同じく、旧配列形式と schemaVersion 2 の文書形式を読む。
/// 壊れた1件のために履歴全体を捨てず、妥当な user/assistant メッセージだけを残す。
fn parse_chat_document(value: Value) -> Vec<ChatMessage> {
    let messages = value
        .as_array()
        .or_else(|| value.get("messages").and_then(Value::as_array));
    if let Some(messages) = messages {
        return messages
            .iter()
            .filter_map(|message| serde_json::from_value::<ChatMessage>(message.clone()).ok())
            .filter(|message| matches!(message.role.as_str(), "user" | "assistant"))
            .collect();
    }

    // 一部のRust移植版が単一メッセージを文書そのものとして保存していた場合も救済する。
    serde_json::from_value::<ChatMessage>(value)
        .ok()
        .filter(|message| matches!(message.role.as_str(), "user" | "assistant"))
        .into_iter()
        .collect()
}

fn chat_document_value(messages: &[ChatMessage], updated_at: &str) -> Value {
    json!({
        "schemaVersion": CHAT_DOCUMENT_VERSION,
        "messages": messages,
        "session": { "updatedAt": updated_at },
    })
}

pub async fn mount(document: &Document) -> Result<(), JsValue> {
    tauri::listen_dpi_zoom();
    let state = Rc::new(RefCell::new(State {
        summaries: json!({"summaries":{}}),
        memos: json!({"memos":{}}),
        ..Default::default()
    }));
    state.borrow_mut().catalog = crate::runtime::ai::catalog().await.unwrap_or_default();
    // 多段執筆の各フラグはメイン状態から参照するため、設定画面を開く前にも読み込む。
    state.borrow_mut().ai_settings =
        crate::runtime::invoke::invoke("ai_settings_snapshot", &serde_json::json!({})).await?;
    // メインウィンドウの前回位置を復元
    let _ = crate::runtime::windows::apply_window_bounds_main("main").await;
    // TS版 createSyncOverlay 相当: WebDAV同期オーバーレイを事前作成（最初の同期前にDOM要素を用意）
    settings::integrations::create_sync_overlay(document);
    // TS版と同様、pull を開始する前に進捗イベントを購読する。
    if let Err(error) = settings::integrations::listen_progress(document).await {
        web_sys::console::error_1(
            &format!("[litra] failed to subscribe sync progress: {error:?}").into(),
        );
    }
    settings::integrations::pull_on_start(document).await?;
    if let Ok((provider, model)) = crate::runtime::ai::selection("chat").await {
        let mut current = state.borrow_mut();
        current.selected_provider = Some(provider);
        current.selected_model = Some(model);
    }
    refresh_projects(document, &state).await?;
    // TS版 migrate_legacy_app_data 相当
    let _ = crate::runtime::invoke::invoke::<_, serde_json::Value>(
        "migrate_legacy_app_data",
        &serde_json::json!({}),
    )
    .await;
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
    // TS版 loadInitialProject 相当: 最初のプロジェクトを自動読み込み
    if let Some(first) = state.borrow().projects.first().cloned() {
        let document = document.clone();
        let state = Rc::clone(&state);
        wasm_bindgen_futures::spawn_local(async move {
            let _ = open_project(&document, &state, first.id.clone()).await;
        });
    }
    result
}

/// リサイズ可能なパネルを初期化する。
/// 旧TS版と同じ実装: resizer は `.main` コンテナに追加し、
/// CSS の `position: absolute; left: var(--xxx-width)` で配置する。
/// （子要素として追加すると、`.project-nav` 等が `position: relative`
/// を持たないため absolute 配置が効かない）
fn bind_resizable_panels(document: &Document) -> Result<(), JsValue> {
    use crate::data::layout_store;
    use crate::ui::resizable::{
        apply_stored_ratio, create_vertical_resizer, ResizerConfig, ResizerPosition,
    };
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
fn bind_selection_tracking(document: &Document, state: Rc<RefCell<State>>) -> Result<(), JsValue> {
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
            textarea
                .add_event_listener_with_callback(event_name, on_change.as_ref().unchecked_ref())?;
        }
        on_change.forget();
    }
    Ok(())
}
async fn bind_close_sync(state: Rc<RefCell<State>>) -> Result<(), JsValue> {
    let callback = Closure::wrap(Box::new(move || {
        let (editor, summaries, memos) = {
            let current = state.borrow();
            let editor = current.current_project.as_ref().and_then(|project| {
                let episode_id = current.current_episode_id.as_ref()?;
                let file_name = current
                    .episodes
                    .iter()
                    .find(|episode| &episode.id == episode_id)?
                    .file_name
                    .clone();
                Some((project.id.clone(), file_name, current.editor_text.clone()))
            });
            (editor, current.summaries.clone(), current.memos.clone())
        };
        future_to_promise(async move {
            MAIN_CLOSING.store(true, Ordering::SeqCst);
            // TS版 flushPendingAutosave 相当: エディタ本文 + 要約 + メモを確定保存
            if let Some((project_id, file_name, content)) = editor {
                projects::write_episode(&project_id, &file_name, &content).await?;
                projects::write_document(&project_id, "summaries", &summaries).await?;
                projects::write_document(&project_id, "memos", &memos).await?;
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
    crate::ai::cache_observability::set_ai_cache_project(Some(project_id.clone()));
    let episodes = projects::list_episodes(&project_id).await?;
    let summaries = projects::read_document(&project_id, "summaries")
        .await?
        .unwrap_or_else(|| json!({"summaries":{}}));
    let memos = projects::read_document(&project_id, "memos")
        .await?
        .unwrap_or_else(|| json!({"memos":{}}));
    let chat = projects::read_document(&project_id, "chat")
        .await?
        .map(parse_chat_document)
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
    settings::integrations::set_project_name(Some(project.title.clone()));
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
    // TS版と同様、プロジェクト読み込み後に検索インデックスを再構築する
    let _: Result<serde_json::Value, _> =
        invoke::invoke("rebuild_search_index", &json!({"projectId": project_id})).await;
    Ok(())
}

async fn select_episode(
    document: &Document,
    state: &Rc<RefCell<State>>,
    episode_id: String,
) -> Result<(), JsValue> {
    // E-3: 切り替え前に現在のエピソードの本文・要約・メモを保存する
    {
        let save_data = {
            let current = state.borrow();
            match (&current.current_project, &current.current_episode_id) {
                (Some(project), Some(current_ep_id)) if current_ep_id != &episode_id => {
                    let file_name = current
                        .episodes
                        .iter()
                        .find(|ep| &ep.id == current_ep_id)
                        .map(|ep| ep.file_name.clone());
                    Some((
                        project.id.clone(),
                        file_name,
                        current.editor_text.clone(),
                        current.summaries.clone(),
                        current.memos.clone(),
                    ))
                }
                _ => None,
            }
        };
        if let Some((project_id, file_name, editor_text, summaries, memos)) = save_data {
            if let Some(file_name) = file_name {
                let _ = projects::write_episode(&project_id, &file_name, &editor_text).await;
            }
            let _ = projects::write_document(&project_id, "summaries", &summaries).await;
            let _ = projects::write_document(&project_id, "memos", &memos).await;
        }
    }

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
    sync_summary(state);
    sync_memo(state);
    sync_settings(state);
    sync_project_memos(state);
    sync_chat(state);
    sync_chat_settings(state);
}

fn sync_child(label: &str, state: &State) {
    match label {
        "summary" => sync_summary(state),
        "memo" => sync_memo(state),
        "settings" => sync_settings(state),
        "project-memos" => sync_project_memos(state),
        "chat" => {
            sync_chat(state);
            sync_chat_settings(state);
        }
        _ => {}
    }
}

fn sync_summary(state: &State) {
    let episode_id = state.current_episode_id.clone();
    let summary_payload =
        serde_wasm_bindgen::to_value(&json!({"episodeId":episode_id,"content":summary(state)}))
            .unwrap_or_default();
    tauri::emit("summary-sync", &summary_payload);
}

fn sync_memo(state: &State) {
    let memo_payload = serde_wasm_bindgen::to_value(
        &json!({"episodeId":state.current_episode_id,"content":memo(state)}),
    )
    .unwrap_or_default();
    tauri::emit("memo-sync", &memo_payload);
}

fn sync_settings(state: &State) {
    let settings = json!({"view": if state.current_view.is_empty() || state.current_view == "episode" { "characters" } else { &state.current_view }, "characters":state.characters, "worldEntries":state.world_entries, "episodes":state.episodes, "relationshipsMap":state.relationships, "currentCharacterId":state.current_character_id, "currentWorldEntryId":state.current_world_entry_id});
    if let Ok(payload) = serde_wasm_bindgen::to_value(&settings) {
        tauri::emit("settings-sync", &payload);
    }
}

fn sync_project_memos(state: &State) {
    let memos = json!({"memos":state.project_memos,"currentMemoId":state.current_memo_id});
    if let Ok(payload) = serde_wasm_bindgen::to_value(&memos) {
        tauri::emit("project-memos-sync", &payload);
    }
}

fn sync_chat(state: &State) {
    let chat = json!({"messages":state.chat,"isGenerating":state.is_generating,"directWritingEnabled":state.direct_writing});
    if let Ok(payload) = serde_wasm_bindgen::to_value(&chat) {
        tauri::emit("chat-sync", &payload);
    }
}

fn sync_chat_settings(state: &State) {
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

#[cfg(test)]
mod chat_document_tests {
    use super::{chat_document_value, parse_chat_document, ChatMessage};
    use serde_json::json;

    #[test]
    fn reads_typescript_v2_document_and_skips_only_invalid_messages() {
        let messages = parse_chat_document(json!({
            "schemaVersion": 2,
            "messages": [
                {"role":"user", "content":"質問"},
                {"role":"system", "content":"除外"},
                {"role":"assistant", "content":"回答", "excludeFromContext":true},
                {"role":"assistant", "content":42}
            ],
            "session": {"updatedAt":"2026-01-01T00:00:00.000Z"}
        }));

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].content, "質問");
        assert!(!messages[0].exclude_from_context);
        assert!(messages[1].exclude_from_context);
    }

    #[test]
    fn reads_interim_rust_array_and_writes_typescript_v2_format() {
        let messages = parse_chat_document(json!([{
            "role":"assistant",
            "content":"保存済み",
            "exclude_from_context":true,
            "created_at":"2026-01-01T00:00:00.000Z"
        }]));
        let document = chat_document_value(&messages, "2026-02-01T00:00:00.000Z");

        assert_eq!(document["schemaVersion"], 2);
        assert_eq!(document["messages"][0]["excludeFromContext"], true);
        assert_eq!(
            document["messages"][0]["createdAt"],
            "2026-01-01T00:00:00.000Z"
        );
        assert!(document["messages"][0]
            .get("exclude_from_context")
            .is_none());
    }

    #[test]
    fn empty_chat_serializes_as_a_versioned_document() {
        let document = chat_document_value(&Vec::<ChatMessage>::new(), "now");
        assert_eq!(document["messages"], json!([]));
        assert_eq!(document["session"]["updatedAt"], "now");
    }

    #[test]
    fn recovers_a_single_message_document_written_by_the_interim_port() {
        let messages = parse_chat_document(json!({
            "role":"user",
            "content":"単一メッセージ"
        }));
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content, "単一メッセージ");
    }
}
