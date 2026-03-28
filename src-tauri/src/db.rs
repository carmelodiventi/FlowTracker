//! Database access — open / create the local SQLite database and run schema migrations.
//!
//! All data stays on-device; no network calls are made here or anywhere in this crate.

use rusqlite::{Connection, Result};
use std::path::PathBuf;

/// Returns the path to the SQLite database file.
///
/// | Platform        | Path                                                       |
/// |-----------------|------------------------------------------------------------|
/// | macOS / Linux   | `~/.local/share/flowtracker/flowtracker.db`                |
/// | Windows         | `%APPDATA%\flowtracker\flowtracker.db`                     |
pub fn db_path() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("flowtracker").join("flowtracker.db")
}

/// Open (or create) the database, run schema migrations, and return the connection.
pub fn open_db() -> Result<Connection> {
    let path = db_path();
    // Ensure the parent directory exists before opening the file.
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let conn = Connection::open(&path)?;
    init_schema(&conn)?;
    Ok(conn)
}

/// Apply the schema (idempotent — uses `CREATE TABLE IF NOT EXISTS`).
fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS applications (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            name         TEXT    NOT NULL,
            process_name TEXT    NOT NULL UNIQUE,
            icon         TEXT,
            is_enabled   INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            app_id     INTEGER NOT NULL REFERENCES applications(id),
            start_time TEXT    NOT NULL,
            end_time   TEXT,
            duration   INTEGER,
            task_name  TEXT,
            status     TEXT NOT NULL DEFAULT 'pending'
        );

        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        -- Seed default settings (no-op if they already exist).
        INSERT OR IGNORE INTO settings (key, value) VALUES
            ('idle_timeout',          '300'),
            ('auto_merge_threshold',  '120'),
            ('theme',                 'dark');
        ",
    )
}
