//! Active-window watcher.
//!
//! Polls the OS for the foreground window every POLL_INTERVAL seconds.
//! Session data is stored locally in SQLite and mirrored to MongoDB best-effort
//! during the migration window.

use crate::db;
use active_win_pos_rs::get_active_window;
use mongodb::{
    bson::{doc, oid::ObjectId, Bson},
    Database,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

const POLL_INTERVAL: Duration = Duration::from_secs(5);
const IDLE_THRESHOLD_SECS: u64 = 300;

#[derive(Clone, Serialize)]
pub struct SessionClosedPayload {
    pub session_id:    String,
    pub app_name:      String,
    pub duration_secs: i64,
    /// Top window titles seen during this session (deduplicated, most-frequent first).
    pub window_titles: Vec<String>,
    /// Git branch active when the session opened (if detected).
    pub git_branch:    Option<String>,
    /// Short git commit message active when the session opened (if detected).
    pub git_commit:    Option<String>,
}

pub fn start_watcher(db: Database, db_path: PathBuf, user_id: String, app: AppHandle) {
    thread::Builder::new()
        .name("flow-watcher".into())
    .spawn(move || run(db, db_path, user_id, app))
        .expect("Failed to spawn flow-watcher thread");
}

fn run(db: Database, db_path: PathBuf, user_id: String, app: AppHandle) {
    println!("[Flow Tracker] Watcher started");

    let now = iso_now();
    if let Err(error) = db::close_stale_active_sessions(&db_path, &user_id, &now, compute_duration) {
        eprintln!("[Flow Tracker] stale-session cleanup failed: {error}");
    }

    let mut current_session_id: Option<String> = None;
    let mut current_process: Option<String> = None;
    let mut session_paused = false;
    let mut pending_switch: Option<(String, Instant)> = None;
    // title → how many ticks it was seen (for ranking)
    let mut title_counts: HashMap<String, u32> = HashMap::new();
    let mut session_git_branch: Option<String> = None;
    let mut session_git_commit: Option<String> = None;

    loop {
        let idle_secs = seconds_since_last_input();
        let is_idle = idle_secs >= IDLE_THRESHOLD_SECS;
        let grace_secs = read_setting_i64(&db_path, &user_id, "focus_grace_period")
            .unwrap_or(120).max(0) as u64;

        // Check if tracking is paused globally
        let is_paused = read_setting_bool(&db_path, &user_id, "pause_tracking");
        if is_paused {
            // If tracking is paused and we have an active session, close it
            if let Some(ref sid) = current_session_id {
                if !session_paused {
                            close_active_session(&db_path, &db, &user_id, sid);
                    session_paused = true;
                }
            }
            // Clear session state so nothing tracks while paused
            current_session_id = None;
            current_process = None;
            title_counts.clear();
            pending_switch = None;
            // Skip all tracking logic and sleep
            thread::sleep(POLL_INTERVAL);
            continue;
        } else if session_paused {
            // If we were paused but now unpaused, reset the pause flag
            session_paused = false;
        }

        match get_active_window() {
            Ok(win) => {
                let process = win.app_name.clone();
                let is_whitelisted = is_app_whitelisted(&db_path, &user_id, &process);

                // Track window title for active session.
                let title = win.title.trim().to_string();
                if !title.is_empty() && current_session_id.is_some() {
                    *title_counts.entry(title).or_insert(0) += 1;
                }

                if is_idle {
                    pending_switch = None;
                    if let Some(ref sid) = current_session_id {
                        if !session_paused {
                            pause_session(&db_path, &db, &user_id, sid);
                            session_paused = true;
                        }
                    }
                } else {
                    if session_paused {
                        if let Some(ref sid) = current_session_id {
                            resume_session(&db_path, &db, &user_id, sid);
                        }
                    }
                    session_paused = false;

                    if current_process.as_deref() == Some(&process) {
                        // Same app — cancel any pending switch.
                        if pending_switch.take().is_some() {
                            if let Some(ref sid) = current_session_id {
                                let _ = app.emit("flow:session-opened", sid.clone());
                            }
                        }
                    } else if current_session_id.is_none() && current_process.is_none() {
                        // No session running at all — open one immediately.
                        pending_switch = None;
                        if is_whitelisted {
                            if let Ok(sid) = open_session(&db_path, &db, &user_id, &process) {
                                let _ = app.emit("flow:session-opened", sid.clone());
                                current_session_id = Some(sid);
                                // Capture git context and reset title tracking for new session.
                                title_counts.clear();
                                let (branch, commit) = detect_git_context(&win.process_path);
                                session_git_branch = branch;
                                session_git_commit = commit;
                            }
                        }
                        current_process = Some(process);
                    } else {
                        // Different app detected — apply grace period.
                        let from_self = current_process.as_deref()
                            .map(|p| {
                                let lc = p.to_ascii_lowercase();
                                lc == "flowtracker" || lc == "flow-tracker" || lc == "flow tracker"
                            })
                            .unwrap_or(false);
                        let effective_grace = if from_self { 0 } else { grace_secs };

                        // Clone to avoid borrow conflicts during mutation.
                        let pending_info = pending_switch.as_ref().map(|(p, i)| (p.clone(), *i));
                        match pending_info {
                            None => {
                                if effective_grace == 0 {
                                    pending_switch = None;
                                    commit_switch(&db_path, &db, &user_id, &app, &mut current_session_id,
                                                  &mut current_process, &process, is_whitelisted,
                                                  &mut title_counts, &mut session_git_branch,
                                                  &mut session_git_commit, &win.process_path);
                                } else {
                                    pending_switch = Some((process.clone(), Instant::now()));
                                }
                            }
                            Some((ref pending_proc, switched_at)) => {
                                if pending_proc == &process {
                                    if switched_at.elapsed().as_secs() >= effective_grace {
                                        pending_switch = None;
                                        commit_switch(&db_path, &db, &user_id, &app, &mut current_session_id,
                                                      &mut current_process, &process, is_whitelisted,
                                                      &mut title_counts, &mut session_git_branch,
                                                      &mut session_git_commit, &win.process_path);
                                    }
                                    // else: still in grace — keep waiting.
                                } else {
                                    // Yet another app — reset grace timer.
                                    pending_switch = Some((process.clone(), Instant::now()));
                                }
                            }
                        }
                    }
                }
            }

            Err(_) => {
                // No active window — treat as focus loss.
                let elapsed = pending_switch.as_ref().map(|(_, i)| i.elapsed().as_secs());
                match elapsed {
                    None => {
                        pending_switch = Some(("__no_window__".into(), Instant::now()));
                    }
                    Some(e) if e >= grace_secs => {
                        pending_switch = None;
                        if let Some(sid) = current_session_id.take() {
                            let threshold = read_setting_i64(&db_path, &user_id, "auto_merge_threshold")
                                .unwrap_or(120);
                            let window_titles = top_titles(&title_counts, 8);
                            let git_branch = session_git_branch.take();
                            let git_commit = session_git_commit.take();
                            title_counts.clear();
                            if let Some((surviving_id, app_name, dur)) =
                                close_and_merge(&db_path, &db, &user_id, &sid, threshold)
                            {
                                let _ = app.emit(
                                    "flow:session-closed",
                                    SessionClosedPayload {
                                        session_id: surviving_id,
                                        app_name,
                                        duration_secs: dur,
                                        window_titles,
                                        git_branch,
                                        git_commit,
                                    },
                                );
                            }
                            println!("[Flow Tracker] No active window — session closed");
                        }
                        current_process = None;
                    }
                    Some(_) => {} // still within grace
                }
            }
        }

        thread::sleep(POLL_INTERVAL);
    }
}

fn commit_switch(
    db_path: &Path,
    db: &Database,
    user_id: &str,
    app: &AppHandle,
    current_session_id: &mut Option<String>,
    current_process: &mut Option<String>,
    new_process: &str,
    is_whitelisted: bool,
    title_counts: &mut HashMap<String, u32>,
    session_git_branch: &mut Option<String>,
    session_git_commit: &mut Option<String>,
    new_process_path: &Path,
) {
    if let Some(sid) = current_session_id.take() {
        let threshold = read_setting_i64(db_path, user_id, "auto_merge_threshold").unwrap_or(120);
        let window_titles = top_titles(title_counts, 8);
        let git_branch = session_git_branch.clone();
        let git_commit = session_git_commit.clone();
        if let Some((surviving_id, app_name, dur)) =
            close_and_merge(db_path, db, user_id, &sid, threshold)
        {
            let _ = app.emit(
                "flow:session-closed",
                SessionClosedPayload {
                    session_id: surviving_id,
                    app_name,
                    duration_secs: dur,
                    window_titles,
                    git_branch,
                    git_commit,
                },
            );
        }
    }
    // Reset context for the incoming session.
    title_counts.clear();
    let (branch, commit) = detect_git_context(new_process_path);
    *session_git_branch = branch;
    *session_git_commit = commit;

    if is_whitelisted {
        if let Ok(sid) = open_session(db_path, db, user_id, new_process) {
            let _ = app.emit("flow:session-opened", sid.clone());
            *current_session_id = Some(sid);
        }
    }
    *current_process = Some(new_process.to_string());
}

// ── Git context detection ─────────────────────────────────────────────────────

/// Walk up from the process executable path to find a `.git` directory,
/// then query branch and latest commit message.
fn detect_git_context(process_path: &Path) -> (Option<String>, Option<String>) {
    let start = process_path.parent().unwrap_or(process_path);
    let mut dir = start;
    for _ in 0..8 {
        if dir.join(".git").exists() {
            let branch = Command::new("git")
                .args(["-C", &dir.to_string_lossy(), "branch", "--show-current"])
                .output()
                .ok()
                .and_then(|o| if o.status.success() {
                    Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                } else { None })
                .filter(|s| !s.is_empty());

            let commit = Command::new("git")
                .args(["-C", &dir.to_string_lossy(), "log", "--oneline", "-1", "--format=%s"])
                .output()
                .ok()
                .and_then(|o| if o.status.success() {
                    Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                } else { None })
                .filter(|s| !s.is_empty());

            return (branch, commit);
        }
        match dir.parent() {
            Some(p) => dir = p,
            None => break,
        }
    }
    (None, None)
}

/// Return the top-N window titles sorted by frequency, filtering out noise.
fn top_titles(counts: &HashMap<String, u32>, n: usize) -> Vec<String> {
    let mut pairs: Vec<(&String, &u32)> = counts
        .iter()
        .filter(|(t, _)| {
            let lower = t.to_ascii_lowercase();
            // Skip generic/useless titles.
            !lower.is_empty()
                && lower != "flow tracker"
                && lower != "flowtracker"
                && !lower.starts_with("untitled")
        })
        .collect();
    pairs.sort_by(|a, b| b.1.cmp(a.1));
    pairs.iter().take(n).map(|(t, _)| (*t).clone()).collect()
}

// ── Storage helpers ───────────────────────────────────────────────────────────

fn is_app_whitelisted(db_path: &Path, user_id: &str, process_name: &str) -> bool {
    db::is_app_whitelisted(db_path, user_id, process_name).unwrap_or(false)
}

fn open_session(db_path: &Path, db: &Database, user_id: &str, process_name: &str) -> Result<String, String> {
    let now = iso_now();
    let public_id = db::open_session(db_path, user_id, process_name, &now)?;

    if let Ok(oid) = ObjectId::parse_str(&public_id) {
        let apps = db.collection::<mongodb::bson::Document>("applications");
        let _ = std::thread::spawn({
            let db = db.clone();
            let user_id = user_id.to_string();
            let process_name = process_name.to_string();
            let now = now.clone();
            move || {
                tauri::async_runtime::block_on(async move {
                    let _ = apps.update_one(
                        doc! { "process_name": &process_name, "user_id": &user_id },
                        doc! { "$setOnInsert": {
                            "name": &process_name,
                            "process_name": &process_name,
                            "user_id": &user_id,
                            "is_enabled": false
                        }},
                    ).upsert(true).await;

                    let sessions = db.collection::<mongodb::bson::Document>("sessions");
                    let _ = sessions.insert_one(doc! {
                        "_id": oid,
                        "user_id": &user_id,
                        "app_name": &process_name,
                        "start_time": &now,
                        "end_time": Bson::Null,
                        "duration": Bson::Null,
                        "task_name": Bson::Null,
                        "status": "active",
                        "work_session_id": Bson::Null,
                    }).await;
                });
            }
        }).join();
    }

    Ok(public_id)
}

fn close_and_merge(
    db_path: &Path,
    db: &Database,
    user_id: &str,
    session_id: &str,
    threshold_secs: i64,
) -> Option<(String, String, i64)> {
    let now = iso_now();
    let result = db::close_and_merge_session(
        db_path,
        user_id,
        session_id,
        threshold_secs,
        &now,
        parse_iso_to_secs,
        compute_duration,
    ).ok()??;

    if let Ok(oid) = ObjectId::parse_str(session_id) {
        let col = db.collection::<mongodb::bson::Document>("sessions");
        let _ = tauri::async_runtime::block_on(async {
            col.update_one(
                doc! { "_id": oid },
                doc! { "$set": { "end_time": &now, "duration": result.2, "status": "pending" } },
            ).await
        });
    }

    Some(result)
}

fn read_setting_i64(db_path: &Path, user_id: &str, key: &str) -> Option<i64> {
    db::get_setting(db_path, user_id, key).ok().flatten()?.parse().ok()
}

fn read_setting_bool(db_path: &Path, user_id: &str, key: &str) -> bool {
    db::get_setting(db_path, user_id, key)
        .ok()
        .flatten()
        .map(|v| v == "true" || v == "1")
        .unwrap_or(false)
}

fn pause_session(db_path: &Path, db: &Database, user_id: &str, session_id: &str) {
    let _ = db::update_session_status(db_path, user_id, session_id, "idle");
    if let Ok(oid) = ObjectId::parse_str(session_id) {
        let col = db.collection::<mongodb::bson::Document>("sessions");
        let _ = tauri::async_runtime::block_on(async {
            col.update_one(doc! { "_id": oid }, doc! { "$set": { "status": "idle" } }).await
        });
    }
}

fn close_active_session(db_path: &Path, db: &Database, user_id: &str, session_id: &str) {
    let now = iso_now();
    let _ = db::close_session(db_path, user_id, session_id, &now, "closed", compute_duration);
    if let Ok(oid) = ObjectId::parse_str(session_id) {
        let col = db.collection::<mongodb::bson::Document>("sessions");
        let _ = tauri::async_runtime::block_on(async {
            if let Ok(Some(doc)) = col.find_one(doc! { "_id": oid }).await {
                if let Ok(start) = doc.get_str("start_time") {
                    let duration = compute_duration(start, &now).max(0);
                    let _ = col.update_one(
                        doc! { "_id": oid },
                        doc! { "$set": { "end_time": &now, "duration": duration, "status": "closed" } },
                    ).await;
                }
            }
            Ok::<(), ()>(())
        });
    }
}

fn resume_session(db_path: &Path, db: &Database, user_id: &str, session_id: &str) {
    let _ = db::update_session_status(db_path, user_id, session_id, "active");
    if let Ok(oid) = ObjectId::parse_str(session_id) {
        let col = db.collection::<mongodb::bson::Document>("sessions");
        let _ = tauri::async_runtime::block_on(async {
            col.update_one(
                doc! { "_id": oid, "status": "idle" },
                doc! { "$set": { "status": "active" } },
            ).await
        });
    }
}

// ── Timestamp helpers ──────────────────────────────────────────────────────────

pub fn iso_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format_iso(secs)
}

