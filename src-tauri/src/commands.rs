//! Tauri IPC commands — the React frontend calls these via `invoke()`.
//!
//! All commands receive a `State<DbState>` that holds a `Mutex<Connection>`.
//! The mutex ensures that only one command accesses SQLite at a time (SQLite
//! in WAL mode is safe for concurrent reads, but `rusqlite::Connection` is
//! not `Send + Sync`, so we guard it with a mutex).

use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::State;

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

/// Tauri-managed state wrapping the SQLite connection used by IPC commands.
///
/// A *second* connection (separate from the watcher's connection) is opened at
/// startup and registered via `.manage(DbState(...))`.  WAL mode allows both
/// connections to coexist without write contention.
pub struct DbState(pub Mutex<rusqlite::Connection>);

// ---------------------------------------------------------------------------
// Application / Whitelist commands
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct Application {
    pub id: i64,
    pub name: String,
    pub process_name: String,
    pub icon: Option<String>,
    pub is_enabled: bool,
}

/// Return every application row, ordered by name.
#[tauri::command]
pub fn list_applications(state: State<DbState>) -> Result<Vec<Application>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, process_name, icon, is_enabled
             FROM   applications
             ORDER  BY name",
        )
        .map_err(|e| e.to_string())?;

    let apps = stmt
        .query_map([], |row| {
            Ok(Application {
                id: row.get(0)?,
                name: row.get(1)?,
                process_name: row.get(2)?,
                icon: row.get(3)?,
                is_enabled: row.get::<_, i64>(4)? != 0,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(apps)
}

/// Insert a new application or update its `name` / `is_enabled` fields if the
/// `process_name` already exists.  Returns the row ID.
#[tauri::command]
pub fn upsert_application(
    state: State<DbState>,
    name: String,
    process_name: String,
    is_enabled: bool,
) -> Result<i64, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO applications (name, process_name, is_enabled)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(process_name)
         DO UPDATE SET name = excluded.name, is_enabled = excluded.is_enabled",
        params![name, process_name, is_enabled as i64],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

/// Flip the `is_enabled` flag for a single application row.
#[tauri::command]
pub fn toggle_application(
    state: State<DbState>,
    id: i64,
    enabled: bool,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE applications SET is_enabled = ?1 WHERE id = ?2",
        params![enabled as i64, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Session commands
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct Session {
    pub id: i64,
    pub app_id: i64,
    pub app_name: String,
    pub start_time: String,
    pub end_time: Option<String>,
    pub duration: Option<i64>,
    pub task_name: Option<String>,
    pub status: String,
}

/// Return all sessions whose `start_time` falls on today (UTC), newest first.
#[tauri::command]
pub fn list_today_sessions(state: State<DbState>) -> Result<Vec<Session>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.app_id, a.name,
                    s.start_time, s.end_time, s.duration, s.task_name, s.status
             FROM   sessions     s
             JOIN   applications a ON a.id = s.app_id
             WHERE  date(s.start_time) = date('now')
             ORDER  BY s.start_time DESC",
        )
        .map_err(|e| e.to_string())?;

    let sessions = stmt
        .query_map([], |row| {
            Ok(Session {
                id: row.get(0)?,
                app_id: row.get(1)?,
                app_name: row.get(2)?,
                start_time: row.get(3)?,
                end_time: row.get(4)?,
                duration: row.get(5)?,
                task_name: row.get(6)?,
                status: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(sessions)
}

/// Attach a human-readable task name to a session and mark it `'confirmed'`.
#[tauri::command]
pub fn name_session(
    state: State<DbState>,
    id: i64,
    task_name: String,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE sessions
         SET    task_name = ?1, status = 'confirmed'
         WHERE  id = ?2",
        params![task_name, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Return sessions with status `'pending'` that still need a name, newest first.
/// Used by the frontend to populate the naming notification queue.
#[tauri::command]
pub fn list_pending_sessions(state: State<DbState>) -> Result<Vec<Session>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.app_id, a.name,
                    s.start_time, s.end_time, s.duration, s.task_name, s.status
             FROM   sessions     s
             JOIN   applications a ON a.id = s.app_id
             WHERE  s.status = 'pending'
               AND  s.end_time IS NOT NULL
             ORDER  BY s.start_time DESC
             LIMIT  20",
        )
        .map_err(|e| e.to_string())?;

    let sessions = stmt
        .query_map([], |row| {
            Ok(Session {
                id: row.get(0)?,
                app_id: row.get(1)?,
                app_name: row.get(2)?,
                start_time: row.get(3)?,
                end_time: row.get(4)?,
                duration: row.get(5)?,
                task_name: row.get(6)?,
                status: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(sessions)
}

/// Return all sessions for a given calendar date (YYYY-MM-DD), ordered by start time.
/// Used by the timeline dashboard.
#[tauri::command]
pub fn list_sessions_for_date(
    state: State<DbState>,
    date: String,
) -> Result<Vec<Session>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.app_id, a.name,
                    s.start_time, s.end_time, s.duration, s.task_name, s.status
             FROM   sessions     s
             JOIN   applications a ON a.id = s.app_id
             WHERE  date(s.start_time) = ?1
             ORDER  BY s.start_time ASC",
        )
        .map_err(|e| e.to_string())?;

    let sessions = stmt
        .query_map(params![date], |row| {
            Ok(Session {
                id: row.get(0)?,
                app_id: row.get(1)?,
                app_name: row.get(2)?,
                start_time: row.get(3)?,
                end_time: row.get(4)?,
                duration: row.get(5)?,
                task_name: row.get(6)?,
                status: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(sessions)
}

/// Return per-app total tracked seconds for a given date. Used by the dashboard summary bar.
#[derive(Debug, Serialize, Deserialize)]
pub struct AppSummary {
    pub app_name: String,
    pub process_name: String,
    pub total_secs: i64,
    pub session_count: i64,
}

#[tauri::command]
pub fn daily_summary(state: State<DbState>, date: String) -> Result<Vec<AppSummary>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT a.name, a.process_name,
                    COALESCE(SUM(s.duration), 0)  AS total_secs,
                    COUNT(s.id)                   AS session_count
             FROM   sessions     s
             JOIN   applications a ON a.id = s.app_id
             WHERE  date(s.start_time) = ?1
               AND  s.end_time IS NOT NULL
             GROUP  BY a.id
             ORDER  BY total_secs DESC",
        )
        .map_err(|e| e.to_string())?;

    let summaries = stmt
        .query_map(params![date], |row| {
            Ok(AppSummary {
                app_name: row.get(0)?,
                process_name: row.get(1)?,
                total_secs: row.get(2)?,
                session_count: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(summaries)
}

// ---------------------------------------------------------------------------
// Settings commands
// ---------------------------------------------------------------------------

/// Retrieve a setting value by key (e.g. `"idle_timeout"`).
#[tauri::command]
pub fn get_setting(state: State<DbState>, key: String) -> Result<String, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Upsert a setting value.
#[tauri::command]
pub fn set_setting(
    state: State<DbState>,
    key: String,
    value: String,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
