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

/// Enumerate every GUI application currently running on macOS and upsert each
/// one into the `applications` table (as disabled by default so the user can
/// review and enable what they want to track).  Returns the refreshed list.
///
/// Uses `ps -eo comm` on macOS — no shell-plugin permissions required because
/// this is a direct Rust `std::process::Command` call, not a frontend shell
/// command.
#[tauri::command]
pub fn scan_running_apps(state: State<DbState>) -> Result<Vec<Application>, String> {
    let names = collect_running_app_names()?;

    let conn = state.0.lock().map_err(|e| e.to_string())?;

    // Remove apps the user has NOT yet enabled (is_enabled = 0) that are no
    // longer in the freshly-scanned list.  Clears stale entries from previous
    // ps-based scans.  Apps the user explicitly enabled are always preserved.
    if !names.is_empty() {
        let placeholders: String = names
            .iter()
            .enumerate()
            .map(|(i, _)| format!("?{}", i + 1))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "DELETE FROM applications WHERE is_enabled = 0 AND process_name NOT IN ({placeholders})"
        );
        let params_refs: Vec<&dyn rusqlite::ToSql> =
            names.iter().map(|n| n as &dyn rusqlite::ToSql).collect();
        conn.execute(&sql, params_refs.as_slice())
            .map_err(|e| e.to_string())?;
    }

    // Upsert every discovered app (never downgrades an already-enabled app).
    for name in &names {
        conn.execute(
            "INSERT INTO applications (name, process_name, is_enabled)
             VALUES (?1, ?1, 0)
             ON CONFLICT(process_name) DO UPDATE SET name = excluded.name",
            params![name],
        )
        .map_err(|e| e.to_string())?;
    }

    // Return the full refreshed list.
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

/// Returns unique GUI application names currently running.
/// On macOS uses `ps -eo comm`.  On other platforms returns an empty list.
fn collect_running_app_names() -> Result<Vec<String>, String> {
    #[cfg(target_os = "macos")]
    {
        // Use NSWorkspace via osascript to list only apps that have a dock icon
        // (activationPolicy == 0 / NSApplicationActivationPolicyRegular).
        // This gives proper localized display names (e.g. "Antigravity" instead of
        // "Electron", "Code" instead of just the process binary) — the same names
        // that active-win-pos-rs reports as `app_name`, so session tracking matches.
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
            .args(["-e", script])
            .output()
            .map_err(|e| format!("osascript failed: {e}"))?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(format!("osascript error: {err}"));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut seen = std::collections::HashSet::new();
        // osascript returns a comma-space separated list, e.g. "Finder, Code, Antigravity"
        let names: Vec<String> = stdout
            .trim()
            .split(", ")
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty() && seen.insert(n.clone()))
            .collect();

        return Ok(names);
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(vec![])
    }
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
    pub work_session_id: Option<i64>,
}

/// Return all sessions whose `start_time` falls on today (UTC), newest first.
#[tauri::command]
pub fn list_today_sessions(state: State<DbState>) -> Result<Vec<Session>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.app_id, a.name,
                    s.start_time, s.end_time, s.duration, s.task_name, s.status,
                    s.work_session_id
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
                work_session_id: row.get(8)?,
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
                    s.start_time, s.end_time, s.duration, s.task_name, s.status,
                    s.work_session_id
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
                work_session_id: row.get(8)?,
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
                    s.start_time, s.end_time, s.duration, s.task_name, s.status,
                    s.work_session_id
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
                work_session_id: row.get(8)?,
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

// ---------------------------------------------------------------------------
// Accessibility permission
// ---------------------------------------------------------------------------

