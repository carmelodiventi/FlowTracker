//! Active-window watcher — MVP 3.
//!
//! Polls the OS for the foreground window every [`POLL_INTERVAL`] seconds.
//! When the focused app changes:
//!   - If the *new* app is whitelisted → open a new session row in SQLite.
//!   - If the *old* app was whitelisted → close the previous session
//!     (sets `end_time` + `duration`).
//!
//! Idle detection pauses the active session after [`IDLE_THRESHOLD_SECS`] of
//! no keyboard / mouse activity.  The implementation is platform-gated:
//!   - **macOS**: `CGEventSourceSecondsSinceLastEventType` via `core-graphics`.
//!   - **Windows**: `GetLastInputInfo` via `winapi`.
//!   - **Other**: treated as never idle (returns 0 seconds).
//!
//! The poll loop runs on a dedicated OS thread so it never blocks the Tauri /
//! WebView event loop.

use active_win_pos_rs::get_active_window;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

/// How often to sample the foreground window.
const POLL_INTERVAL: Duration = Duration::from_secs(5);

/// Seconds of inactivity before a session is considered idle.
const IDLE_THRESHOLD_SECS: u64 = 300; // 5 minutes

/// A reference-counted, mutex-protected SQLite connection shared between the
/// watcher thread and the Tauri command thread.
pub type SharedDb = Arc<Mutex<Connection>>;

