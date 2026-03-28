//! FlowTracker — Tauri application entry point (MVP 3).
//!
//! Responsibilities:
//!   1. Open the local SQLite database (two connections: one for the watcher
//!      thread, one for Tauri IPC commands — both in WAL mode).
//!   2. Start the background active-window watcher thread (via `.setup()` so
//!      we have an `AppHandle` to emit events to the frontend).
//!   3. Register Tauri managed state, plugins, and IPC command handlers.
//!   4. Launch the Tauri runtime.

mod commands;
mod db;
mod watcher;

use commands::DbState;
use std::sync::{Arc, Mutex};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info"),
    )
    .init();

    // Watcher DB connection — created before the builder so it can be moved
    // into the `.setup()` closure.
    let watcher_conn = db::open_db().expect("Failed to open watcher DB connection");
    let shared_db = Arc::new(Mutex::new(watcher_conn));

    // Command DB connection — a separate connection so IPC commands never
    // block the watcher thread (both run in WAL mode).
    let cmd_conn = db::open_db().expect("Failed to open command DB connection");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(DbState(Mutex::new(cmd_conn)))
        .setup(move |app| {
            // Create the main window programmatically (windows array in
            // tauri.conf.json is empty to avoid a tao startup race on macOS 26).
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("FlowTracker")
            .inner_size(1200.0, 800.0)
            .resizable(true)
            .build()?;

            // Start background watcher.
            watcher::start_watcher(Arc::clone(&shared_db), app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_applications,
            commands::upsert_application,
            commands::toggle_application,
            commands::scan_running_apps,
            commands::list_today_sessions,
            commands::list_sessions_for_date,
            commands::list_pending_sessions,
            commands::name_session,
            commands::daily_summary,
            commands::get_setting,
            commands::set_setting,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