/// Returns `true` if FlowTracker has been granted Accessibility permission.
/// Uses the macOS `AXIsProcessTrusted()` API (ApplicationServices framework).
/// On non-macOS platforms always returns `true`.
#[tauri::command]
pub fn check_accessibility() -> bool {
    #[cfg(target_os = "macos")]
    {
        #[link(name = "ApplicationServices", kind = "framework")]
        extern "C" {
            fn AXIsProcessTrusted() -> bool;
        }
        unsafe { AXIsProcessTrusted() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Opens the macOS Accessibility pane in System Settings so the user can
/// grant permission without needing to navigate there manually.
#[tauri::command]
pub fn open_accessibility_settings() {
    #[cfg(target_os = "macos")]
    {
        // Works on macOS 13+ (Ventura and later, including macOS 26 Tahoe).
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .spawn();
    }
}

// ---------------------------------------------------------------------------
// Work Sessions
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct WorkSession {
    pub id: i64,
    pub name: String,
    pub color: String,
    pub start_time: String,
    pub end_time: Option<String>,
    pub total_secs: i64,      // computed: sum of linked sessions' duration
    pub session_count: i64,   // number of linked app sessions
    pub app_names: String,    // comma-separated app names in this work session
    pub project_id: Option<i64>,
    pub project_name: Option<String>,
    pub project_color: Option<String>,
}

/// Create a new work session from a list of app session IDs.
/// Sets work_session_id on all provided session IDs.
/// The work session's start/end time is derived from the earliest/latest session.
#[tauri::command]
pub fn create_work_session(
    state: State<DbState>,
    name: String,
    session_ids: Vec<i64>,
    color: Option<String>,
) -> Result<WorkSession, String> {
    if session_ids.is_empty() {
        return Err("No sessions provided".to_string());
    }
    let conn = state.0.lock().unwrap_or_else(|e| e.into_inner());

    // Derive start/end from the linked sessions.
    let placeholders = session_ids
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 1))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT MIN(start_time), MAX(COALESCE(end_time, start_time)) \
         FROM sessions WHERE id IN ({placeholders})"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let params_refs: Vec<&dyn rusqlite::ToSql> =
        session_ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
    let (start_time, end_time): (String, String) = stmt
        .query_row(params_refs.as_slice(), |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?;

    let color = color.unwrap_or_else(|| "#58a6ff".to_string());

    // Insert the work session row.
    conn.execute(
        "INSERT INTO work_sessions (name, color, start_time, end_time) \
         VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![name, color, start_time, end_time],
    )
    .map_err(|e| e.to_string())?;
    let work_session_id = conn.last_insert_rowid();

    // Link all provided sessions.
    for sid in &session_ids {
        conn.execute(
            "UPDATE sessions SET work_session_id = ?1 WHERE id = ?2",
            rusqlite::params![work_session_id, sid],
        )
        .map_err(|e| e.to_string())?;
    }

    // Fetch and return the fully-populated WorkSession.
    fetch_work_session(&conn, work_session_id)
}

/// List work sessions for a given date (YYYY-MM-DD).
#[tauri::command]
pub fn list_work_sessions(
    state: State<DbState>,
    date: String,
) -> Result<Vec<WorkSession>, String> {
    let conn = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let mut stmt = conn
        .prepare(
            "SELECT ws.id FROM work_sessions ws
             WHERE date(ws.start_time) = ?1
             ORDER BY ws.start_time ASC",
        )
        .map_err(|e| e.to_string())?;

    let ids: Vec<i64> = stmt
        .query_map(rusqlite::params![date], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let mut result = Vec::new();
    for id in ids {
        if let Ok(ws) = fetch_work_session(&conn, id) {
            result.push(ws);
        }
    }
    Ok(result)
}

/// Rename a work session.
#[tauri::command]
pub fn update_work_session(
    state: State<DbState>,
    id: i64,
    name: String,
) -> Result<(), String> {
    let conn = state.0.lock().unwrap_or_else(|e| e.into_inner());
    conn.execute(
        "UPDATE work_sessions SET name = ?1 WHERE id = ?2",
        rusqlite::params![name, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Delete a work session and un-link its constituent app sessions.
#[tauri::command]
pub fn delete_work_session(
    state: State<DbState>,
    id: i64,
) -> Result<(), String> {
    let conn = state.0.lock().unwrap_or_else(|e| e.into_inner());
    conn.execute(
        "UPDATE sessions SET work_session_id = NULL WHERE work_session_id = ?1",
        rusqlite::params![id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM work_sessions WHERE id = ?1",
        rusqlite::params![id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Internal helper: fetch a fully-populated WorkSession by its ID.
fn fetch_work_session(conn: &rusqlite::Connection, id: i64) -> Result<WorkSession, String> {
    conn.query_row(
        "SELECT ws.id, ws.name, ws.color, ws.start_time, ws.end_time,
                COALESCE(SUM(s.duration), 0)   AS total_secs,
                COUNT(s.id)                    AS session_count,
                GROUP_CONCAT(DISTINCT a.name)  AS app_names,
                ws.project_id,
                p.name                         AS project_name,
                p.color                        AS project_color
         FROM work_sessions ws
         LEFT JOIN sessions     s ON s.work_session_id = ws.id
         LEFT JOIN applications a ON a.id = s.app_id
         LEFT JOIN projects     p ON p.id = ws.project_id
         WHERE ws.id = ?1
         GROUP BY ws.id",
        rusqlite::params![id],
        |row| {
            Ok(WorkSession {
                id:            row.get(0)?,
                name:          row.get(1)?,
                color:         row.get(2)?,
                start_time:    row.get(3)?,
                end_time:      row.get(4)?,
                total_secs:    row.get(5)?,
                session_count: row.get(6)?,
                app_names:     row.get::<_, Option<String>>(7)?.unwrap_or_default(),
                project_id:    row.get(8)?,
                project_name:  row.get(9)?,
                project_color: row.get(10)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct Project {
    pub id: i64,
    pub name: String,
    pub color: String,
}

/// Return all projects ordered alphabetically.
#[tauri::command]
pub fn list_projects(state: State<DbState>) -> Result<Vec<Project>, String> {
    let conn = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let mut stmt = conn
        .prepare("SELECT id, name, color FROM projects ORDER BY name ASC")
        .map_err(|e| e.to_string())?;
    let projects = stmt
        .query_map([], |row| {
            Ok(Project {
                id:    row.get(0)?,
                name:  row.get(1)?,
                color: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(projects)
}

/// Create a new project and return it.
#[tauri::command]
pub fn create_project(
    state: State<DbState>,
    name: String,
    color: Option<String>,
) -> Result<Project, String> {
    let conn = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let color = color.unwrap_or_else(|| "#6affc9".to_string());
    conn.execute(
        "INSERT INTO projects (name, color) VALUES (?1, ?2)",
        rusqlite::params![name, color],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    Ok(Project { id, name, color })
}

/// Assign (or clear) a project on a work session.
/// Pass `project_id = None` to detach the project.
#[tauri::command]
pub fn assign_work_session_project(
    state: State<DbState>,
    work_session_id: i64,
    project_id: Option<i64>,
) -> Result<(), String> {
    let conn = state.0.lock().unwrap_or_else(|e| e.into_inner());
    conn.execute(
        "UPDATE work_sessions SET project_id = ?1 WHERE id = ?2",
        rusqlite::params![project_id, work_session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Delete a session by ID. Active sessions cannot be deleted.
#[tauri::command]
pub fn delete_session(state: State<DbState>, id: i64) -> Result<(), String> {
    let conn = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let affected = conn
        .execute(
            "DELETE FROM sessions WHERE id = ?1 AND status != 'active'",
            rusqlite::params![id],
        )
        .map_err(|e| e.to_string())?;
    if affected == 0 {
        Err("Session not found or is currently active".to_string())
    } else {
        Ok(())
    }
}

/// Return distinct task names used recently, ordered by most recent use.
/// Used to power autocomplete in the session naming UI.
#[tauri::command]
pub fn list_task_names(state: State<DbState>) -> Result<Vec<String>, String> {
    let conn = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT task_name
             FROM sessions
             WHERE task_name IS NOT NULL AND task_name != ''
             ORDER BY MAX(start_time) DESC
             LIMIT 50",
        )
        .map_err(|e| e.to_string())?;
    let names = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(names)
}

/// Rename all sessions sharing `old_name` as task_name to `new_name`.
/// This renames the whole group in one shot.
#[tauri::command]
pub fn rename_task_group(
    old_name: String,
    new_name: String,
    state: State<DbState>,
) -> Result<(), String> {
    let conn = state.0.lock().unwrap_or_else(|e| e.into_inner());
    conn.execute(
        "UPDATE sessions SET task_name = ?1 WHERE task_name = ?2",
        rusqlite::params![new_name.trim(), old_name],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}