// ---------------------------------------------------------------------------
// Event payload emitted when a whitelisted session closes
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
pub struct SessionClosedPayload {
    pub session_id: i64,
    pub app_name: String,
    pub duration_secs: i64,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Spawn the background watcher thread.
///
/// Accepts a `SharedDb` for writing session rows and a `AppHandle` for
/// emitting `flow:session-closed` events to the frontend.
pub fn start_watcher(db: SharedDb, app: AppHandle) {
    thread::Builder::new()
        .name("flow-watcher".into())
        .spawn(move || poll_loop(db, app))
        .expect("Failed to spawn flow-watcher thread");
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

fn poll_loop(db: SharedDb, app: AppHandle) {
    println!("[FlowTracker] Watcher started (MVP 3 — auto-merge + notifications active)");

    // On startup, close any sessions that were left `active` from a previous run.
    // This happens when the process is killed/restarted without a clean shutdown.
    {
        let conn = db.lock().unwrap_or_else(|e| e.into_inner());
        let now = iso_now();
        let affected = conn.execute(
            "UPDATE sessions
             SET end_time = ?1,
                 duration = CAST((julianday(?1) - julianday(start_time)) * 86400 AS INTEGER),
                 status   = 'pending'
             WHERE status = 'active'",
            rusqlite::params![now],
        ).unwrap_or(0);
        if affected > 0 {
            println!("[FlowTracker] Closed {} stale active session(s) from previous run", affected);
        }
    }

    let mut current_session_id: Option<i64> = None;
    let mut current_process: Option<String> = None;
    let mut session_paused = false;
    // Grace period: when the user leaves an app, wait N seconds before
    // committing the switch — if they return within the window the active
    // session is never interrupted.
    // pending_switch = (new_app_name, when_we_first_noticed_the_switch)
    let mut pending_switch: Option<(String, Instant)> = None;

    loop {
        let idle_secs = seconds_since_last_input();
        let is_idle = idle_secs >= IDLE_THRESHOLD_SECS;

        // Read grace period each loop so live settings changes take effect.
        let grace_secs: u64 = {
            let conn = db.lock().unwrap_or_else(|e| e.into_inner());
            read_setting_i64(&conn, "focus_grace_period").unwrap_or(120).max(0) as u64
        };

        match get_active_window() {
            Ok(win) => {
                let process = win.app_name.clone();

                let is_whitelisted = {
                    let conn = db.lock().unwrap_or_else(|e| e.into_inner());
                    is_app_whitelisted(&conn, &process)
                };

                if is_idle {
                    // Idle: pause active session but don't switch.
                    pending_switch = None;
                    if let Some(sid) = current_session_id {
                        if !session_paused {
                            let conn = db.lock().unwrap_or_else(|e| e.into_inner());
                            pause_session(&conn, sid);
                            session_paused = true;
                            println!("[FlowTracker] Idle — session {} paused", sid);
                        }
                    }
                } else {
                    session_paused = false;
                    let same_as_current = current_process.as_deref() == Some(&process);

                    if same_as_current {
                        // User returned to (or stayed on) the tracked app — cancel any pending switch.
                        if pending_switch.take().is_some() {
                            println!("[FlowTracker] Grace period cancelled — back on {:?}", process);
                            let _ = app.emit("flow:session-opened", current_session_id.unwrap_or(0));
                        }
                    } else if current_session_id.is_none() && current_process.is_none() {
                        // No session running at all (startup or after idle close) — open immediately.
                        pending_switch = None;
                        if is_whitelisted {
                            let conn = db.lock().unwrap_or_else(|e| e.into_inner());
                            match open_session(&conn, &process) {
                                Ok(sid) => {
                                    println!("[FlowTracker] Started session {} for {:?}", sid, process);
                                    current_session_id = Some(sid);
                                    let _ = app.emit("flow:session-opened", sid);
                                }
                                Err(e) => eprintln!("[FlowTracker] open_session failed: {}", e),
                            }
                        }
                        current_process = Some(process);
                    } else {
                        // Different app detected.
                        match &pending_switch {
                            None => {
                                // First poll seeing a different app — start the grace timer.
                                println!(
                                    "[FlowTracker] Grace period started for {:?} → {:?} ({}s)",
                                    current_process.as_deref().unwrap_or("none"),
                                    process,
                                    grace_secs
                                );
                                pending_switch = Some((process.clone(), Instant::now()));
                                // Do NOT close the current session yet.
                            }
                            Some((pending_proc, switched_at)) => {
                                if pending_proc == &process {
                                    // Still seeing the same new app — check if grace period elapsed.
                                    if switched_at.elapsed().as_secs() >= grace_secs {
                                        println!(
                                            "[FlowTracker] Grace period expired — switching to {:?}",
                                            process
                                        );
                                        pending_switch = None;

                                        // Now actually commit the switch.
                                        if let Some(sid) = current_session_id.take() {
                                            let merge_threshold = {
                                                let conn = db.lock().unwrap_or_else(|e| e.into_inner());
                                                read_setting_i64(&conn, "auto_merge_threshold").unwrap_or(120)
                                            };
                                            let surviving = {
                                                let conn = db.lock().unwrap_or_else(|e| e.into_inner());
                                                close_and_merge(&conn, sid, merge_threshold)
                                            };
                                            if let Some((surviving_id, app_name, duration)) = surviving {
                                                let _ = app.emit(
                                                    "flow:session-closed",
                                                    SessionClosedPayload {
                                                        session_id: surviving_id,
                                                        app_name,
                                                        duration_secs: duration,
                                                    },
                                                );
                                            }
                                        }

                                        if is_whitelisted {
                                            let conn = db.lock().unwrap_or_else(|e| e.into_inner());
                                            match open_session(&conn, &process) {
                                                Ok(sid) => {
                                                    println!(
                                                        "[FlowTracker] Started session {} for {:?}",
                                                        sid, process
                                                    );
                                                    current_session_id = Some(sid);
                                                    let _ = app.emit("flow:session-opened", sid);
                                                }
                                                Err(e) => eprintln!("[FlowTracker] open_session failed: {}", e),
                                            }
                                        }
                                        current_process = Some(process);
                                    }
                                    // else: still within grace period — keep waiting.
                                } else {
                                    // User switched to yet another app — reset grace timer.
                                    println!(
                                        "[FlowTracker] Grace period reset — now on {:?}",
                                        process
                                    );
                                    pending_switch = Some((process.clone(), Instant::now()));
                                }
                            }
                        }
                    }
                }
            }

            Err(_) => {
                // No active window — treat like a focus loss, subject to grace period.
                let no_window_key = String::from("__no_window__");
                match &pending_switch {
                    None => {
                        pending_switch = Some((no_window_key, Instant::now()));
                    }
                    Some((_, switched_at)) => {
                        if switched_at.elapsed().as_secs() >= grace_secs {
                            pending_switch = None;
                            if let Some(sid) = current_session_id.take() {
                                let merge_threshold = {
                                    let conn = db.lock().unwrap_or_else(|e| e.into_inner());
                                    read_setting_i64(&conn, "auto_merge_threshold").unwrap_or(120)
                                };
                                let surviving = {
                                    let conn = db.lock().unwrap_or_else(|e| e.into_inner());
                                    close_and_merge(&conn, sid, merge_threshold)
                                };
                                if let Some((surviving_id, app_name, duration)) = surviving {
                                    let _ = app.emit(
                                        "flow:session-closed",
                                        SessionClosedPayload {
                                            session_id: surviving_id,
                                            app_name,
                                            duration_secs: duration,
                                        },
                                    );
                                }
                                println!("[FlowTracker] No active window — session closed");
                            }
                            current_process = None;
                        }
                    }
                }
            }
        }

        thread::sleep(POLL_INTERVAL);
    }
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

/// Returns `true` if the application is in the whitelist with `is_enabled = 1`.
fn is_app_whitelisted(conn: &Connection, process_name: &str) -> bool {
    conn.query_row(
        "SELECT is_enabled FROM applications WHERE process_name = ?1",
        params![process_name],
        |row| row.get::<_, i64>(0),
    )
    .map(|v| v != 0)
    .unwrap_or(false)
}

/// Insert a session row and return its new ID.
///
/// As a convenience, any previously-unseen `process_name` is auto-inserted
/// into `applications` as **disabled** so it shows up in the whitelist UI
/// for the user to review.
fn open_session(conn: &Connection, process_name: &str) -> rusqlite::Result<i64> {
    // Auto-discover: insert the app as disabled if it has never been seen.
    conn.execute(
        "INSERT OR IGNORE INTO applications (name, process_name, is_enabled)
         VALUES (?1, ?1, 0)",
        params![process_name],
    )?;

    let app_id: i64 = conn.query_row(
        "SELECT id FROM applications WHERE process_name = ?1",
        params![process_name],
        |row| row.get(0),
    )?;

    conn.execute(
        "INSERT INTO sessions (app_id, start_time, status)
         VALUES (?1, ?2, 'active')",
        params![app_id, iso_now()],
    )?;

    Ok(conn.last_insert_rowid())
}

/// Set `end_time`, compute `duration` in seconds, and mark the session `'pending'`.
fn close_session(conn: &Connection, session_id: i64) {
    let now = iso_now();
    if let Err(e) = conn.execute(
        "UPDATE sessions
         SET    end_time = ?1,
                duration = CAST(
                    (julianday(?1) - julianday(start_time)) * 86400
                    AS INTEGER
                ),
                status   = 'pending'
         WHERE  id = ?2 AND end_time IS NULL",
        params![now, session_id],
    ) {
        eprintln!("[FlowTracker] Failed to close session {}: {}", session_id, e);
    }
}

/// Close a session, then attempt to merge it with the immediately preceding
/// session for the same app if the gap between them is within `threshold_secs`.
///
/// Returns `Some((surviving_id, app_name, total_duration_secs))` on success,
/// or `None` if the session could not be read after closing.
fn close_and_merge(
    conn: &Connection,
    session_id: i64,
    threshold_secs: i64,
) -> Option<(i64, String, i64)> {
    close_session(conn, session_id);

    // Read the just-closed session.
    let (app_id, app_name, start_time, end_time, duration): (i64, String, String, String, i64) =
        conn.query_row(
            "SELECT s.app_id, a.name, s.start_time, s.end_time, s.duration
             FROM   sessions s
             JOIN   applications a ON a.id = s.app_id
             WHERE  s.id = ?1",
            params![session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get::<_, i64>(4)?)),
        )
        .ok()?;

    // Look for a preceding closed session for the same app.
    let prior: Option<(i64, String, i64)> = conn
        .query_row(
            "SELECT id, end_time,
                    CAST((julianday(?2) - julianday(end_time)) * 86400 AS INTEGER) AS gap
             FROM   sessions
             WHERE  app_id  = ?1
               AND  id     != ?3
               AND  end_time IS NOT NULL
               AND  status  != 'active'
             ORDER  BY end_time DESC
             LIMIT  1",
            params![app_id, start_time, session_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?)),
        )
        .ok();

    if let Some((prior_id, _prior_end, gap)) = prior {
        if gap >= 0 && gap <= threshold_secs {
            // Merge: extend the prior session to cover new session's end_time.
            if let Err(e) = conn.execute(
                "UPDATE sessions
                 SET    end_time = ?1,
                        duration = CAST(
                            (julianday(?1) - julianday(start_time)) * 86400
                            AS INTEGER
                        ),
                        status   = 'pending'
                 WHERE  id = ?2",
                params![end_time, prior_id],
            ) {
                eprintln!("[FlowTracker] Merge update failed: {}", e);
            } else {
                // Delete the now-absorbed session.
                let _ = conn.execute("DELETE FROM sessions WHERE id = ?1", params![session_id]);
                let merged_duration: i64 = conn
                    .query_row(
                        "SELECT duration FROM sessions WHERE id = ?1",
                        params![prior_id],
                        |r| r.get(0),
                    )
                    .unwrap_or(duration);
                println!(
                    "[FlowTracker] Merged session {} into {} (gap {}s)",
                    session_id, prior_id, gap
                );
                return Some((prior_id, app_name, merged_duration));
            }
        }
    }

    Some((session_id, app_name, duration))
}

/// Read an integer setting from the `settings` table.
fn read_setting_i64(conn: &Connection, key: &str) -> Option<i64> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .and_then(|v| v.parse().ok())
}

