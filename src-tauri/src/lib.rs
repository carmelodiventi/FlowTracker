#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod watcher;

use commands::*;
use mongodb::{options::ClientOptions, Client, Database};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime,
};

/// Shared MongoDB database handle (Clone + Send + Sync — no Arc needed).
pub struct MongoState(pub Database);

fn build_tray_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let tracking = MenuItem::with_id(app, "tracking_status", "○ Not tracking", false, None::<&str>)?;
    let sep      = PredefinedMenuItem::separator(app)?;
    let dashboard= MenuItem::with_id(app, "open_dashboard", "Open Dashboard", true, None::<&str>)?;
    let quit     = MenuItem::with_id(app, "quit", "Quit Flow Tracker", true, None::<&str>)?;
    Menu::with_items(app, &[&tracking, &sep, &dashboard, &quit])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    dotenvy::dotenv().ok();

    let mongo_uri = std::env::var("MONGODB_URI")
        .expect("MONGODB_URI must be set in environment or .env");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let handle = app.handle().clone();

            // ── Connect to MongoDB ────────────────────────────────────────────
            let db = tauri::async_runtime::block_on(async {
                let mut opts = ClientOptions::parse(&mongo_uri).await
                    .expect("Invalid MONGODB_URI");
                opts.app_name = Some("FlowTracker".into());
                let client = Client::with_options(opts)
                    .expect("Failed to create MongoDB client");
                // Ping to verify connectivity early.
                client.database("admin")
                    .run_command(mongodb::bson::doc! { "ping": 1 }).await
                    .expect("Cannot reach MongoDB — check MONGODB_URI and network");
                client.database("flowtracker")
            });

            // Seed default settings if missing.
            let db_seed = db.clone();
            tauri::async_runtime::spawn(async move {
                let col = db_seed.collection::<mongodb::bson::Document>("settings");
                for (key, val) in [
                    ("idle_threshold_secs", "300"),
                    ("merge_gap_secs", "120"),
                    ("whitelist_enabled", "1"),
                ] {
                    let _ = col.update_one(
                        mongodb::bson::doc! { "_id": key },
                        mongodb::bson::doc! { "$setOnInsert": { "_id": key, "value": val } },
                    ).upsert(true).await;
                }
            });

            app.manage(MongoState(db.clone()));

            // ── System tray ───────────────────────────────────────────────────
            let menu = build_tray_menu(&handle)?;
            TrayIconBuilder::new()
                .icon(handle.default_window_icon().cloned().unwrap())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(move |tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
                        if let Some(win) = tray.app_handle().get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open_dashboard" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "quit" => std::process::exit(0),
                    _ => {}
                })
                .build(&handle)?;

            // ── Start watcher ─────────────────────────────────────────────────
            watcher::start_watcher(db, handle);

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            // Applications
            list_applications,
            upsert_application,
            toggle_application,
            scan_running_apps,
            // Sessions
            list_today_sessions,
            list_sessions_for_date,
            list_pending_sessions,
            name_session,
            delete_session,
            daily_summary,
            get_sessions_for_export,
            // Settings
            get_setting,
            set_setting,
            // Accessibility
            check_accessibility,
            open_accessibility_settings,
            // Task names
            list_task_names,
            rename_task_group,
            delete_task_group,
            // Work sessions
            create_work_session,
            list_work_sessions,
            update_work_session,
            delete_work_session,
            list_sessions_for_work_session,
            remove_session_from_work_session,
            assign_work_session_project,
            // Projects
            list_projects,
            list_projects_detail,
            create_project,
            update_project,
            delete_project,
            // Clients
            list_clients,
            create_client,
            delete_client,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
