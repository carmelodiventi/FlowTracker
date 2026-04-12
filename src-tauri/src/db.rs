use rusqlite::Connection;
use rusqlite::{params, OptionalExtension};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct DbApplication {
	pub id: String,
	pub name: String,
	pub process_name: String,
	pub icon: Option<String>,
	pub is_enabled: bool,
}

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

pub fn list_applications(path: &Path, user_id: &str) -> Result<Vec<DbApplication>, String> {
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	let mut statement = connection
		.prepare(
			r#"
			SELECT id, name, process_name, icon, is_enabled
			FROM applications
			WHERE user_id = ?1
			ORDER BY name COLLATE NOCASE ASC
			"#,
		)
		.map_err(|error| error.to_string())?;

	let rows = statement
		.query_map([user_id], |row| {
			Ok(DbApplication {
				id: row.get::<_, i64>(0)?.to_string(),
				name: row.get(1)?,
				process_name: row.get(2)?,
				icon: row.get(3)?,
				is_enabled: row.get::<_, i64>(4)? != 0,
			})
		})
		.map_err(|error| error.to_string())?;

	rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

pub fn upsert_application(
	path: &Path,
	user_id: &str,
	name: &str,
	process_name: &str,
	icon: Option<&str>,
	is_enabled: bool,
) -> Result<String, String> {
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	connection
		.execute(
			r#"
			INSERT INTO applications (user_id, name, process_name, icon, is_enabled)
			VALUES (?1, ?2, ?3, ?4, ?5)
			ON CONFLICT(user_id, process_name) DO UPDATE SET
				name = excluded.name,
				icon = COALESCE(excluded.icon, applications.icon),
				is_enabled = excluded.is_enabled,
				updated_at = CURRENT_TIMESTAMP
			"#,
			params![user_id, name, process_name, icon, if is_enabled { 1 } else { 0 }],
		)
		.map_err(|error| error.to_string())?;

	connection
		.query_row(
			"SELECT id FROM applications WHERE user_id = ?1 AND process_name = ?2",
			params![user_id, process_name],
			|row| row.get::<_, i64>(0),
		)
		.map(|id| id.to_string())
		.map_err(|error| error.to_string())
}

pub fn toggle_application(path: &Path, user_id: &str, id: &str, enabled: bool) -> Result<(), String> {
	let application_id = id.parse::<i64>().map_err(|error| format!("Invalid SQLite application id '{id}': {error}"))?;
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	let updated = connection
		.execute(
			r#"
			UPDATE applications
			SET is_enabled = ?1,
				updated_at = CURRENT_TIMESTAMP
			WHERE id = ?2 AND user_id = ?3
			"#,
			params![if enabled { 1 } else { 0 }, application_id, user_id],
		)
		.map_err(|error| error.to_string())?;

	if updated == 0 {
		Err("Application not found".to_string())
	} else {
		Ok(())
	}
}

pub fn sync_running_applications(path: &Path, user_id: &str, names: &[String]) -> Result<Vec<DbApplication>, String> {
	let mut applications = list_applications(path, user_id)?;

	if !names.is_empty() {
		let connection = open_connection(path).map_err(|error| error.to_string())?;
		let tx = connection.unchecked_transaction().map_err(|error| error.to_string())?;

		for application in &applications {
			if !application.is_enabled && !names.iter().any(|name| name == &application.process_name) {
				tx.execute(
					"DELETE FROM applications WHERE id = ?1 AND user_id = ?2",
					params![application.id, user_id],
				)
				.map_err(|error| error.to_string())?;
			}
		}

		for name in names {
			tx.execute(
				r#"
				INSERT INTO applications (user_id, name, process_name, is_enabled)
				VALUES (?1, ?2, ?3, 0)
				ON CONFLICT(user_id, process_name) DO UPDATE SET
					name = excluded.name,
					updated_at = CURRENT_TIMESTAMP
				"#,
				params![user_id, name, name],
			)
			.map_err(|error| error.to_string())?;
		}

		tx.commit().map_err(|error| error.to_string())?;
		applications = list_applications(path, user_id)?;
	}

	Ok(applications)
}

pub fn get_setting(path: &Path, user_id: &str, key: &str) -> Result<Option<String>, String> {
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	connection
		.query_row(
			"SELECT value FROM settings WHERE user_id = ?1 AND key = ?2",
			params![user_id, key],
			|row| row.get::<_, String>(0),
		)
		.optional()
		.map_err(|error| error.to_string())
}

pub fn set_setting(path: &Path, user_id: &str, key: &str, value: &str) -> Result<(), String> {
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	connection
		.execute(
			r#"
			INSERT INTO settings (user_id, key, value)
			VALUES (?1, ?2, ?3)
			ON CONFLICT(user_id, key) DO UPDATE SET
				value = excluded.value,
				updated_at = CURRENT_TIMESTAMP
			"#,
			params![user_id, key, value],
		)
		.map(|_| ())
		.map_err(|error| error.to_string())
}