/// Mark a session as `'idle'` without closing it (end_time stays NULL).
fn pause_session(conn: &Connection, session_id: i64) {
    if let Err(e) = conn.execute(
        "UPDATE sessions SET status = 'idle' WHERE id = ?1",
        params![session_id],
    ) {
        eprintln!("[FlowTracker] Failed to pause session {}: {}", session_id, e);
    }
}

// ---------------------------------------------------------------------------
// Timestamp helpers (chrono-free, pure std)
// ---------------------------------------------------------------------------

/// Current UTC time formatted as an ISO-8601 string (`YYYY-MM-DDTHH:MM:SSZ`).
///
/// SQLite's `date()` / `julianday()` functions understand this format directly.
fn iso_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format_iso(secs)
}

/// Convert a Unix timestamp (seconds since 1970-01-01 UTC) to an ISO-8601 string.
fn format_iso(unix_secs: u64) -> String {
    let time_secs = unix_secs % 86_400;
    let h = time_secs / 3_600;
    let m = (time_secs % 3_600) / 60;
    let s = time_secs % 60;

    // Walk forward from the Unix epoch, year by year, to find the calendar date.
    let mut remaining_days = unix_secs / 86_400;
    let mut year = 1970u32;
    loop {
        let days_in_year: u64 = if is_leap(year) { 366 } else { 365 };
        if remaining_days < days_in_year {
            break;
        }
        remaining_days -= days_in_year;
        year += 1;
    }

    let month_lengths: [u64; 12] = [
        31,
        if is_leap(year) { 29 } else { 28 },
        31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
    let mut month = 1u32;
    for &dm in &month_lengths {
        if remaining_days < dm {
            break;
        }
        remaining_days -= dm;
        month += 1;
    }
    let day = remaining_days + 1;

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, h, m, s
    )
}