fn format_iso(unix_secs: u64) -> String {
    let time_secs = unix_secs % 86_400;
    let h = time_secs / 3_600;
    let m = (time_secs % 3_600) / 60;
    let s = time_secs % 60;

    let mut remaining_days = unix_secs / 86_400;
    let mut year = 1970u32;
    loop {
        let days_in_year = if is_leap(year) { 366u64 } else { 365u64 };
        if remaining_days < days_in_year { break; }
        remaining_days -= days_in_year;
        year += 1;
    }
    let month_lengths: [u64; 12] = [
        31, if is_leap(year) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
    let mut month = 1u32;
    for &dm in &month_lengths {
        if remaining_days < dm { break; }
        remaining_days -= dm;
        month += 1;
    }
    let day = remaining_days + 1;
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", year, month, day, h, m, s)
}

pub fn parse_iso_to_secs(s: &str) -> u64 {
    let s = s.trim_end_matches('Z');
    let mut it = s.splitn(2, 'T');
    let date_part = it.next().unwrap_or("");
    let time_part = it.next().unwrap_or("");
    let dp: Vec<u32> = date_part.split('-').filter_map(|x| x.parse().ok()).collect();
    let tp: Vec<u64> = time_part.split(':').filter_map(|x| x.parse().ok()).collect();
    if dp.len() < 3 || tp.len() < 3 { return 0; }
    let (y, mo, d) = (dp[0], dp[1], dp[2] as u64);
    let (h, mi, sec) = (tp[0], tp[1], tp[2]);
    let mut days = 0u64;
    for yr in 1970..y { days += if is_leap(yr) { 366 } else { 365 }; }
    let ml: [u64; 12] = [
        31, if is_leap(y) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
    for i in 0..(mo as usize - 1) { days += ml[i]; }
    days += d - 1;
    days * 86400 + h * 3600 + mi * 60 + sec
}

pub(crate) fn compute_duration(start: &str, end: &str) -> i64 {
    parse_iso_to_secs(end) as i64 - parse_iso_to_secs(start) as i64
}

fn is_leap(y: u32) -> bool { (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 }

// ── Platform idle detection ────────────────────────────────────────────────────

fn seconds_since_last_input() -> u64 {
    #[cfg(target_os = "macos")] { macos_idle_secs() }
    #[cfg(target_os = "windows")] { windows_idle_secs() }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))] { 0 }
}

#[cfg(target_os = "macos")]
fn macos_idle_secs() -> u64 {
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
        (GetTickCount().wrapping_sub(info.dwTime) / 1_000) as u64
    }
}

#[cfg(test)]
mod tests {
    use super::{format_iso, is_leap};
    #[test] fn is_leap_known_years() {
        assert!(is_leap(2000)); assert!(is_leap(2024));
        assert!(!is_leap(1900)); assert!(!is_leap(2023));
    }
    #[test] fn format_iso_unix_epoch() { assert_eq!(format_iso(0), "1970-01-01T00:00:00Z"); }
    #[test] fn format_iso_known_timestamp() {
        assert_eq!(format_iso(1_705_319_696), "2024-01-15T11:54:56Z");
    }
}
