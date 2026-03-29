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

        -- Clients: organisations or individuals that projects belong to.
        CREATE TABLE IF NOT EXISTS clients (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT    NOT NULL UNIQUE,
            created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        );

        -- Projects: user-defined labels that can be attached to work sessions.
        CREATE TABLE IF NOT EXISTS projects (
            id    INTEGER PRIMARY KEY AUTOINCREMENT,
            name  TEXT    NOT NULL,
            color TEXT    NOT NULL DEFAULT '#6affc9'
        );

        -- Work sessions: user-defined named time blocks grouping multiple app sessions.
        CREATE TABLE IF NOT EXISTS work_sessions (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT    NOT NULL,
            color      TEXT    NOT NULL DEFAULT '#58a6ff',
            start_time TEXT    NOT NULL,
            end_time   TEXT,
            created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        );

        -- Seed default settings (no-op if they already exist).
        INSERT OR IGNORE INTO settings (key, value) VALUES
            ('idle_timeout',          '300'),
            ('auto_merge_threshold',  '120'),
            ('theme',                 'dark');
        ",
    )?;

    // Add work_session_id FK column to sessions — SQLite errors if the column
    // already exists, so we swallow that specific "duplicate column name" error.
    if let Err(e) = conn.execute(
        "ALTER TABLE sessions ADD COLUMN work_session_id INTEGER REFERENCES work_sessions(id)",
        [],
    ) {
        if !e.to_string().contains("duplicate column name") {
            return Err(e);
        }
    }

    // Add project_id FK column to work_sessions (nullable reference to projects).
    if let Err(e) = conn.execute(
        "ALTER TABLE work_sessions ADD COLUMN project_id INTEGER REFERENCES projects(id)",
        [],
    ) {
        if !e.to_string().contains("duplicate column name") {
            return Err(e);
        }
    }

    // Add description column to projects.
    let _ = conn.execute("ALTER TABLE projects ADD COLUMN description TEXT", []);
    // Add client_id FK column to projects.
    let _ = conn.execute(
        "ALTER TABLE projects ADD COLUMN client_id INTEGER REFERENCES clients(id)",
        [],
    );

    Ok(())
}
