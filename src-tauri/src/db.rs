use rusqlite::Connection;
use std::path::{Path, PathBuf};

#[allow(dead_code)]
pub struct LocalDbState {
	pub db_path: PathBuf,
}

pub fn init_local_db() -> Result<PathBuf, String> {
	let base_dir = dirs_next::data_local_dir()
		.or_else(dirs_next::home_dir)
		.unwrap_or_else(|| PathBuf::from("."))
		.join("FlowTracker");

	std::fs::create_dir_all(&base_dir)
		.map_err(|error| format!("Failed to create local data directory: {error}"))?;

	let db_path = base_dir.join("flowtracker.sqlite3");
	let connection = open_connection(&db_path)
		.map_err(|error| format!("Failed to open SQLite database: {error}"))?;

	initialize_schema(&connection)
		.map_err(|error| format!("Failed to initialize SQLite schema: {error}"))?;

	Ok(db_path)
}

pub fn open_connection(path: &Path) -> rusqlite::Result<Connection> {
	let connection = Connection::open(path)?;
	connection.pragma_update(None, "journal_mode", "WAL")?;
	connection.pragma_update(None, "foreign_keys", "ON")?;
	Ok(connection)
}

fn initialize_schema(connection: &Connection) -> rusqlite::Result<()> {
	connection.execute_batch(
		r#"
		CREATE TABLE IF NOT EXISTS applications (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			process_name TEXT NOT NULL,
			icon TEXT,
			is_enabled INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(user_id, process_name)
		);

		CREATE TABLE IF NOT EXISTS settings (
			user_id TEXT NOT NULL,
			key TEXT NOT NULL,
			value TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY (user_id, key)
		);

		CREATE TABLE IF NOT EXISTS clients (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(user_id, name)
		);

		CREATE TABLE IF NOT EXISTS projects (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			color TEXT NOT NULL DEFAULT '#58a6ff',
			description TEXT,
			client_id INTEGER,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL
		);

		CREATE TABLE IF NOT EXISTS work_sessions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			color TEXT NOT NULL DEFAULT '#58a6ff',
			project_id INTEGER,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
		);

		CREATE TABLE IF NOT EXISTS sessions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id TEXT NOT NULL,
			app_name TEXT NOT NULL,
			process_name TEXT,
			start_time TEXT NOT NULL,
			end_time TEXT,
			duration INTEGER,
			task_name TEXT,
			status TEXT NOT NULL DEFAULT 'pending',
			work_session_id INTEGER,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (work_session_id) REFERENCES work_sessions(id) ON DELETE SET NULL
		);

		CREATE TABLE IF NOT EXISTS session_window_titles (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id INTEGER NOT NULL,
			title TEXT NOT NULL,
			seen_count INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(session_id, title),
			FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
		);

		CREATE INDEX IF NOT EXISTS idx_applications_user_name
			ON applications(user_id, name);
		CREATE INDEX IF NOT EXISTS idx_sessions_user_start_time
			ON sessions(user_id, start_time DESC);
		CREATE INDEX IF NOT EXISTS idx_sessions_user_status
			ON sessions(user_id, status);
		CREATE INDEX IF NOT EXISTS idx_projects_user_name
			ON projects(user_id, name);
		CREATE INDEX IF NOT EXISTS idx_work_sessions_user_created_at
			ON work_sessions(user_id, created_at DESC);
		"#,
	)
}
