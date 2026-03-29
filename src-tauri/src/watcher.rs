//! Active-window watcher — MongoDB-only.
//!
//! Polls the OS for the foreground window every POLL_INTERVAL seconds.
//! All session data is written directly to MongoDB Atlas.

use active_win_pos_rs::get_active_window;
use mongodb::{
    bson::{doc, oid::ObjectId, Bson},
    Database,
};
use serde::Serialize;
use std::{
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

const POLL_INTERVAL: Duration = Duration::from_secs(5);
const IDLE_THRESHOLD_SECS: u64 = 300;

#[derive(Clone, Serialize)]
pub struct SessionClosedPayload {
    pub session_id: String,
    pub app_name: String,
    pub duration_secs: i64,
}

pub fn start_watcher(db: Database, app: AppHandle) {
    thread::Builder::new()
        .name("flow-watcher".into())
        .spawn(move || run(db, app))
        .expect("Failed to spawn flow-watcher thread");
}

fn run(db: Database, app: AppHandle) {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("watcher runtime");

    println!("[Flow Tracker] Watcher started (MongoDB-only)");

    // Close any sessions left active from a previous crash.
    rt.block_on(async {
        let col = db.collection::<mongodb::bson::Document>("sessions");
        let now = iso_now();
        let mut cursor = match col.find(doc! { "status": "active" }).await {
            Ok(c) => c,
            Err(e) => { eprintln!("[Flow Tracker] stale-session query failed: {e}"); return; }
        };
        let mut stale: Vec<(ObjectId, String)> = vec![];
        while cursor.advance().await.unwrap_or(false) {
            if let Ok(d) = cursor.deserialize_current() {
                if let Ok(oid) = d.get_object_id("_id") {
                    let start = d.get_str("start_time").unwrap_or("").to_string();
                    stale.push((oid, start));
                }
            }
        }
        for (oid, start) in stale {
            let dur = compute_duration(&start, &now);
            let _ = col.update_one(
                doc! { "_id": oid },
                doc! { "$set": { "end_time": &now, "duration": dur, "status": "pending" } },
            ).await;
        }
    });

    let mut current_session_id: Option<String> = None;
    let mut current_process: Option<String> = None;
    let mut session_paused = false;
    let mut pending_switch: Option<(String, Instant)> = None;

    loop {
        let idle_secs = seconds_since_last_input();
        let is_idle = idle_secs >= IDLE_THRESHOLD_SECS;
        let grace_secs = rt.block_on(read_setting_i64(&db, "focus_grace_period"))
            .unwrap_or(120).max(0) as u64;

        match get_active_window() {
            Ok(win) => {
                let process = win.app_name.clone();
                let is_whitelisted = rt.block_on(is_app_whitelisted(&db, &process));

                if is_idle {
                    pending_switch = None;
                    if let Some(ref sid) = current_session_id {
                        if !session_paused {
                            rt.block_on(pause_session(&db, sid));
                            session_paused = true;
                        }
                    }
                } else {
                    if session_paused {
                        if let Some(ref sid) = current_session_id {
                            rt.block_on(resume_session(&db, sid));
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
                            if let Ok(sid) = rt.block_on(open_session(&db, &process)) {
                                let _ = app.emit("flow:session-opened", sid.clone());
                                current_session_id = Some(sid);
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
                                    commit_switch(&rt, &db, &app, &mut current_session_id,
                                                  &mut current_process, &process, is_whitelisted);
                                } else {
                                    pending_switch = Some((process.clone(), Instant::now()));
                                }
                            }
                            Some((ref pending_proc, switched_at)) => {
                                if pending_proc == &process {
                                    if switched_at.elapsed().as_secs() >= effective_grace {
                                        pending_switch = None;
                                        commit_switch(&rt, &db, &app, &mut current_session_id,
                                                      &mut current_process, &process, is_whitelisted);
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
                            let threshold = rt.block_on(read_setting_i64(&db, "auto_merge_threshold"))
                                .unwrap_or(120);
                            if let Some((surviving_id, app_name, dur)) =
                                rt.block_on(close_and_merge(&db, &sid, threshold))
                            {
                                let _ = app.emit(
                                    "flow:session-closed",
                                    SessionClosedPayload {
                                        session_id: surviving_id,
                                        app_name,
                                        duration_secs: dur,
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
    rt: &tokio::runtime::Runtime,
    db: &Database,
    app: &AppHandle,
    current_session_id: &mut Option<String>,
    current_process: &mut Option<String>,
    new_process: &str,
    is_whitelisted: bool,
) {
    if let Some(sid) = current_session_id.take() {
        let threshold = rt.block_on(read_setting_i64(db, "auto_merge_threshold")).unwrap_or(120);
        if let Some((surviving_id, app_name, dur)) =
            rt.block_on(close_and_merge(db, &sid, threshold))
        {
            let _ = app.emit(
                "flow:session-closed",
                SessionClosedPayload {
                    session_id: surviving_id,
                    app_name,
                    duration_secs: dur,
                },
            );
        }
    }
    if is_whitelisted {
        if let Ok(sid) = rt.block_on(open_session(db, new_process)) {
            let _ = app.emit("flow:session-opened", sid.clone());
            *current_session_id = Some(sid);
        }
    }
    *current_process = Some(new_process.to_string());
}

// ── MongoDB helpers ────────────────────────────────────────────────────────────

async fn is_app_whitelisted(db: &Database, process_name: &str) -> bool {
    let col = db.collection::<mongodb::bson::Document>("applications");
    col.find_one(doc! { "process_name": process_name, "is_enabled": true })
        .await
        .unwrap_or(None)
        .is_some()
}

async fn open_session(db: &Database, process_name: &str) -> Result<String, String> {
    // Auto-discover: insert the app as disabled if never seen before.
    let apps = db.collection::<mongodb::bson::Document>("applications");
    apps.update_one(
        doc! { "process_name": process_name },
        doc! { "$setOnInsert": {
            "name": process_name,
            "process_name": process_name,
            "is_enabled": false
        }},
    )
    .upsert(true)
    .await
    .map_err(|e| e.to_string())?;

    let sessions = db.collection::<mongodb::bson::Document>("sessions");
    let result = sessions
        .insert_one(doc! {
            "app_name":       process_name,
            "start_time":     iso_now(),
            "end_time":       Bson::Null,
            "duration":       Bson::Null,
            "task_name":      Bson::Null,
            "status":         "active",
            "work_session_id": Bson::Null,
        })
        .await
        .map_err(|e| e.to_string())?;

    result
        .inserted_id
        .as_object_id()
        .map(|o| o.to_hex())
        .ok_or_else(|| "Failed to get inserted ObjectId".to_string())
}

async fn close_and_merge(
    db: &Database,
    session_id: &str,
    threshold_secs: i64,
) -> Option<(String, String, i64)> {
    let oid = ObjectId::parse_str(session_id).ok()?;
    let col = db.collection::<mongodb::bson::Document>("sessions");
    let now = iso_now();

    let session_doc = col.find_one(doc! { "_id": oid }).await.ok()??;
    let app_name = session_doc.get_str("app_name").ok()?.to_string();
    let start_time = session_doc.get_str("start_time").ok()?.to_string();
    let duration = compute_duration(&start_time, &now);

    // Close this session.
    let _ = col
        .update_one(
            doc! { "_id": oid, "end_time": Bson::Null },
            doc! { "$set": { "end_time": &now, "duration": duration, "status": "pending" } },
        )
        .await;

    // Look for a preceding session of the same app to potentially merge with.
    let mut prior_cursor = match col
        .find(doc! {
            "app_name": &app_name,
            "_id":      { "$ne": oid },
            "end_time": { "$ne": Bson::Null },
            "status":   { "$ne": "active" },
        })
        .sort(doc! { "end_time": -1_i32 })
        .limit(1_i64)
        .await
    {
        Ok(c) => c,
        Err(_) => return Some((session_id.to_string(), app_name, duration)),
    };

    if prior_cursor.advance().await.unwrap_or(false) {
        if let Ok(prior_doc) = prior_cursor.deserialize_current() {
            if let Ok(prior_oid) = prior_doc.get_object_id("_id") {
                let prior_end = prior_doc.get_str("end_time").unwrap_or("").to_string();
                let prior_start = prior_doc.get_str("start_time").unwrap_or("").to_string();
                let gap = parse_iso_to_secs(&start_time) as i64
                    - parse_iso_to_secs(&prior_end) as i64;
                if gap >= 0 && gap <= threshold_secs {
                    let merged_dur = if prior_start.is_empty() {
                        duration
                    } else {
                        compute_duration(&prior_start, &now)
                    };
                    let _ = col
                        .update_one(
                            doc! { "_id": prior_oid },
                            doc! { "$set": { "end_time": &now, "duration": merged_dur, "status": "pending" } },
                        )
                        .await;
                    let _ = col.delete_one(doc! { "_id": oid }).await;
                    println!(
                        "[Flow Tracker] Merged {} into {} (gap {}s)",
                        session_id,
                        prior_oid.to_hex(),
                        gap
                    );
                    return Some((prior_oid.to_hex(), app_name, merged_dur));
                }
            }
        }
    }

    Some((session_id.to_string(), app_name, duration))
}

async fn read_setting_i64(db: &Database, key: &str) -> Option<i64> {
    let col = db.collection::<mongodb::bson::Document>("settings");
    let doc = col.find_one(doc! { "_id": key }).await.ok()??;
    doc.get_str("value").ok()?.parse().ok()
}

async fn pause_session(db: &Database, session_id: &str) {
    if let Ok(oid) = ObjectId::parse_str(session_id) {
        let col = db.collection::<mongodb::bson::Document>("sessions");
        let _ = col
            .update_one(doc! { "_id": oid }, doc! { "$set": { "status": "idle" } })
            .await;
    }
}

async fn resume_session(db: &Database, session_id: &str) {
    if let Ok(oid) = ObjectId::parse_str(session_id) {
        let col = db.collection::<mongodb::bson::Document>("sessions");
        let _ = col
            .update_one(
                doc! { "_id": oid, "status": "idle" },
                doc! { "$set": { "status": "active" } },
            )
            .await;
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

fn compute_duration(start: &str, end: &str) -> i64 {
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
