//! Tauri IPC commands — transitional storage layer during MongoDB -> SQLite migration.

use crate::{db, db::LocalDbState, MongoState};
use mongodb::bson::{doc, oid::ObjectId, Bson, Document};
use serde::{Deserialize, Serialize};
use tauri::{State, Emitter};

fn iso_now() -> String { chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string() }

// ── Structs ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct Application {
    pub id: String,
    pub name: String,
    pub process_name: String,
    pub icon: Option<String>,
    pub is_enabled: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub app_name: String,
    pub start_time: String,
    pub end_time: Option<String>,
    pub duration: Option<i64>,
    pub task_name: Option<String>,
    pub status: String,
    pub work_session_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AppSummary {
    pub app_name: String,
    pub process_name: String,
    pub total_secs: i64,
    pub session_count: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WorkSession {
    pub id: String,
    pub name: String,
    pub color: String,
    pub start_time: String,
    pub end_time: Option<String>,
    pub total_secs: i64,
    pub session_count: i64,
    pub app_names: String,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub project_color: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Client {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProjectDetail {
    pub id: String,
    pub name: String,
    pub color: String,
    pub description: Option<String>,
    pub client_id: Option<String>,
    pub client_name: Option<String>,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn sqlite_session_to_api(session: db::DbSession) -> Session {
    Session {
        id: session.id,
        app_name: session.app_name,
        start_time: session.start_time,
        end_time: session.end_time,
        duration: session.duration,
        task_name: session.task_name,
        status: session.status,
        work_session_id: session.work_session_id,
    }
}

fn import_mongo_session(local_state: &LocalDbState, user_id: &str, d: &Document) -> Result<(), String> {
    let public_id = d.get_object_id("_id").map_err(|e| e.to_string())?.to_hex();
    let app_name = d.get_str("app_name").unwrap_or("");
    let process_name = d.get_str("process_name").ok();
    let start_time = d.get_str("start_time").unwrap_or("");
    let end_time = d.get_str("end_time").ok();
    let duration = d.get_i64("duration").or_else(|_| d.get_i32("duration").map(|x| x as i64)).ok();
    let task_name = d.get_str("task_name").ok();
    let status = d.get_str("status").unwrap_or("pending");
    let work_session_id = d.get_object_id("work_session_id").ok().map(|o| o.to_hex());
    db::upsert_session_record(
        &local_state.db_path,
        user_id,
        &public_id,
        app_name,
        process_name,
        start_time,
        end_time,
        duration,
        task_name,
        status,
        work_session_id.as_deref(),
    )
}

async fn import_sessions_for_date_from_mongo(
    local_state: &LocalDbState,
    state: &MongoState,
    date: &str,
) -> Result<(), String> {
    let start = format!("{}T00:00:00Z", date);
    let end = format!("{}T23:59:59Z", date);
    let mut cursor = state.db.collection::<Document>("sessions")
        .find(doc! { "user_id": &state.user_id, "start_time": { "$gte": &start, "$lte": &end } })
        .sort(doc! { "start_time": -1_i32 })
        .await.map_err(|e| e.to_string())?;
    while cursor.advance().await.map_err(|e| e.to_string())? {
        let d = cursor.deserialize_current().map_err(|e| e.to_string())?;
        import_mongo_session(local_state, &state.user_id, &d)?;
    }
    Ok(())
}

async fn import_pending_sessions_from_mongo(local_state: &LocalDbState, state: &MongoState) -> Result<(), String> {
    let mut cursor = state.db.collection::<Document>("sessions")
        .find(doc! { "user_id": &state.user_id, "status": "pending", "end_time": { "$ne": Bson::Null } })
        .sort(doc! { "start_time": -1_i32 })
        .limit(50_i64)
        .await.map_err(|e| e.to_string())?;
    while cursor.advance().await.map_err(|e| e.to_string())? {
        let d = cursor.deserialize_current().map_err(|e| e.to_string())?;
        import_mongo_session(local_state, &state.user_id, &d)?;
    }
    Ok(())
}

async fn import_sessions_for_export_from_mongo(
    local_state: &LocalDbState,
    state: &MongoState,
    from_date: &str,
    to_date: &str,
) -> Result<(), String> {
    let start = format!("{}T00:00:00Z", from_date);
    let end = format!("{}T23:59:59Z", to_date);
    let mut cursor = state.db.collection::<Document>("sessions")
        .find(doc! { "user_id": &state.user_id, "start_time": { "$gte": &start, "$lte": &end }, "end_time": { "$ne": Bson::Null } })
        .sort(doc! { "start_time": -1_i32 })
        .await.map_err(|e| e.to_string())?;
    while cursor.advance().await.map_err(|e| e.to_string())? {
        let d = cursor.deserialize_current().map_err(|e| e.to_string())?;
        import_mongo_session(local_state, &state.user_id, &d)?;
    }
    Ok(())
}

// ── Device ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_user_id(state: State<'_, MongoState>) -> Result<String, String> {
    Ok(state.user_id.clone())
}

// ── Applications ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_applications(
    local_state: State<'_, LocalDbState>,
    mongo_state: State<'_, MongoState>,
) -> Result<Vec<Application>, String> {
    let mut apps = db::list_applications(&local_state.db_path, &mongo_state.user_id)?;

    if apps.is_empty() {
        let col = mongo_state.db.collection::<Document>("applications");
        let mut cursor = col
            .find(doc! { "user_id": &mongo_state.user_id })
            .sort(doc! { "name": 1_i32 })
            .await
            .map_err(|e| e.to_string())?;

        while cursor.advance().await.map_err(|e| e.to_string())? {
            let d = cursor.deserialize_current().map_err(|e| e.to_string())?;
            let name = d.get_str("name").unwrap_or("").to_string();
            let process_name = d.get_str("process_name").unwrap_or("").to_string();
            let icon = d.get_str("icon").ok().map(|s| s.to_string());
            let is_enabled = d.get_bool("is_enabled").unwrap_or(false);
            let _ = db::upsert_application(
                &local_state.db_path,
                &mongo_state.user_id,
                &name,
                &process_name,
                icon.as_deref(),
                is_enabled,
            )?;
        }

        apps = db::list_applications(&local_state.db_path, &mongo_state.user_id)?;
    }

    Ok(apps
        .into_iter()
        .map(|app| Application {
            id: app.id,
            name: app.name,
            process_name: app.process_name,
            icon: app.icon,
            is_enabled: app.is_enabled,
        })
        .collect())
}

#[tauri::command]
pub async fn upsert_application(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>,
    name: String, process_name: String, is_enabled: bool,
) -> Result<String, String> {
    let sqlite_id = db::upsert_application(
        &local_state.db_path,
        &state.user_id,
        &name,
        &process_name,
        None,
        is_enabled,
    )?;

    let col = state.db.collection::<Document>("applications");
    let did = &state.user_id;
    if let Err(error) = col.update_one(
        doc! { "process_name": &process_name, "user_id": did },
        doc! { "$set": { "name": &name, "is_enabled": is_enabled },
               "$setOnInsert": { "process_name": &process_name, "user_id": did } },
    ).upsert(true).await {
        eprintln!("[Flow Tracker] Mongo mirror failed for application upsert: {error}");
    }

    Ok(sqlite_id)
}

#[tauri::command]
pub async fn toggle_application(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>, id: String, enabled: bool,
) -> Result<(), String> {
    db::toggle_application(&local_state.db_path, &state.user_id, &id, enabled)?;

    let apps = state.db.collection::<Document>("applications");
    let sqlite_apps = db::list_applications(&local_state.db_path, &state.user_id)?;
    if let Some(app) = sqlite_apps.into_iter().find(|app| app.id == id) {
        if let Err(error) = apps
            .update_one(
                doc! { "process_name": &app.process_name, "user_id": &state.user_id },
                doc! { "$set": { "name": &app.name, "is_enabled": enabled },
                       "$setOnInsert": { "process_name": &app.process_name, "user_id": &state.user_id } },
            )
            .upsert(true)
            .await
        {
            eprintln!("[Flow Tracker] Mongo mirror failed for application toggle: {error}");
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn scan_running_apps(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>,
) -> Result<Vec<Application>, String> {
    let names = collect_running_app_names()?;
    let col = state.db.collection::<Document>("applications");
    let did = &state.user_id;

    let apps = db::sync_running_applications(&local_state.db_path, did, &names)?;

    if !names.is_empty() {
        let names_bson: Vec<Bson> = names.iter().map(|n| Bson::String(n.clone())).collect();
        if let Err(error) = col.delete_many(doc! {
            "user_id": did,
            "is_enabled": false,
            "process_name": { "$nin": names_bson }
        }).await {
            eprintln!("[Flow Tracker] Mongo mirror failed while pruning applications: {error}");
        }

        for name in &names {
            if let Err(error) = col.update_one(
                doc! { "process_name": name, "user_id": did },
                doc! { "$set": { "name": name },
                       "$setOnInsert": { "process_name": name, "user_id": did, "is_enabled": false } },
            ).upsert(true).await {
                eprintln!("[Flow Tracker] Mongo mirror failed while syncing application '{name}': {error}");
            }
        }
    }

    Ok(apps
        .into_iter()
        .map(|app| Application {
            id: app.id,
            name: app.name,
            process_name: app.process_name,
            icon: app.icon,
            is_enabled: app.is_enabled,
        })
        .collect())
}

fn collect_running_app_names() -> Result<Vec<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let script = r#"
use framework "AppKit"
set apps to current application's NSWorkspace's sharedWorkspace()'s runningApplications()
set names to {}
repeat with a in apps
    try
        if (a's activationPolicy() as integer) is 0 then
            set aName to a's localizedName() as text
            if aName is not "" then
                set end of names to aName
            end if
        end if
    end try
end repeat
return names
"#;
        let output = std::process::Command::new("osascript")
            .args(["-e", script]).output()
            .map_err(|e| format!("osascript failed: {e}"))?;
        if !output.status.success() {
            return Err(format!("osascript error: {}", String::from_utf8_lossy(&output.stderr)));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut seen = std::collections::HashSet::new();
        let names = stdout.trim().split(", ")
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty() && seen.insert(n.clone()))
            .collect();
        return Ok(names);
    }
    #[cfg(not(target_os = "macos"))]
    Ok(vec![])
}

// ── Sessions ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_today_sessions(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>,
) -> Result<Vec<Session>, String> {
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    list_sessions_for_date(local_state, state, today).await
}

#[tauri::command]
pub async fn list_sessions_for_date(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>, date: String,
) -> Result<Vec<Session>, String> {
    let mut sessions = db::list_sessions_for_date(&local_state.db_path, &state.user_id, &date)?;
    if sessions.is_empty() {
        import_sessions_for_date_from_mongo(&local_state, &state, &date).await?;
        sessions = db::list_sessions_for_date(&local_state.db_path, &state.user_id, &date)?;
    }
    Ok(sessions.into_iter().map(sqlite_session_to_api).collect())
}

#[tauri::command]
pub async fn list_pending_sessions(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>,
) -> Result<Vec<Session>, String> {
    let mut sessions = db::list_pending_sessions(&local_state.db_path, &state.user_id)?;
    if sessions.is_empty() {
        import_pending_sessions_from_mongo(&local_state, &state).await?;
        sessions = db::list_pending_sessions(&local_state.db_path, &state.user_id)?;
    }
    Ok(sessions.into_iter().map(sqlite_session_to_api).collect())
}

#[tauri::command]
pub async fn name_session(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>, id: String, task_name: String,
) -> Result<(), String> {
    db::name_session(&local_state.db_path, &state.user_id, &id, &task_name)?;
    if let Ok(oid) = ObjectId::parse_str(&id) {
        let _ = state.db.collection::<Document>("sessions")
            .update_one(doc! { "_id": oid, "user_id": &state.user_id },
                        doc! { "$set": { "task_name": &task_name, "status": "confirmed" } })
            .await;
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_session(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>, id: String,
) -> Result<(), String> {
    if !db::delete_session(&local_state.db_path, &state.user_id, &id)? {
        Err("Session not found or is currently active".to_string())
    } else {
        if let Ok(oid) = ObjectId::parse_str(&id) {
            let _ = state.db.collection::<Document>("sessions")
                .delete_one(doc! { "_id": oid, "user_id": &state.user_id, "status": { "$ne": "active" } })
                .await;
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn stop_active_session(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let now = crate::watcher::iso_now();
    let session = db::get_active_session(&local_state.db_path, &state.user_id)?;
    let Some(session) = session else {
        return Ok(()); // nothing active
    };
    let closed = db::close_session(&local_state.db_path, &state.user_id, &session.id, &now, "closed", crate::watcher::compute_duration)?
        .ok_or_else(|| "Active session disappeared".to_string())?;

    if let Ok(oid) = ObjectId::parse_str(&session.id) {
        let _ = state.db.collection::<Document>("sessions")
            .update_one(
                doc! { "_id": oid },
                doc! { "$set": { "status": "closed", "end_time": &now, "duration": closed.duration.unwrap_or(0) } },
            ).await;
    }

    // Emit so the UI refreshes
    let _ = app.emit("flow:session-closed", serde_json::json!({
        "session_id": closed.id,
        "app_name": closed.app_name,
        "duration_secs": closed.duration.unwrap_or(0),
    }));

    Ok(())
}

#[tauri::command]
pub async fn pause_tracking(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>,
) -> Result<(), String> {
    let now = crate::watcher::iso_now();

    if let Some(active) = db::get_active_session(&local_state.db_path, &state.user_id)? {
        let _ = db::close_session(&local_state.db_path, &state.user_id, &active.id, &now, "closed", crate::watcher::compute_duration)?;
        if let Ok(oid) = ObjectId::parse_str(&active.id) {
            let duration = crate::watcher::compute_duration(&active.start_time, &now).max(0);
            let _ = state.db.collection::<Document>("sessions")
                .update_one(
                    doc! { "_id": oid },
                    doc! { "$set": { "status": "closed", "end_time": &now, "duration": duration } },
                ).await;
        }
    }

    db::set_setting(&local_state.db_path, &state.user_id, "pause_tracking", "true")?;
    let _ = state.db.collection::<Document>("settings")
        .update_one(
            doc! { "_id": format!("{}::pause_tracking", state.user_id) },
            doc! { "$set": { "value": "true" } },
        )
        .upsert(true)
        .await;
    Ok(())
}

#[tauri::command]
pub async fn resume_tracking(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>,
) -> Result<(), String> {
    db::set_setting(&local_state.db_path, &state.user_id, "pause_tracking", "false")?;
    let _ = state.db.collection::<Document>("settings")
        .update_one(
            doc! { "_id": format!("{}::pause_tracking", state.user_id) },
            doc! { "$set": { "value": "false" } },
        )
        .upsert(true)
        .await;
    Ok(())
}

#[tauri::command]
pub async fn daily_summary(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>, date: String,
) -> Result<Vec<AppSummary>, String> {
    let sessions = db::daily_summary(&local_state.db_path, &state.user_id, &date)?;
    Ok(sessions.into_iter().map(|summary| AppSummary {
        process_name: summary.app_name.clone(),
        app_name: summary.app_name,
        total_secs: summary.total_secs,
        session_count: summary.session_count,
    }).collect())
}

#[tauri::command]
pub async fn get_sessions_for_export(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>, from_date: String, to_date: String,
) -> Result<Vec<Session>, String> {
    let mut sessions = db::get_sessions_for_export(&local_state.db_path, &state.user_id, &from_date, &to_date)?;
    if sessions.is_empty() {
        import_sessions_for_export_from_mongo(&local_state, &state, &from_date, &to_date).await?;
        sessions = db::get_sessions_for_export(&local_state.db_path, &state.user_id, &from_date, &to_date)?;
    }
    Ok(sessions.into_iter().map(sqlite_session_to_api).collect())
}

// ── Settings ──────────────────────────────────────────────────────────────────
// Settings use compound _id = "{user_id}::{key}" so upserts are O(1).

#[tauri::command]
pub async fn get_setting(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>,
    key: String,
) -> Result<String, String> {
    if let Some(value) = db::get_setting(&local_state.db_path, &state.user_id, &key)? {
        return Ok(value);
    }

    let scoped_id = format!("{}::{}", state.user_id, key);
    let col = state.db.collection::<Document>("settings");
    let doc = col.find_one(doc! { "_id": &scoped_id }).await.map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Setting '{}' not found", key))?;
    let value = doc.get_str("value").map(|s| s.to_string()).map_err(|e| e.to_string())?;
    db::set_setting(&local_state.db_path, &state.user_id, &key, &value)?;
    Ok(value)
}

#[tauri::command]
pub async fn set_setting(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>, key: String, value: String,
) -> Result<(), String> {
    db::set_setting(&local_state.db_path, &state.user_id, &key, &value)?;

    let scoped_id = format!("{}::{}", state.user_id, key);
    if let Err(error) = state.db.collection::<Document>("settings")
        .update_one(doc! { "_id": &scoped_id }, doc! { "$set": { "value": &value } })
        .upsert(true).await {
        eprintln!("[Flow Tracker] Mongo mirror failed for setting '{key}': {error}");
    }

    Ok(())
}

#[tauri::command]
pub async fn export_backup_json(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>,
) -> Result<String, String> {
    db::export_backup_json(&local_state.db_path, &state.user_id)
}

#[tauri::command]
pub async fn import_backup_json(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>,
    backup_json: String,
) -> Result<db::BackupImportSummary, String> {
    db::import_backup_json(&local_state.db_path, &state.user_id, &backup_json)
}

#[tauri::command]
pub async fn clear_user_data(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>,
) -> Result<(), String> {
    // Clear SQLite
    db::clear_user_data(&local_state.db_path, &state.user_id)?;

    // Also clear MongoDB collections for this user
    let collections = vec!["sessions", "work_sessions", "projects", "clients", "applications", "settings"];
    for collection_name in collections {
        let col = state.db.collection::<Document>(collection_name);
        let _ = col.delete_many(doc! { "user_id": &state.user_id }).await;
    }

    Ok(())
}

// ── Accessibility ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn check_accessibility() -> bool {
    #[cfg(target_os = "macos")]
    {
        #[link(name = "ApplicationServices", kind = "framework")]
        extern "C" { fn AXIsProcessTrusted() -> bool; }
        unsafe { AXIsProcessTrusted() }
    }
    #[cfg(not(target_os = "macos"))] { true }
}

#[tauri::command]
pub fn open_accessibility_settings() {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .spawn();
    }
}

// ── Task name helpers ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_task_names(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>,
) -> Result<Vec<String>, String> {
    let mut names = db::list_task_names(&local_state.db_path, &state.user_id)?;
    if names.is_empty() {
        import_pending_sessions_from_mongo(&local_state, &state).await?;
        names = db::list_task_names(&local_state.db_path, &state.user_id)?;
    }
    Ok(names)
}

#[tauri::command]
pub async fn rename_task_group(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>, old_name: String, new_name: String,
) -> Result<(), String> {
    db::rename_task_group(&local_state.db_path, &state.user_id, &old_name, &new_name)?;
    let _ = state.db.collection::<Document>("sessions")
        .update_many(doc! { "user_id": &state.user_id, "task_name": &old_name },
                     doc! { "$set": { "task_name": new_name.trim() } })
        .await;
    Ok(())
}

#[tauri::command]
pub async fn delete_task_group(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>, name: String,
) -> Result<(), String> {
    db::delete_task_group(&local_state.db_path, &state.user_id, &name)?;
    let _ = state.db.collection::<Document>("sessions")
        .update_many(doc! { "user_id": &state.user_id, "task_name": &name },
                     doc! { "$set": { "task_name": Bson::Null } })
        .await;
    Ok(())
}

// ── Work Sessions ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn create_work_session(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>,
    name: String,
    session_ids: Vec<String>,
    color: Option<String>,
) -> Result<WorkSession, String> {
    let ws = db::create_work_session(
        &local_state.db_path,
        &state.user_id,
        &name,
        &session_ids,
        color.as_deref(),
        &iso_now(),
    )?;

    if let Ok(ws_oid) = ws.id.parse::<i64>() {
        let _ = state.db.collection::<Document>("work_sessions").insert_one(doc! {
            "_id": ws_oid,
            "user_id": &state.user_id,
            "name": &ws.name,
            "color": &ws.color,
            "created_at": &ws.start_time,
            "project_id": ws.project_id.as_deref().and_then(|p| ObjectId::parse_str(p).ok()).map(Bson::ObjectId).unwrap_or(Bson::Null),
        }).await;
    }

    Ok(WorkSession {
        id: ws.id,
        name: ws.name,
        color: ws.color,
        start_time: ws.start_time,
        end_time: ws.end_time,
        total_secs: ws.total_secs,
        session_count: ws.session_count,
        app_names: ws.app_names,
        project_id: ws.project_id,
        project_name: ws.project_name,
        project_color: ws.project_color,
    })
}

#[tauri::command]
pub async fn list_work_sessions(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>, date: String,
) -> Result<Vec<WorkSession>, String> {
    let sessions = db::list_work_sessions(&local_state.db_path, &state.user_id, &date)?;
    Ok(sessions.into_iter().map(|ws| WorkSession {
        id: ws.id,
        name: ws.name,
        color: ws.color,
        start_time: ws.start_time,
        end_time: ws.end_time,
        total_secs: ws.total_secs,
        session_count: ws.session_count,
        app_names: ws.app_names,
        project_id: ws.project_id,
        project_name: ws.project_name,
        project_color: ws.project_color,
    }).collect())
}

#[tauri::command]
pub async fn list_all_work_sessions(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>,
) -> Result<Vec<WorkSession>, String> {
    let sessions = db::list_all_work_sessions(&local_state.db_path, &state.user_id)?;
    Ok(sessions.into_iter().map(|ws| WorkSession {
        id: ws.id,
        name: ws.name,
        color: ws.color,
        start_time: ws.start_time,
        end_time: ws.end_time,
        total_secs: ws.total_secs,
        session_count: ws.session_count,
        app_names: ws.app_names,
        project_id: ws.project_id,
        project_name: ws.project_name,
        project_color: ws.project_color,
    }).collect())
}

#[tauri::command]
pub async fn update_work_session(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>, id: String, name: String,
) -> Result<(), String> {
    db::update_work_session(&local_state.db_path, &state.user_id, &id, &name)?;
    if let Ok(oid) = ObjectId::parse_str(&id) {
        let _ = state.db.collection::<Document>("work_sessions")
            .update_one(doc! { "_id": oid, "user_id": &state.user_id },
                        doc! { "$set": { "name": name.trim() } })
            .await;
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_work_session(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>, id: String,
) -> Result<(), String> {
    db::delete_work_session(&local_state.db_path, &state.user_id, &id)?;
    if let Ok(oid) = ObjectId::parse_str(&id) {
        let _ = state.db.collection::<Document>("sessions")
            .update_many(doc! { "work_session_id": oid, "user_id": &state.user_id },
                        doc! { "$set": { "work_session_id": Bson::Null } })
            .await;
        let _ = state.db.collection::<Document>("work_sessions")
            .delete_one(doc! { "_id": oid, "user_id": &state.user_id })
            .await;
    }
    Ok(())
}

#[tauri::command]
pub async fn list_sessions_for_work_session(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>, work_session_id: String,
) -> Result<Vec<Session>, String> {
    let sessions = db::list_sessions_for_work_session(&local_state.db_path, &state.user_id, &work_session_id)?;
    Ok(sessions.into_iter().map(sqlite_session_to_api).collect())
}

#[tauri::command]
pub async fn remove_session_from_work_session(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>, session_id: String,
) -> Result<(), String> {
    db::remove_session_from_work_session(&local_state.db_path, &state.user_id, &session_id)?;
    if let Ok(oid) = ObjectId::parse_str(&session_id) {
        let _ = state.db.collection::<Document>("sessions")
            .update_one(doc! { "_id": oid, "user_id": &state.user_id },
                        doc! { "$set": { "work_session_id": Bson::Null } })
            .await;
    }
    Ok(())
}

#[tauri::command]
pub async fn add_session_to_work_session(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>,
    session_id: String,
    work_session_id: String,
) -> Result<(), String> {
    db::add_session_to_work_session(&local_state.db_path, &state.user_id, &session_id, &work_session_id)?;
    if let (Ok(sess_oid), Ok(ws_oid)) = (ObjectId::parse_str(&session_id), ObjectId::parse_str(&work_session_id)) {
        let _ = state.db.collection::<Document>("sessions")
            .update_one(doc! { "_id": sess_oid, "user_id": &state.user_id },
                        doc! { "$set": { "work_session_id": ws_oid } })
            .await;
    }
    Ok(())
}

#[tauri::command]
pub async fn assign_work_session_project(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>,
    work_session_id: String,
    project_id: Option<String>,
) -> Result<(), String> {
    db::assign_work_session_project(&local_state.db_path, &state.user_id, &work_session_id, project_id.as_deref())?;
    if let Ok(ws_oid) = ObjectId::parse_str(&work_session_id) {
        let proj_val = match project_id {
            Some(ref pid) => Bson::ObjectId(ObjectId::parse_str(pid).map_err(|e| e.to_string())?),
            None => Bson::Null,
        };
        let _ = state.db.collection::<Document>("work_sessions")
            .update_one(doc! { "_id": ws_oid, "user_id": &state.user_id },
                        doc! { "$set": { "project_id": proj_val } })
            .await;
    }
    Ok(())
}

// ── Projects ──────────────────────────────────────────────────────────────────

const PALETTE: &[&str] = &[
    "#6affc9", "#58a6ff", "#ff7b72", "#d2a8ff",
    "#ffa657", "#79c0ff", "#56d364", "#e3b341",
];

#[tauri::command]
pub async fn list_projects(
    local_state: State<'_, LocalDbState>,
    _state: State<'_, MongoState>,
) -> Result<Vec<Project>, String> {
    let projects = db::list_projects(&local_state.db_path, &_state.user_id)?;
    Ok(projects.into_iter().map(|p| Project { id: p.id, name: p.name, color: p.color }).collect())
}

#[tauri::command]
pub async fn list_projects_detail(
    local_state: State<'_, LocalDbState>,
    _state: State<'_, MongoState>,
) -> Result<Vec<ProjectDetail>, String> {
    let projects = db::list_projects_detail(&local_state.db_path, &_state.user_id)?;
    Ok(projects.into_iter().map(|p| ProjectDetail {
        id: p.id,
        name: p.name,
        color: p.color,
        description: p.description,
        client_id: p.client_id,
        client_name: p.client_name,
    }).collect())
}

#[tauri::command]
pub async fn create_project(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>,
    name: String, description: Option<String>, client_id: Option<String>,
) -> Result<ProjectDetail, String> {
    let count = db::projects_count(&local_state.db_path, &state.user_id)?;
    let color = PALETTE[(count as usize) % PALETTE.len()].to_string();
    let project = db::create_project(
        &local_state.db_path,
        &state.user_id,
        &name,
        &color,
        description.as_deref(),
        client_id.as_deref(),
    )?;

    let _ = state.db.collection::<Document>("projects").insert_one(doc! {
        "user_id": &state.user_id,
        "name": name.trim(),
        "color": &color,
        "description": description.as_deref().map(Bson::from).unwrap_or(Bson::Null),
        "client_id": client_id.as_deref().and_then(|v| ObjectId::parse_str(v).ok()).map(Bson::ObjectId).unwrap_or(Bson::Null),
    }).await;

    Ok(ProjectDetail {
        id: project.id,
        name: project.name,
        color: project.color,
        description: project.description,
        client_id: project.client_id,
        client_name: project.client_name,
    })
}

#[tauri::command]
pub async fn update_project(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>,
    id: String, name: String, description: Option<String>, client_id: Option<String>,
) -> Result<(), String> {
    db::update_project(
        &local_state.db_path,
        &state.user_id,
        &id,
        &name,
        description.as_deref(),
        client_id.as_deref(),
    )?;
    if let Ok(oid) = ObjectId::parse_str(&id) {
        let client_val = client_id.as_deref()
            .map(|cid| ObjectId::parse_str(cid).map(Bson::ObjectId).map_err(|e| e.to_string()))
            .transpose()?.unwrap_or(Bson::Null);
        let _ = state.db.collection::<Document>("projects")
            .update_one(doc! { "_id": oid, "user_id": &state.user_id }, doc! { "$set": {
                "name":        name.trim(),
                "description": description.as_deref().map(Bson::from).unwrap_or(Bson::Null),
                "client_id":   client_val,
            }}).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_project(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>, id: String,
) -> Result<(), String> {
    db::delete_project(&local_state.db_path, &state.user_id, &id)?;
    if let Ok(oid) = ObjectId::parse_str(&id) {
        let _ = state.db.collection::<Document>("work_sessions")
            .update_many(doc! { "project_id": oid, "user_id": &state.user_id },
                        doc! { "$set": { "project_id": Bson::Null } })
            .await;
        let _ = state.db.collection::<Document>("projects")
            .delete_one(doc! { "_id": oid, "user_id": &state.user_id })
            .await;
    }
    Ok(())
}

// ── Clients ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_clients(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>,
) -> Result<Vec<Client>, String> {
    let clients = db::list_clients(&local_state.db_path, &state.user_id)?;
    Ok(clients.into_iter().map(|c| Client { id: c.id, name: c.name }).collect())
}

#[tauri::command]
pub async fn create_client(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>,
    name: String,
) -> Result<Client, String> {
    let created = db::create_client(&local_state.db_path, &state.user_id, &name)?;
    let _ = state.db.collection::<Document>("clients")
        .insert_one(doc! { "user_id": &state.user_id, "name": name.trim() })
        .await;
    Ok(Client { id: created.id, name: created.name })
}

#[tauri::command]
pub async fn delete_client(
    local_state: State<'_, LocalDbState>,
    state: State<'_, MongoState>,
    id: String,
) -> Result<(), String> {
    db::delete_client(&local_state.db_path, &state.user_id, &id)?;
    if let Ok(oid) = ObjectId::parse_str(&id) {
        let _ = state.db.collection::<Document>("clients")
            .delete_one(doc! { "_id": oid, "user_id": &state.user_id })
            .await;
    }
    Ok(())
}
