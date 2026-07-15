mod ai;
mod codex_oauth;
mod genre_search;
mod genre_store;
mod genre_windows;
mod import;
mod project_memo;
mod project_store;
mod search;
mod secrets;
mod settings;
mod storage;
mod tools;
mod web_fetch;
mod web_search;
mod webdav_sync;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(ai::AiRequestRegistry::default())
        .manage(ai::oauth::copilot::CopilotOAuthCancelFlag::new())
        .manage(codex_oauth::OAuthCancelFlag::new())
        .invoke_handler(tauri::generate_handler![
            ai::ai_stream_text,
            ai::ai_cancel,
            ai::config::ai_runtime_config,
            ai::config::ai_provider_catalog,
            ai::models::ai_list_models,
            ai::oauth::copilot::start_copilot_device_auth,
            ai::oauth::copilot::cancel_copilot_device_auth,
            codex_oauth::start_codex_browser_auth,
            codex_oauth::cancel_codex_browser_auth,
            genre_search::rebuild_genre_search_index,
            genre_search::search_genre,
            genre_store::genre_read_text,
            genre_store::genre_write_text,
            genre_store::genre_list_path,
            genre_store::genre_remove_path,
            genre_store::genre_read_index,
            genre_store::genre_write_index,
            genre_store::genre_remove,
            genre_windows::open_genre_chat_window,
            import::import_files,
            project_memo::list_project_memos,
            project_memo::create_project_memo,
            project_memo::update_project_memo,
            project_memo::delete_project_memo,
            project_store::project_list,
            project_store::project_create,
            project_store::project_load,
            project_store::project_delete,
            project_store::project_list_episodes,
            project_store::project_create_episode,
            project_store::project_read_episode,
            project_store::project_write_episode,
            project_store::project_update_episode_title,
            project_store::project_delete_episode,
            project_store::project_reorder_episodes,
            project_store::project_read_document,
            project_store::project_write_document,
            search::rebuild_search_index,
            search::search_episodes,
            storage::migrate_legacy_app_data,
            settings::list_characters,
            settings::create_character,
            settings::update_character,
            settings::delete_character,
            settings::list_world_entries,
            settings::create_world_entry,
            settings::update_world_entry,
            settings::delete_world_entry,
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_delete,
            tools::edit_episode_text,
            tools::edit_episode_text_batch,
            tools::find_episode_lines,
            tools::get_edit_log,
            tools::get_episode_lines,
            tools::list_episodes_with_summaries,
            tools::retrieve_episode_content,
            tools::save_episode_one_liner,
            tools::save_episode_summary,
            web_search::web_search,
            web_fetch::web_fetch,
            webdav_sync::load_webdav_sync_config,
            webdav_sync::save_webdav_sync_config,
            webdav_sync::write_document_text_file,
            webdav_sync::remove_document_path,
            webdav_sync::pull_webdav_all,
            webdav_sync::push_webdav_all,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