fn is_leap(y: u32) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

// ---------------------------------------------------------------------------
// Platform-specific idle detection
// ---------------------------------------------------------------------------

/// Returns the number of seconds since the last keyboard or mouse event.
fn seconds_since_last_input() -> u64 {
    #[cfg(target_os = "macos")]
    {
        macos_idle_secs()
    }
    #[cfg(target_os = "windows")]
    {
        windows_idle_secs()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        0 // Unsupported platform — never considered idle.
    }
}

#[cfg(target_os = "macos")]
fn macos_idle_secs() -> u64 {
    // CGEventSourceSecondsSinceLastEventType is not wrapped by the core-graphics crate,
    // so we call the CoreGraphics C function directly via FFI.
    // CombinedSessionState = 0, MouseMoved = 5, KeyDown = 10
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state_id: i32, event_type: u32) -> f64;
    }
    let mouse = unsafe { CGEventSourceSecondsSinceLastEventType(0, 5) };
    let key   = unsafe { CGEventSourceSecondsSinceLastEventType(0, 10) };
    mouse.min(key) as u64
}

#[cfg(target_os = "windows")]
fn windows_idle_secs() -> u64 {
    use winapi::um::sysinfoapi::GetTickCount;
    use winapi::um::winuser::{GetLastInputInfo, LASTINPUTINFO};

    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    unsafe {
        GetLastInputInfo(&mut info);
        let now = GetTickCount();
        (now.wrapping_sub(info.dwTime) / 1_000) as u64
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::{format_iso, is_leap};

    #[test]
    fn is_leap_known_years() {
        assert!(is_leap(2000));
        assert!(is_leap(2024));
        assert!(!is_leap(1900));
        assert!(!is_leap(2023));
    }

    #[test]
    fn format_iso_unix_epoch() {
        assert_eq!(format_iso(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn format_iso_known_timestamp() {
        // 2024-01-15 11:54:56 UTC  →  unix = 1705319696
        // Verified: 19737 days * 86400 + 42896s (= 11h 54m 56s) = 1705319696
        assert_eq!(format_iso(1_705_319_696), "2024-01-15T11:54:56Z");
    }
}
