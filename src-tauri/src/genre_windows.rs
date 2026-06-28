use std::path::PathBuf;
use tauri::{Manager, WebviewWindowBuilder};

#[tauri::command]
pub async fn open_genre_chat_window(
    app: tauri::AppHandle,
    genre_id: String,
) -> Result<(), String> {
    let label = format!("genre-chat-{}", genre_id.replace(|c: char| !c.is_alphanumeric(), "_"));

    if let Some(existing) = app.get_webview_window(&label) {
        existing
            .set_focus()
            .map_err(|e| format!("Failed to focus genre chat window: {}", e))?;
        return Ok(());
    }

    let url = format!("genre-chat-window.html?genreId={}", genre_id);

    let _webview = WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::App(PathBuf::from(url)))
        .title("ジャンルAIチャット - Phenex")
        .inner_size(800.0, 640.0)
        .min_inner_size(480.0, 360.0)
        .build()
        .map_err(|e| format!("Failed to create genre chat window: {}", e))?;

    Ok(())
}
