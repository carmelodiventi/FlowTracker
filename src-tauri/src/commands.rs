//! Tauri IPC commands — MongoDB-only, device-ID-scoped.

use crate::MongoState;
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

fn doc_to_session(d: &Document) -> Option<Session> {
    let id = d.get_object_id("_id").ok()?.to_hex();
    let app_name = d.get_str("app_name").ok()?.to_string();
    let start_time = d.get_str("start_time").ok()?.to_string();
    let end_time = d.get_str("end_time").ok().map(|s| s.to_string());
    let duration = d.get_i64("duration")
        .or_else(|_| d.get_i32("duration").map(|x| x as i64)).ok();
    let task_name = d.get_str("task_name").ok().map(|s| s.to_string());
    let status = d.get_str("status").unwrap_or("pending").to_string();
    let work_session_id = d.get_object_id("work_session_id").ok().map(|o| o.to_hex());
    Some(Session { id, app_name, start_time, end_time, duration, task_name, status, work_session_id })
}

async fn fetch_work_session_by_id(db: &mongodb::Database, user_id: &str, ws_oid: ObjectId)
    -> Result<WorkSession, String>
{
    let ws_col = db.collection::<Document>("work_sessions");
    let ws_doc = ws_col.find_one(doc! { "_id": ws_oid, "user_id": user_id })
        .await.map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Work session not found: {}", ws_oid.to_hex()))?;

    let name  = ws_doc.get_str("name").unwrap_or("").to_string();
    let color = ws_doc.get_str("color").unwrap_or("#58a6ff").to_string();
    let created_at = ws_doc.get_str("created_at").unwrap_or("").to_string();
    let project_id_oid = ws_doc.get_object_id("project_id").ok();
    let project_id_hex: Option<String> = project_id_oid.map(|o| o.to_hex());

    let sess_col = db.collection::<Document>("sessions");
    let mut cursor = sess_col.find(doc! { "work_session_id": ws_oid, "user_id": user_id })
        .await.map_err(|e| e.to_string())?;
    let mut total_secs = 0i64;
    let mut session_count = 0i64;
    let mut app_names_set: Vec<String> = vec![];
    let mut min_start = created_at.clone();
    let mut max_end: Option<String> = None;
    while cursor.advance().await.map_err(|e| e.to_string())? {
        let sd = cursor.deserialize_current().map_err(|e| e.to_string())?;
        session_count += 1;
        let dur = sd.get_i64("duration").or_else(|_| sd.get_i32("duration").map(|x| x as i64)).unwrap_or(0);
        total_secs += dur;
        if let Ok(a) = sd.get_str("app_name") {
            let a = a.to_string();
            if !app_names_set.contains(&a) { app_names_set.push(a); }
        }
        if let Ok(s) = sd.get_str("start_time") {
            if min_start.is_empty() || s < min_start.as_str() { min_start = s.to_string(); }
        }
        if let Ok(e) = sd.get_str("end_time") {
            let e = e.to_string();
            max_end = Some(match max_end { None => e.clone(), Some(ref prev) if &e > prev => e, Some(p) => p });
        }
    }

    let (project_name, project_color) = if let Some(proj_oid) = project_id_oid {
        let proj_col = db.collection::<Document>("projects");
        if let Ok(Some(pd)) = proj_col.find_one(doc! { "_id": proj_oid, "user_id": user_id }).await {
            (pd.get_str("name").ok().map(|s| s.to_string()),
             pd.get_str("color").ok().map(|s| s.to_string()))
        } else { (None, None) }
    } else { (None, None) };

    Ok(WorkSession {
        id: ws_oid.to_hex(),
        name,
        color,
        start_time: if min_start.is_empty() { created_at } else { min_start },
        end_time: max_end,
        total_secs,
        session_count,
        app_names: app_names_set.join(", "),
        project_id: project_id_hex,
        project_name,
        project_color,
    })
}

