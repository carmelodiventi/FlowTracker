//! Flow Tracker — Tauri application entry point (MVP 3).
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
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Listener, Manager};

/// Build (or rebuild) the tray menu, querying the DB for the live session.
fn build_tray_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let db_state = app.state::<DbState>();
    let conn = db_state.0.lock().unwrap_or_else(|e| e.into_inner());

    // Query the current active session.
    let status_line: String = conn
        .query_row(
            "SELECT a.name FROM sessions s \
             JOIN applications a ON s.app_id = a.id \
             WHERE s.status = 'active' \
             ORDER BY s.start_time DESC LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .map(|app_name| format!("● {}", app_name))
        .unwrap_or_else(|_| "○ Not tracking".to_string());

    drop(conn); // release lock before building menu

    let status = MenuItem::with_id(app, "status", status_line, false, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let show = MenuItem::with_id(app, "show", "Show Dashboard", true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Flow Tracker", true, None::<&str>)?;

    Menu::with_items(app, &[&status, &sep1, &show, &sep2, &quit])
}

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
            .title("Flow Tracker")
            .inner_size(1200.0, 800.0)
            .resizable(true)
            .build()?;

            // ── System tray ──────────────────────────────────────────────────
            let menu = build_tray_menu(app.handle())?;
            let tray_icon_bytes = include_bytes!("../icons/tray-icon.png");
            let tray_icon = tauri::image::Image::from_bytes(tray_icon_bytes)
                .unwrap_or_else(|_| app.default_window_icon().unwrap().clone());

            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(tray_icon)
                .icon_as_template(true) // macOS: adapt to light/dark mode
                .menu(&menu)
                .tooltip("Flow Tracker")
                .on_tray_icon_event({
                    let handle = app.handle().clone();
                    move |_tray, event| {
                        // Left-click: show & focus the window.
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            if let Some(win) = handle.get_webview_window("main") {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                        // NOTE: do NOT rebuild menu here — it would close the menu
                        // the instant the user opens it.
                    }
                })
                .on_menu_event({
                    let handle = app.handle().clone();
                    move |_app, event| match event.id.as_ref() {
                        "show" => {
                            if let Some(win) = handle.get_webview_window("main") {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                        "quit" => {
                            handle.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // Rebuild the tray menu whenever a session opens or closes so the
            // status line stays current without touching the menu while it's open.
            {
                let handle = app.handle().clone();
                app.handle().listen("flow:session-opened", move |_| {
                    if let Some(tray) = handle.tray_by_id("main-tray") {
                        if let Ok(m) = build_tray_menu(&handle) {
                            let _ = tray.set_menu(Some(m));
                        }
                    }
                });
            }
            {
                let handle = app.handle().clone();
                app.handle().listen("flow:session-closed", move |_| {
                    if let Some(tray) = handle.tray_by_id("main-tray") {
                        if let Ok(m) = build_tray_menu(&handle) {
                            let _ = tray.set_menu(Some(m));
                        }
                    }
                });
            }

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
            commands::check_accessibility,
            commands::open_accessibility_settings,
            commands::create_work_session,
            commands::list_work_sessions,
            commands::update_work_session,
            commands::delete_work_session,
            commands::list_projects,
            commands::create_project,
            commands::assign_work_session_project,
            commands::delete_session,
            commands::list_task_names,
            commands::rename_task_group,
            commands::delete_task_group,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
