mod search;
mod settings;
mod tools;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            search::rebuild_search_index,
            search::search_episodes,
            settings::list_characters,
            settings::create_character,
            settings::update_character,
            settings::list_world_entries,
            settings::create_world_entry,
            settings::update_world_entry,
            tools::edit_episode_text,
            tools::list_episodes_with_summaries,
            tools::retrieve_episode_content,
            tools::save_episode_one_liner,
            tools::save_episode_summary,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