// ── Device ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_user_id(state: State<'_, MongoState>) -> Result<String, String> {
    Ok(state.user_id.clone())
}

// ── Applications ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_applications(state: State<'_, MongoState>) -> Result<Vec<Application>, String> {
    let db = &state.db;
    let did = &state.user_id;
    let col = db.collection::<Document>("applications");
    let mut cursor = col.find(doc! { "user_id": did }).sort(doc! { "name": 1_i32 })
        .await.map_err(|e| e.to_string())?;
    let mut apps = vec![];
    while cursor.advance().await.map_err(|e| e.to_string())? {
        let d = cursor.deserialize_current().map_err(|e| e.to_string())?;
        if let Ok(oid) = d.get_object_id("_id") {
            apps.push(Application {
                id:           oid.to_hex(),
                name:         d.get_str("name").unwrap_or("").to_string(),
                process_name: d.get_str("process_name").unwrap_or("").to_string(),
                icon:         d.get_str("icon").ok().map(|s| s.to_string()),
                is_enabled:   d.get_bool("is_enabled").unwrap_or(false),
            });
        }
    }
    Ok(apps)
}

#[tauri::command]
pub async fn upsert_application(
    state: State<'_, MongoState>,
    name: String, process_name: String, is_enabled: bool,
) -> Result<String, String> {
    let col = state.db.collection::<Document>("applications");
    let did = &state.user_id;
    let result = col.update_one(
        doc! { "process_name": &process_name, "user_id": did },
        doc! { "$set": { "name": &name, "is_enabled": is_enabled },
               "$setOnInsert": { "process_name": &process_name, "user_id": did } },
    ).upsert(true).await.map_err(|e| e.to_string())?;
    if let Some(uid) = result.upserted_id {
        return Ok(uid.as_object_id().map(|o| o.to_hex()).unwrap_or_default());
    }
    let doc = col.find_one(doc! { "process_name": &process_name, "user_id": did })
        .await.map_err(|e| e.to_string())?
        .ok_or("Not found after upsert")?;
    Ok(doc.get_object_id("_id").map_err(|e| e.to_string())?.to_hex())
}

#[tauri::command]
pub async fn toggle_application(
    state: State<'_, MongoState>, id: String, enabled: bool,
) -> Result<(), String> {
    let oid = ObjectId::parse_str(&id).map_err(|e| e.to_string())?;
    state.db.collection::<Document>("applications")
        .update_one(doc! { "_id": oid, "user_id": &state.user_id },
                    doc! { "$set": { "is_enabled": enabled } })
        .await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn scan_running_apps(state: State<'_, MongoState>) -> Result<Vec<Application>, String> {
    let names = collect_running_app_names()?;
    let col = state.db.collection::<Document>("applications");
    let did = &state.user_id;

    if !names.is_empty() {
        let names_bson: Vec<Bson> = names.iter().map(|n| Bson::String(n.clone())).collect();
        col.delete_many(doc! {
            "user_id": did,
            "is_enabled": false,
            "process_name": { "$nin": names_bson }
        }).await.map_err(|e| e.to_string())?;

        for name in &names {
            col.update_one(
                doc! { "process_name": name, "user_id": did },
                doc! { "$set": { "name": name },
                       "$setOnInsert": { "process_name": name, "user_id": did, "is_enabled": false } },
            ).upsert(true).await.map_err(|e| e.to_string())?;
        }
    }

    let mut cursor = col.find(doc! { "user_id": did }).sort(doc! { "name": 1_i32 })
        .await.map_err(|e| e.to_string())?;
    let mut apps = vec![];
    while cursor.advance().await.map_err(|e| e.to_string())? {
        let d = cursor.deserialize_current().map_err(|e| e.to_string())?;
        if let Ok(oid) = d.get_object_id("_id") {
            apps.push(Application {
                id:           oid.to_hex(),
                name:         d.get_str("name").unwrap_or("").to_string(),
                process_name: d.get_str("process_name").unwrap_or("").to_string(),
                icon:         d.get_str("icon").ok().map(|s| s.to_string()),
                is_enabled:   d.get_bool("is_enabled").unwrap_or(false),
            });
        }
    }
    Ok(apps)
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
pub async fn list_today_sessions(state: State<'_, MongoState>) -> Result<Vec<Session>, String> {
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    list_sessions_for_date(state, today).await
}

#[tauri::command]
pub async fn list_sessions_for_date(
    state: State<'_, MongoState>, date: String,
) -> Result<Vec<Session>, String> {
    let start = format!("{}T00:00:00Z", date);
    let end   = format!("{}T23:59:59Z", date);
    let col = state.db.collection::<Document>("sessions");
    let mut cursor = col
        .find(doc! { "user_id": &state.user_id, "start_time": { "$gte": &start, "$lte": &end } })
        .sort(doc! { "start_time": -1_i32 })
        .await.map_err(|e| e.to_string())?;
    let mut sessions = vec![];
    while cursor.advance().await.map_err(|e| e.to_string())? {
        let d = cursor.deserialize_current().map_err(|e| e.to_string())?;
        if let Some(s) = doc_to_session(&d) { sessions.push(s); }
    }
    Ok(sessions)
}

#[tauri::command]
pub async fn list_pending_sessions(state: State<'_, MongoState>) -> Result<Vec<Session>, String> {
    let col = state.db.collection::<Document>("sessions");
    let mut cursor = col
        .find(doc! { "user_id": &state.user_id, "status": "pending", "end_time": { "$ne": Bson::Null } })
        .sort(doc! { "start_time": -1_i32 })
        .limit(20_i64)
        .await.map_err(|e| e.to_string())?;
    let mut sessions = vec![];
    while cursor.advance().await.map_err(|e| e.to_string())? {
        let d = cursor.deserialize_current().map_err(|e| e.to_string())?;
        if let Some(s) = doc_to_session(&d) { sessions.push(s); }
    }
    Ok(sessions)
}

#[tauri::command]
pub async fn name_session(
    state: State<'_, MongoState>, id: String, task_name: String,
) -> Result<(), String> {
    let oid = ObjectId::parse_str(&id).map_err(|e| e.to_string())?;
    state.db.collection::<Document>("sessions")
        .update_one(doc! { "_id": oid, "user_id": &state.user_id },
                    doc! { "$set": { "task_name": &task_name, "status": "confirmed" } })
        .await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_session(state: State<'_, MongoState>, id: String) -> Result<(), String> {
    let oid = ObjectId::parse_str(&id).map_err(|e| e.to_string())?;
    let result = state.db.collection::<Document>("sessions")
        .delete_one(doc! { "_id": oid, "user_id": &state.user_id, "status": { "$ne": "active" } })
        .await.map_err(|e| e.to_string())?;
    if result.deleted_count == 0 {
        Err("Session not found or is currently active".to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub async fn stop_active_session(
    state: State<'_, MongoState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let col = state.db.collection::<Document>("sessions");
    let now = crate::watcher::iso_now();
    // Find the active session for this user
    let session = col.find_one(doc! {
        "user_id": &state.user_id,
        "status": "active"
    }).await.map_err(|e| e.to_string())?;

    let Some(doc) = session else {
        return Ok(()); // nothing active
    };
    let oid = doc.get_object_id("_id").map_err(|e| e.to_string())?;
    let start = doc.get_str("start_time").unwrap_or("").to_string();
    let app_name = doc.get_str("app_name").unwrap_or("").to_string();

    let duration = if start.is_empty() {
        0i64
    } else {
        let start_dt = chrono::DateTime::parse_from_rfc3339(&start)
            .map(|d| d.timestamp())
            .unwrap_or(0);
        let now_ts = chrono::Utc::now().timestamp();
        (now_ts - start_dt).max(0)
    };

    col.update_one(
        doc! { "_id": oid },
        doc! { "$set": { "status": "closed", "end_time": &now, "duration": duration } },
    ).await.map_err(|e| e.to_string())?;

    // Emit so the UI refreshes
    let _ = app.emit("flow:session-closed", serde_json::json!({
        "session_id": oid.to_hex(),
        "app_name": app_name,
        "duration_secs": duration,
    }));

    Ok(())
}

#[tauri::command]
pub async fn daily_summary(
    state: State<'_, MongoState>, date: String,
) -> Result<Vec<AppSummary>, String> {
    let start = format!("{}T00:00:00Z", date);
    let end   = format!("{}T23:59:59Z", date);
    let pipeline = vec![
        doc! { "$match": {
            "user_id":  &state.user_id,
            "start_time": { "$gte": &start, "$lte": &end },
            "end_time":   { "$ne": Bson::Null }
        }},
        doc! { "$group": {
            "_id": "$app_name",
            "total_secs":    { "$sum": "$duration" },
            "session_count": { "$sum": 1 }
        }},
        doc! { "$sort": { "total_secs": -1_i32 } },
    ];
    let col = state.db.collection::<Document>("sessions");
    let mut cursor = col.aggregate(pipeline).await.map_err(|e| e.to_string())?;
    let mut summaries = vec![];
    while cursor.advance().await.map_err(|e| e.to_string())? {
        let d = cursor.deserialize_current().map_err(|e| e.to_string())?;
        let app_name = d.get_str("_id").unwrap_or("").to_string();
        let total_secs = d.get_i64("total_secs").or_else(|_| d.get_i32("total_secs").map(|x| x as i64)).unwrap_or(0);
        let session_count = d.get_i64("session_count").or_else(|_| d.get_i32("session_count").map(|x| x as i64)).unwrap_or(0);
        summaries.push(AppSummary { process_name: app_name.clone(), app_name, total_secs, session_count });
    }
    Ok(summaries)
}

#[tauri::command]
pub async fn get_sessions_for_export(
    state: State<'_, MongoState>, from_date: String, to_date: String,
) -> Result<Vec<Session>, String> {
    let start = format!("{}T00:00:00Z", from_date);
    let end   = format!("{}T23:59:59Z", to_date);
    let col = state.db.collection::<Document>("sessions");
    let mut cursor = col
        .find(doc! { "user_id": &state.user_id, "start_time": { "$gte": &start, "$lte": &end }, "end_time": { "$ne": Bson::Null } })
        .sort(doc! { "task_name": 1_i32, "start_time": 1_i32 })
        .await.map_err(|e| e.to_string())?;
    let mut sessions = vec![];
    while cursor.advance().await.map_err(|e| e.to_string())? {
        let d = cursor.deserialize_current().map_err(|e| e.to_string())?;
        if let Some(s) = doc_to_session(&d) { sessions.push(s); }
    }
    Ok(sessions)
}

// ── Settings ──────────────────────────────────────────────────────────────────
// Settings use compound _id = "{user_id}::{key}" so upserts are O(1).

#[tauri::command]
pub async fn get_setting(state: State<'_, MongoState>, key: String) -> Result<String, String> {
    let scoped_id = format!("{}::{}", state.user_id, key);
    let col = state.db.collection::<Document>("settings");
    let doc = col.find_one(doc! { "_id": &scoped_id }).await.map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Setting '{}' not found", key))?;
    doc.get_str("value").map(|s| s.to_string()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_setting(
    state: State<'_, MongoState>, key: String, value: String,
) -> Result<(), String> {
    let scoped_id = format!("{}::{}", state.user_id, key);
    state.db.collection::<Document>("settings")
        .update_one(doc! { "_id": &scoped_id }, doc! { "$set": { "value": &value } })
        .upsert(true).await.map_err(|e| e.to_string())?;
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
pub async fn list_task_names(state: State<'_, MongoState>) -> Result<Vec<String>, String> {
    let pipeline = vec![
        doc! { "$match": { "user_id": &state.user_id, "task_name": { "$ne": Bson::Null } } },
        doc! { "$group": { "_id": "$task_name", "last_use": { "$max": "$start_time" } } },
        doc! { "$sort": { "last_use": -1_i32 } },
        doc! { "$limit": 50_i32 },
    ];
    let mut cursor = state.db.collection::<Document>("sessions")
        .aggregate(pipeline).await.map_err(|e| e.to_string())?;
    let mut names = vec![];
    while cursor.advance().await.map_err(|e| e.to_string())? {
        let d = cursor.deserialize_current().map_err(|e| e.to_string())?;
        if let Ok(n) = d.get_str("_id") { names.push(n.to_string()); }
    }
    Ok(names)
}

#[tauri::command]
pub async fn rename_task_group(
    state: State<'_, MongoState>, old_name: String, new_name: String,
) -> Result<(), String> {
    state.db.collection::<Document>("sessions")
        .update_many(doc! { "user_id": &state.user_id, "task_name": &old_name },
                     doc! { "$set": { "task_name": new_name.trim() } })
        .await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_task_group(state: State<'_, MongoState>, name: String) -> Result<(), String> {
    state.db.collection::<Document>("sessions")
        .update_many(doc! { "user_id": &state.user_id, "task_name": &name },
                     doc! { "$set": { "task_name": Bson::Null } })
        .await.map_err(|e| e.to_string())?;
    Ok(())
}

// ── Work Sessions ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn create_work_session(
    state: State<'_, MongoState>,
    name: String,
    session_ids: Vec<String>,
    color: Option<String>,
) -> Result<WorkSession, String> {
    if session_ids.is_empty() { return Err("No sessions provided".to_string()); }

    let oids: Vec<ObjectId> = session_ids.iter()
        .filter_map(|id| ObjectId::parse_str(id).ok()).collect();
    let oids_bson: Vec<Bson> = oids.iter().map(|o| Bson::ObjectId(*o)).collect();
    let db = &state.db;
    let did = &state.user_id;
    let sess_col = db.collection::<Document>("sessions");

    let mut cursor = sess_col.find(doc! { "_id": { "$in": &oids_bson }, "user_id": did })
        .await.map_err(|e| e.to_string())?;
    let mut min_start = String::new();
    while cursor.advance().await.map_err(|e| e.to_string())? {
        let d = cursor.deserialize_current().map_err(|e| e.to_string())?;
        if let Ok(s) = d.get_str("start_time") {
            if min_start.is_empty() || s < min_start.as_str() { min_start = s.to_string(); }
        }
    }
    let created_at = if min_start.is_empty() { iso_now() } else { min_start };

    let ws_col = db.collection::<Document>("work_sessions");
    let result = ws_col.insert_one(doc! {
        "user_id":  did,
        "name":       &name,
        "color":      color.unwrap_or_else(|| "#58a6ff".to_string()),
        "created_at": &created_at,
        "project_id": Bson::Null,
    }).await.map_err(|e| e.to_string())?;
    let ws_oid = result.inserted_id.as_object_id().ok_or("Failed to get inserted ObjectId")?;

    sess_col.update_many(
        doc! { "_id": { "$in": &oids_bson }, "user_id": did },
        doc! { "$set": { "work_session_id": ws_oid } },
    ).await.map_err(|e| e.to_string())?;

    fetch_work_session_by_id(db, did, ws_oid).await
}

#[tauri::command]
pub async fn list_work_sessions(
    state: State<'_, MongoState>, date: String,
) -> Result<Vec<WorkSession>, String> {
    let start = format!("{}T00:00:00Z", date);
    let end   = format!("{}T23:59:59Z", date);
    let db = &state.db;
    let did = &state.user_id;

    let sess_col = db.collection::<Document>("sessions");
    let mut cursor = sess_col
        .find(doc! { "user_id": did, "start_time": { "$gte": &start, "$lte": &end }, "work_session_id": { "$ne": Bson::Null } })
        .await.map_err(|e| e.to_string())?;
    let mut ws_ids: std::collections::HashSet<ObjectId> = std::collections::HashSet::new();
    while cursor.advance().await.map_err(|e| e.to_string())? {
        let d = cursor.deserialize_current().map_err(|e| e.to_string())?;
        if let Ok(oid) = d.get_object_id("work_session_id") { ws_ids.insert(oid); }
    }

    let mut result = vec![];
    for ws_id in ws_ids {
        if let Ok(ws) = fetch_work_session_by_id(db, did, ws_id).await { result.push(ws); }
    }
    result.sort_by(|a, b| a.start_time.cmp(&b.start_time));
    Ok(result)
}

#[tauri::command]
pub async fn list_all_work_sessions(
    state: State<'_, MongoState>,
) -> Result<Vec<WorkSession>, String> {
    let db  = &state.db;
    let did = &state.user_id;
    let ws_col = db.collection::<Document>("work_sessions");
    let mut cursor = ws_col
        .find(doc! { "user_id": did })
        .sort(doc! { "start_time": 1_i32 })
        .await.map_err(|e| e.to_string())?;
    let mut result = vec![];
    while cursor.advance().await.map_err(|e| e.to_string())? {
        let d = cursor.deserialize_current().map_err(|e| e.to_string())?;
        let ws_id = d.get_object_id("_id").map(|o| o.to_hex()).unwrap_or_default();
        if let Ok(ws) = fetch_work_session_by_id(db, did, ObjectId::parse_str(&ws_id).unwrap()).await {
            result.push(ws);
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn update_work_session(
    state: State<'_, MongoState>, id: String, name: String,
) -> Result<(), String> {
    let oid = ObjectId::parse_str(&id).map_err(|e| e.to_string())?;
    state.db.collection::<Document>("work_sessions")
        .update_one(doc! { "_id": oid, "user_id": &state.user_id },
                    doc! { "$set": { "name": name.trim() } })
        .await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_work_session(state: State<'_, MongoState>, id: String) -> Result<(), String> {
    let oid = ObjectId::parse_str(&id).map_err(|e| e.to_string())?;
    let db = &state.db;
    let did = &state.user_id;
    db.collection::<Document>("sessions")
        .update_many(doc! { "work_session_id": oid, "user_id": did },
                     doc! { "$set": { "work_session_id": Bson::Null } })
        .await.map_err(|e| e.to_string())?;
    db.collection::<Document>("work_sessions")
        .delete_one(doc! { "_id": oid, "user_id": did })
        .await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn list_sessions_for_work_session(
    state: State<'_, MongoState>, work_session_id: String,
) -> Result<Vec<Session>, String> {
    let oid = ObjectId::parse_str(&work_session_id).map_err(|e| e.to_string())?;
    let mut cursor = state.db.collection::<Document>("sessions")
        .find(doc! { "work_session_id": oid, "user_id": &state.user_id })
        .sort(doc! { "start_time": 1_i32 })
        .await.map_err(|e| e.to_string())?;
    let mut sessions = vec![];
    while cursor.advance().await.map_err(|e| e.to_string())? {
        let d = cursor.deserialize_current().map_err(|e| e.to_string())?;
        if let Some(s) = doc_to_session(&d) { sessions.push(s); }
    }
    Ok(sessions)
}

#[tauri::command]
pub async fn remove_session_from_work_session(
    state: State<'_, MongoState>, session_id: String,
) -> Result<(), String> {
    let oid = ObjectId::parse_str(&session_id).map_err(|e| e.to_string())?;
    state.db.collection::<Document>("sessions")
        .update_one(doc! { "_id": oid, "user_id": &state.user_id },
                    doc! { "$set": { "work_session_id": Bson::Null } })
        .await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn assign_work_session_project(
    state: State<'_, MongoState>,
    work_session_id: String,
    project_id: Option<String>,
) -> Result<(), String> {
    let ws_oid = ObjectId::parse_str(&work_session_id).map_err(|e| e.to_string())?;
    let proj_val = match project_id {
        Some(ref pid) => Bson::ObjectId(ObjectId::parse_str(pid).map_err(|e| e.to_string())?),
        None => Bson::Null,
    };
    state.db.collection::<Document>("work_sessions")
        .update_one(doc! { "_id": ws_oid, "user_id": &state.user_id },
                    doc! { "$set": { "project_id": proj_val } })
        .await.map_err(|e| e.to_string())?;
    Ok(())
}

// ── Projects ──────────────────────────────────────────────────────────────────

const PALETTE: &[&str] = &[
    "#6affc9", "#58a6ff", "#ff7b72", "#d2a8ff",
    "#ffa657", "#79c0ff", "#56d364", "#e3b341",
];

#[tauri::command]
pub async fn list_projects(state: State<'_, MongoState>) -> Result<Vec<Project>, String> {
    let mut cursor = state.db.collection::<Document>("projects")
        .find(doc! { "user_id": &state.user_id }).sort(doc! { "name": 1_i32 })
        .await.map_err(|e| e.to_string())?;
    let mut projects = vec![];
    while cursor.advance().await.map_err(|e| e.to_string())? {
        let d = cursor.deserialize_current().map_err(|e| e.to_string())?;
        if let Ok(oid) = d.get_object_id("_id") {
            projects.push(Project {
                id:    oid.to_hex(),
                name:  d.get_str("name").unwrap_or("").to_string(),
                color: d.get_str("color").unwrap_or("").to_string(),
            });
        }
    }
    Ok(projects)
}

#[tauri::command]
pub async fn list_projects_detail(state: State<'_, MongoState>) -> Result<Vec<ProjectDetail>, String> {
    let db = &state.db;
    let did = &state.user_id;
    let mut cursor = db.collection::<Document>("projects")
        .find(doc! { "user_id": did }).sort(doc! { "name": 1_i32 })
        .await.map_err(|e| e.to_string())?;
    let mut projects = vec![];
    while cursor.advance().await.map_err(|e| e.to_string())? {
        let d = cursor.deserialize_current().map_err(|e| e.to_string())?;
        if let Ok(oid) = d.get_object_id("_id") {
            let client_id_oid = d.get_object_id("client_id").ok();
            let client_id_hex: Option<String> = client_id_oid.map(|o| o.to_hex());
            let client_name = if let Some(cid) = client_id_oid {
                db.collection::<Document>("clients")
                    .find_one(doc! { "_id": cid, "user_id": did }).await.ok().flatten()
                    .and_then(|cd| cd.get_str("name").ok().map(|s| s.to_string()))
            } else { None };
            projects.push(ProjectDetail {
                id:          oid.to_hex(),
                name:        d.get_str("name").unwrap_or("").to_string(),
                color:       d.get_str("color").unwrap_or("").to_string(),
                description: d.get_str("description").ok().map(|s| s.to_string()),
                client_id:   client_id_hex,
                client_name,
            });
        }
    }
    Ok(projects)
}

#[tauri::command]
pub async fn create_project(
    state: State<'_, MongoState>,
    name: String, description: Option<String>, client_id: Option<String>,
) -> Result<ProjectDetail, String> {
    let db = &state.db;
    let did = &state.user_id;
    let count = db.collection::<Document>("projects")
        .count_documents(doc! { "user_id": did }).await.unwrap_or(0);
    let color = PALETTE[(count as usize) % PALETTE.len()].to_string();

    let client_id_oid: Option<ObjectId> = client_id.as_deref()
        .map(|id| ObjectId::parse_str(id).map_err(|e| e.to_string()))
        .transpose()?;
    let client_val = client_id_oid.map(Bson::ObjectId).unwrap_or(Bson::Null);
    let desc_val = description.as_deref().map(Bson::from).unwrap_or(Bson::Null);

    let result = db.collection::<Document>("projects").insert_one(doc! {
        "user_id":   did,
        "name":        name.trim(),
        "color":       &color,
        "description": desc_val,
        "client_id":   client_val,
    }).await.map_err(|e| e.to_string())?;
    let id = result.inserted_id.as_object_id().ok_or("No ObjectId")?.to_hex();

    let client_name = if let Some(cid) = client_id_oid {
        db.collection::<Document>("clients")
            .find_one(doc! { "_id": cid, "user_id": did }).await.ok().flatten()
            .and_then(|cd| cd.get_str("name").ok().map(|s| s.to_string()))
    } else { None };

    Ok(ProjectDetail {
        id, name: name.trim().to_string(), color, description,
        client_id: client_id_oid.map(|o| o.to_hex()), client_name,
    })
}

#[tauri::command]
pub async fn update_project(
    state: State<'_, MongoState>,
    id: String, name: String, description: Option<String>, client_id: Option<String>,
) -> Result<(), String> {
    let oid = ObjectId::parse_str(&id).map_err(|e| e.to_string())?;
    let client_val = client_id.as_deref()
        .map(|cid| ObjectId::parse_str(cid).map(Bson::ObjectId).map_err(|e| e.to_string()))
        .transpose()?.unwrap_or(Bson::Null);
    state.db.collection::<Document>("projects")
        .update_one(doc! { "_id": oid, "user_id": &state.user_id }, doc! { "$set": {
            "name":        name.trim(),
            "description": description.as_deref().map(Bson::from).unwrap_or(Bson::Null),
            "client_id":   client_val,
        }}).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_project(state: State<'_, MongoState>, id: String) -> Result<(), String> {
    let oid = ObjectId::parse_str(&id).map_err(|e| e.to_string())?;
    let db = &state.db;
    let did = &state.user_id;
    db.collection::<Document>("work_sessions")
        .update_many(doc! { "project_id": oid, "user_id": did },
                     doc! { "$set": { "project_id": Bson::Null } })
        .await.map_err(|e| e.to_string())?;
    db.collection::<Document>("projects")
        .delete_one(doc! { "_id": oid, "user_id": did })
        .await.map_err(|e| e.to_string())?;
    Ok(())
}

// ── Clients ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_clients(state: State<'_, MongoState>) -> Result<Vec<Client>, String> {
    let mut cursor = state.db.collection::<Document>("clients")
        .find(doc! { "user_id": &state.user_id }).sort(doc! { "name": 1_i32 })
        .await.map_err(|e| e.to_string())?;
    let mut clients = vec![];
    while cursor.advance().await.map_err(|e| e.to_string())? {
        let d = cursor.deserialize_current().map_err(|e| e.to_string())?;
        if let Ok(oid) = d.get_object_id("_id") {
            clients.push(Client {
                id:   oid.to_hex(),
                name: d.get_str("name").unwrap_or("").to_string(),
            });
        }
    }
    Ok(clients)
}

#[tauri::command]
pub async fn create_client(state: State<'_, MongoState>, name: String) -> Result<Client, String> {
    let result = state.db.collection::<Document>("clients")
        .insert_one(doc! { "user_id": &state.user_id, "name": name.trim() })
        .await.map_err(|e| e.to_string())?;
    let id = result.inserted_id.as_object_id().ok_or("No ObjectId")?.to_hex();
    Ok(Client { id, name: name.trim().to_string() })
}

#[tauri::command]
pub async fn delete_client(state: State<'_, MongoState>, id: String) -> Result<(), String> {
    let oid = ObjectId::parse_str(&id).map_err(|e| e.to_string())?;
    state.db.collection::<Document>("clients")
        .delete_one(doc! { "_id": oid, "user_id": &state.user_id })
        .await.map_err(|e| e.to_string())?;
    Ok(())
}
