use rusqlite::Connection;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct DbApplication {
	pub id: String,
	pub name: String,
	pub process_name: String,
	pub icon: Option<String>,
	pub is_enabled: bool,
}

#[derive(Clone, Debug)]
pub struct DbSession {
	pub id: String,
	pub app_name: String,
	pub start_time: String,
	pub end_time: Option<String>,
	pub duration: Option<i64>,
	pub task_name: Option<String>,
	pub status: String,
	pub work_session_id: Option<String>,
}

#[derive(Clone, Debug)]
pub struct DbAppSummary {
	pub app_name: String,
	pub total_secs: i64,
	pub session_count: i64,
}

#[derive(Clone, Debug)]
pub struct DbClient {
	pub id: String,
	pub name: String,
}

#[derive(Clone, Debug)]
pub struct DbProject {
	pub id: String,
	pub name: String,
	pub color: String,
}

#[derive(Clone, Debug)]
pub struct DbProjectDetail {
	pub id: String,
	pub name: String,
	pub color: String,
	pub description: Option<String>,
	pub client_id: Option<String>,
	pub client_name: Option<String>,
}

#[derive(Clone, Debug)]
pub struct DbWorkSession {
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
pub struct BackupPayload {
	pub schema_version: u32,
	pub exported_at: String,
	pub user_id: String,
	pub settings: Vec<BackupSetting>,
	pub applications: Vec<BackupApplication>,
	pub clients: Vec<BackupClient>,
	pub projects: Vec<BackupProject>,
	pub work_sessions: Vec<BackupWorkSession>,
	pub sessions: Vec<BackupSession>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupSetting {
	pub key: String,
	pub value: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupApplication {
	pub name: String,
	pub process_name: String,
	pub icon: Option<String>,
	pub is_enabled: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupClient {
	pub id: i64,
	pub name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupProject {
	pub id: i64,
	pub name: String,
	pub color: String,
	pub description: Option<String>,
	pub client_id: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupWorkSession {
	pub id: i64,
	pub name: String,
	pub color: String,
	pub project_id: Option<i64>,
	pub created_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupSession {
	pub public_id: String,
	pub app_name: String,
	pub process_name: Option<String>,
	pub start_time: String,
	pub end_time: Option<String>,
	pub duration: Option<i64>,
	pub task_name: Option<String>,
	pub status: String,
	pub work_session_id: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct BackupImportSummary {
	pub settings: usize,
	pub applications: usize,
	pub clients: usize,
	pub projects: usize,
	pub work_sessions: usize,
	pub sessions: usize,
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

	apply_migrations(&connection)
		.map_err(|error| format!("Failed to apply SQLite migrations: {error}"))?;

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
			public_id TEXT UNIQUE,
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
		CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_public_id
			ON sessions(public_id);
		CREATE INDEX IF NOT EXISTS idx_projects_user_name
			ON projects(user_id, name);
		CREATE INDEX IF NOT EXISTS idx_work_sessions_user_created_at
			ON work_sessions(user_id, created_at DESC);
		"#,
	)
}

fn apply_migrations(connection: &Connection) -> rusqlite::Result<()> {
	if !has_column(connection, "sessions", "public_id")? {
		connection.execute("ALTER TABLE sessions ADD COLUMN public_id TEXT", [])?;
	}

	connection.execute(
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_public_id ON sessions(public_id)",
		[],
	)?;

	let mut statement = connection.prepare("SELECT id FROM sessions WHERE public_id IS NULL OR public_id = ''")?;
	let rows = statement.query_map([], |row| row.get::<_, i64>(0))?;
	for row in rows {
		let id = row?;
		connection.execute(
			"UPDATE sessions SET public_id = ?1 WHERE id = ?2",
			params![generate_public_id(), id],
		)?;
	}

	Ok(())
}

fn has_column(connection: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
	let pragma = format!("PRAGMA table_info({table})");
	let mut statement = connection.prepare(&pragma)?;
	let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
	for row in rows {
		if row?.eq_ignore_ascii_case(column) {
			return Ok(true);
		}
	}
	Ok(false)
}

pub fn generate_public_id() -> String {
	Uuid::new_v4().simple().to_string()[..24].to_string()
}

fn db_session_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DbSession> {
	Ok(DbSession {
		id: row.get(0)?,
		app_name: row.get(1)?,
		start_time: row.get(2)?,
		end_time: row.get(3)?,
		duration: row.get(4)?,
		task_name: row.get(5)?,
		status: row.get(6)?,
		work_session_id: row.get::<_, Option<i64>>(7)?.map(|id| id.to_string()),
	})
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

pub fn upsert_session_record(
	path: &Path,
	user_id: &str,
	public_id: &str,
	app_name: &str,
	process_name: Option<&str>,
	start_time: &str,
	end_time: Option<&str>,
	duration: Option<i64>,
	task_name: Option<&str>,
	status: &str,
	work_session_id: Option<&str>,
) -> Result<(), String> {
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	connection.execute(
		r#"
		INSERT INTO sessions (
			public_id, user_id, app_name, process_name, start_time, end_time,
			duration, task_name, status, work_session_id
		)
		VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
		ON CONFLICT(public_id) DO UPDATE SET
			app_name = excluded.app_name,
			process_name = COALESCE(excluded.process_name, sessions.process_name),
			start_time = excluded.start_time,
			end_time = excluded.end_time,
			duration = excluded.duration,
			task_name = excluded.task_name,
			status = excluded.status,
			work_session_id = excluded.work_session_id,
			updated_at = CURRENT_TIMESTAMP
		"#,
		params![
			public_id,
			user_id,
			app_name,
			process_name,
			start_time,
			end_time,
			duration,
			task_name,
			status,
			work_session_id,
		],
	).map(|_| ()).map_err(|error| error.to_string())
}

pub fn list_sessions_for_date(path: &Path, user_id: &str, date: &str) -> Result<Vec<DbSession>, String> {
	let start = format!("{}T00:00:00Z", date);
	let end = format!("{}T23:59:59Z", date);
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	let mut statement = connection.prepare(
		r#"
		SELECT public_id, app_name, start_time, end_time, duration, task_name, status, work_session_id
		FROM sessions
		WHERE user_id = ?1 AND start_time >= ?2 AND start_time <= ?3
		ORDER BY start_time DESC
		"#,
	).map_err(|error| error.to_string())?;
	let rows = statement.query_map(params![user_id, start, end], db_session_from_row)
		.map_err(|error| error.to_string())?;
	rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

pub fn list_pending_sessions(path: &Path, user_id: &str) -> Result<Vec<DbSession>, String> {
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	let mut statement = connection.prepare(
		r#"
		SELECT public_id, app_name, start_time, end_time, duration, task_name, status, work_session_id
		FROM sessions
		WHERE user_id = ?1 AND status = 'pending' AND end_time IS NOT NULL
		ORDER BY start_time DESC
		LIMIT 20
		"#,
	).map_err(|error| error.to_string())?;
	let rows = statement.query_map([user_id], db_session_from_row).map_err(|error| error.to_string())?;
	rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

pub fn get_session_by_public_id(path: &Path, user_id: &str, public_id: &str) -> Result<Option<DbSession>, String> {
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	connection.query_row(
		r#"
		SELECT public_id, app_name, start_time, end_time, duration, task_name, status, work_session_id
		FROM sessions
		WHERE user_id = ?1 AND public_id = ?2
		"#,
		params![user_id, public_id],
		db_session_from_row,
	).optional().map_err(|error| error.to_string())
}

pub fn get_active_session(path: &Path, user_id: &str) -> Result<Option<DbSession>, String> {
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	connection.query_row(
		r#"
		SELECT public_id, app_name, start_time, end_time, duration, task_name, status, work_session_id
		FROM sessions
		WHERE user_id = ?1 AND status = 'active'
		ORDER BY start_time DESC
		LIMIT 1
		"#,
		[user_id],
		db_session_from_row,
	).optional().map_err(|error| error.to_string())
}

pub fn close_stale_active_sessions(path: &Path, user_id: &str, now: &str, compute_duration: impl Fn(&str, &str) -> i64) -> Result<Vec<(String, i64)>, String> {
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	let mut statement = connection.prepare(
		"SELECT public_id, start_time FROM sessions WHERE user_id = ?1 AND status = 'active'"
	).map_err(|error| error.to_string())?;
	let rows = statement.query_map([user_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
		.map_err(|error| error.to_string())?;

	let mut closed = Vec::new();
	for row in rows {
		let (public_id, start_time) = row.map_err(|error| error.to_string())?;
		let duration = compute_duration(&start_time, now);
		connection.execute(
			"UPDATE sessions SET end_time = ?1, duration = ?2, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE public_id = ?3 AND user_id = ?4",
			params![now, duration, public_id, user_id],
		).map_err(|error| error.to_string())?;
		closed.push((public_id, duration));
	}
	Ok(closed)
}

pub fn is_app_whitelisted(path: &Path, user_id: &str, process_name: &str) -> Result<bool, String> {
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	let found = connection.query_row(
		"SELECT 1 FROM applications WHERE user_id = ?1 AND process_name = ?2 AND is_enabled = 1 LIMIT 1",
		params![user_id, process_name],
		|_| Ok(()),
	).optional().map_err(|error| error.to_string())?;
	Ok(found.is_some())
}

pub fn insert_manual_session(
	path: &Path,
	user_id: &str,
	app_name: &str,
	start_time: &str,
	end_time: &str,
	duration: i64,
	task_name: Option<&str>,
) -> Result<String, String> {
	let public_id = generate_public_id();
	let connection = open_connection(path).map_err(|e| e.to_string())?;
	connection.execute(
		r#"
		INSERT INTO sessions (public_id, user_id, app_name, start_time, end_time, duration, task_name, status)
		VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'confirmed')
		"#,
		params![public_id, user_id, app_name, start_time, end_time, duration, task_name],
	).map_err(|e| e.to_string())?;
	Ok(public_id)
}

pub fn open_session(path: &Path, user_id: &str, process_name: &str, now: &str) -> Result<String, String> {
	let public_id = generate_public_id();
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	connection.execute(
		r#"
		INSERT INTO applications (user_id, name, process_name, is_enabled)
		VALUES (?1, ?2, ?3, 0)
		ON CONFLICT(user_id, process_name) DO UPDATE SET
			name = excluded.name,
			updated_at = CURRENT_TIMESTAMP
		"#,
		params![user_id, process_name, process_name],
	).map_err(|error| error.to_string())?;
	connection.execute(
		r#"
		INSERT INTO sessions (public_id, user_id, app_name, process_name, start_time, status)
		VALUES (?1, ?2, ?3, ?4, ?5, 'active')
		"#,
		params![public_id, user_id, process_name, process_name, now],
	).map_err(|error| error.to_string())?;
	Ok(public_id)
}

pub fn update_session_status(path: &Path, user_id: &str, public_id: &str, status: &str) -> Result<(), String> {
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	connection.execute(
		"UPDATE sessions SET status = ?1, updated_at = CURRENT_TIMESTAMP WHERE public_id = ?2 AND user_id = ?3",
		params![status, public_id, user_id],
	).map(|_| ()).map_err(|error| error.to_string())
}

pub fn close_session(path: &Path, user_id: &str, public_id: &str, now: &str, status: &str, compute_duration: impl Fn(&str, &str) -> i64) -> Result<Option<DbSession>, String> {
	let session = get_session_by_public_id(path, user_id, public_id)?;
	let Some(session) = session else { return Ok(None); };
	let duration = compute_duration(&session.start_time, now).max(0);
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	connection.execute(
		"UPDATE sessions SET end_time = ?1, duration = ?2, status = ?3, updated_at = CURRENT_TIMESTAMP WHERE public_id = ?4 AND user_id = ?5",
		params![now, duration, status, public_id, user_id],
	).map_err(|error| error.to_string())?;
	get_session_by_public_id(path, user_id, public_id)
		.map(|session| session.map(|mut session| { session.duration = Some(duration); session.status = status.to_string(); session.end_time = Some(now.to_string()); session }))
}

pub fn close_and_merge_session(
	path: &Path,
	user_id: &str,
	public_id: &str,
	threshold_secs: i64,
	now: &str,
	parse_iso_to_secs: impl Fn(&str) -> u64,
	compute_duration: impl Fn(&str, &str) -> i64,
) -> Result<Option<(String, String, i64)>, String> {
	let session = get_session_by_public_id(path, user_id, public_id)?;
	let Some(session) = session else { return Ok(None); };
	let duration = compute_duration(&session.start_time, now).max(0);
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	connection.execute(
		"UPDATE sessions SET end_time = ?1, duration = ?2, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE public_id = ?3 AND user_id = ?4",
		params![now, duration, public_id, user_id],
	).map_err(|error| error.to_string())?;

	let mut statement = connection.prepare(
		r#"
		SELECT public_id, app_name, start_time, end_time, duration, task_name, status, work_session_id
		FROM sessions
		WHERE user_id = ?1 AND app_name = ?2 AND public_id != ?3 AND end_time IS NOT NULL AND status != 'active'
		ORDER BY end_time DESC
		LIMIT 1
		"#,
	).map_err(|error| error.to_string())?;
	let prior = statement.query_row(params![user_id, session.app_name, public_id], db_session_from_row)
		.optional().map_err(|error| error.to_string())?;

	if let Some(prior) = prior {
		let prior_end = prior.end_time.clone().unwrap_or_default();
		let gap = parse_iso_to_secs(&session.start_time) as i64 - parse_iso_to_secs(&prior_end) as i64;
		if gap >= 0 && gap <= threshold_secs {
			let merged_duration = compute_duration(&prior.start_time, now).max(0);
			connection.execute(
				"UPDATE sessions SET end_time = ?1, duration = ?2, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE public_id = ?3 AND user_id = ?4",
				params![now, merged_duration, prior.id, user_id],
			).map_err(|error| error.to_string())?;
			connection.execute(
				"DELETE FROM sessions WHERE public_id = ?1 AND user_id = ?2",
				params![public_id, user_id],
			).map_err(|error| error.to_string())?;
			return Ok(Some((prior.id, prior.app_name, merged_duration)));
		}
	}

	Ok(Some((session.id, session.app_name, duration)))
}

pub fn name_session(path: &Path, user_id: &str, public_id: &str, task_name: &str) -> Result<(), String> {
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	let updated = connection.execute(
		"UPDATE sessions SET task_name = ?1, status = 'confirmed', updated_at = CURRENT_TIMESTAMP WHERE public_id = ?2 AND user_id = ?3",
		params![task_name, public_id, user_id],
	).map_err(|error| error.to_string())?;
	if updated == 0 { Err("Session not found".to_string()) } else { Ok(()) }
}

pub fn delete_session(path: &Path, user_id: &str, public_id: &str) -> Result<bool, String> {
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	let deleted = connection.execute(
		"DELETE FROM sessions WHERE public_id = ?1 AND user_id = ?2 AND status != 'active'",
		params![public_id, user_id],
	).map_err(|error| error.to_string())?;
	Ok(deleted > 0)
}

pub fn daily_summary(path: &Path, user_id: &str, date: &str) -> Result<Vec<DbAppSummary>, String> {
	let start = format!("{}T00:00:00Z", date);
	let end = format!("{}T23:59:59Z", date);
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	let mut statement = connection.prepare(
		r#"
		SELECT app_name, COALESCE(SUM(duration), 0) AS total_secs, COUNT(*) AS session_count
		FROM sessions
		WHERE user_id = ?1 AND start_time >= ?2 AND start_time <= ?3 AND end_time IS NOT NULL
		GROUP BY app_name
		ORDER BY total_secs DESC
		"#,
	).map_err(|error| error.to_string())?;
	let rows = statement.query_map(params![user_id, start, end], |row| {
		Ok(DbAppSummary {
			app_name: row.get(0)?,
			total_secs: row.get(1)?,
			session_count: row.get(2)?,
		})
	}).map_err(|error| error.to_string())?;
	rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

pub fn get_sessions_for_export(path: &Path, user_id: &str, from_date: &str, to_date: &str) -> Result<Vec<DbSession>, String> {
	let start = format!("{}T00:00:00Z", from_date);
	let end = format!("{}T23:59:59Z", to_date);
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	let mut statement = connection.prepare(
		r#"
		SELECT public_id, app_name, start_time, end_time, duration, task_name, status, work_session_id
		FROM sessions
		WHERE user_id = ?1 AND start_time >= ?2 AND start_time <= ?3 AND end_time IS NOT NULL
		ORDER BY COALESCE(task_name, ''), start_time ASC
		"#,
	).map_err(|error| error.to_string())?;
	let rows = statement.query_map(params![user_id, start, end], db_session_from_row).map_err(|error| error.to_string())?;
	rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

pub fn list_task_names(path: &Path, user_id: &str) -> Result<Vec<String>, String> {
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	let mut statement = connection.prepare(
		r#"
		SELECT task_name
		FROM sessions
		WHERE user_id = ?1 AND task_name IS NOT NULL AND task_name != ''
		GROUP BY task_name
		ORDER BY MAX(start_time) DESC
		LIMIT 50
		"#,
	).map_err(|error| error.to_string())?;
	let rows = statement.query_map([user_id], |row| row.get::<_, String>(0)).map_err(|error| error.to_string())?;
	rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

pub fn rename_task_group(path: &Path, user_id: &str, old_name: &str, new_name: &str) -> Result<(), String> {
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	connection.execute(
		"UPDATE sessions SET task_name = ?1, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?2 AND task_name = ?3",
		params![new_name.trim(), user_id, old_name],
	).map(|_| ()).map_err(|error| error.to_string())
}

pub fn delete_task_group(path: &Path, user_id: &str, name: &str) -> Result<(), String> {
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	connection.execute(
		"UPDATE sessions SET task_name = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?1 AND task_name = ?2",
		params![user_id, name],
	).map(|_| ()).map_err(|error| error.to_string())
}

fn parse_id_i64(id: &str, entity: &str) -> Result<i64, String> {
	id.parse::<i64>()
		.map_err(|error| format!("Invalid {entity} id '{id}': {error}"))
}

fn opt_id_i64(id: Option<&str>, entity: &str) -> Result<Option<i64>, String> {
	id.map(|value| parse_id_i64(value, entity)).transpose()
}

fn ids_placeholders(len: usize) -> String {
	(0..len).map(|_| "?").collect::<Vec<_>>().join(",")
}

// Clients
pub fn list_clients(path: &Path, user_id: &str) -> Result<Vec<DbClient>, String> {
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	let mut statement = connection
		.prepare("SELECT id, name FROM clients WHERE user_id = ?1 ORDER BY name COLLATE NOCASE ASC")
		.map_err(|error| error.to_string())?;
	let rows = statement
		.query_map([user_id], |row| {
			Ok(DbClient {
				id: row.get::<_, i64>(0)?.to_string(),
				name: row.get(1)?,
			})
		})
		.map_err(|error| error.to_string())?;
	rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

pub fn create_client(path: &Path, user_id: &str, name: &str) -> Result<DbClient, String> {
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	connection
		.execute(
			"INSERT INTO clients (user_id, name) VALUES (?1, ?2)",
			params![user_id, name.trim()],
		)
		.map_err(|error| error.to_string())?;
	let id = connection.last_insert_rowid().to_string();
	Ok(DbClient {
		id,
		name: name.trim().to_string(),
	})
}

pub fn delete_client(path: &Path, user_id: &str, id: &str) -> Result<(), String> {
	let client_id = parse_id_i64(id, "client")?;
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	connection
		.execute(
			"DELETE FROM clients WHERE id = ?1 AND user_id = ?2",
			params![client_id, user_id],
		)
		.map(|_| ())
		.map_err(|error| error.to_string())
}

// Projects
pub fn projects_count(path: &Path, user_id: &str) -> Result<i64, String> {
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	connection
		.query_row(
			"SELECT COUNT(*) FROM projects WHERE user_id = ?1",
			[user_id],
			|row| row.get::<_, i64>(0),
		)
		.map_err(|error| error.to_string())
}

pub fn list_projects(path: &Path, user_id: &str) -> Result<Vec<DbProject>, String> {
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	let mut statement = connection
		.prepare("SELECT id, name, color FROM projects WHERE user_id = ?1 ORDER BY name COLLATE NOCASE ASC")
		.map_err(|error| error.to_string())?;
	let rows = statement
		.query_map([user_id], |row| {
			Ok(DbProject {
				id: row.get::<_, i64>(0)?.to_string(),
				name: row.get(1)?,
				color: row.get(2)?,
			})
		})
		.map_err(|error| error.to_string())?;
	rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

pub fn list_projects_detail(path: &Path, user_id: &str) -> Result<Vec<DbProjectDetail>, String> {
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	let mut statement = connection
		.prepare(
			r#"
			SELECT p.id, p.name, p.color, p.description, p.client_id, c.name
			FROM projects p
			LEFT JOIN clients c ON c.id = p.client_id AND c.user_id = p.user_id
			WHERE p.user_id = ?1
			ORDER BY p.name COLLATE NOCASE ASC
			"#,
		)
		.map_err(|error| error.to_string())?;
	let rows = statement
		.query_map([user_id], |row| {
			let client_id = row.get::<_, Option<i64>>(4)?;
			Ok(DbProjectDetail {
				id: row.get::<_, i64>(0)?.to_string(),
				name: row.get(1)?,
				color: row.get(2)?,
				description: row.get(3)?,
				client_id: client_id.map(|id| id.to_string()),
				client_name: row.get(5)?,
			})
		})
		.map_err(|error| error.to_string())?;
	rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

pub fn create_project(
	path: &Path,
	user_id: &str,
	name: &str,
	color: &str,
	description: Option<&str>,
	client_id: Option<&str>,
) -> Result<DbProjectDetail, String> {
	let client_id_i64 = opt_id_i64(client_id, "client")?;
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	connection
		.execute(
			"INSERT INTO projects (user_id, name, color, description, client_id) VALUES (?1, ?2, ?3, ?4, ?5)",
			params![user_id, name.trim(), color, description, client_id_i64],
		)
		.map_err(|error| error.to_string())?;
	let id = connection.last_insert_rowid();
	let client_name = if let Some(cid) = client_id_i64 {
		connection
			.query_row(
				"SELECT name FROM clients WHERE id = ?1 AND user_id = ?2",
				params![cid, user_id],
				|row| row.get::<_, String>(0),
			)
			.optional()
			.map_err(|error| error.to_string())?
	} else {
		None
	};
	Ok(DbProjectDetail {
		id: id.to_string(),
		name: name.trim().to_string(),
		color: color.to_string(),
		description: description.map(|v| v.to_string()),
		client_id: client_id_i64.map(|v| v.to_string()),
		client_name,
	})
}

pub fn update_project(
	path: &Path,
	user_id: &str,
	id: &str,
	name: &str,
	description: Option<&str>,
	client_id: Option<&str>,
) -> Result<(), String> {
	let project_id = parse_id_i64(id, "project")?;
	let client_id_i64 = opt_id_i64(client_id, "client")?;
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	connection
		.execute(
			"UPDATE projects SET name = ?1, description = ?2, client_id = ?3, updated_at = CURRENT_TIMESTAMP WHERE id = ?4 AND user_id = ?5",
			params![name.trim(), description, client_id_i64, project_id, user_id],
		)
		.map(|_| ())
		.map_err(|error| error.to_string())
}

pub fn delete_project(path: &Path, user_id: &str, id: &str) -> Result<(), String> {
	let project_id = parse_id_i64(id, "project")?;
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	connection
		.execute(
			"UPDATE work_sessions SET project_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE project_id = ?1 AND user_id = ?2",
			params![project_id, user_id],
		)
		.map_err(|error| error.to_string())?;
	connection
		.execute(
			"DELETE FROM projects WHERE id = ?1 AND user_id = ?2",
			params![project_id, user_id],
		)
		.map(|_| ())
		.map_err(|error| error.to_string())
}

fn fetch_work_session_by_id(path: &Path, user_id: &str, work_session_id: i64) -> Result<Option<DbWorkSession>, String> {
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	connection.query_row(
		r#"
		SELECT ws.id, ws.name, ws.color,
		       COALESCE(MIN(s.start_time), ws.created_at) as start_time,
		       MAX(s.end_time) as end_time,
		       COALESCE(SUM(COALESCE(s.duration, 0)), 0) as total_secs,
		       COUNT(s.id) as session_count,
		       COALESCE(GROUP_CONCAT(DISTINCT s.app_name), '') as app_names,
		       ws.project_id,
		       p.name,
		       p.color
		FROM work_sessions ws
		LEFT JOIN sessions s ON s.work_session_id = ws.id AND s.user_id = ws.user_id
		LEFT JOIN projects p ON p.id = ws.project_id AND p.user_id = ws.user_id
		WHERE ws.id = ?1 AND ws.user_id = ?2
		GROUP BY ws.id, ws.name, ws.color, ws.created_at, ws.project_id, p.name, p.color
		"#,
		params![work_session_id, user_id],
		|row| {
			let project_id = row.get::<_, Option<i64>>(8)?;
			let app_names: String = row.get(7)?;
			Ok(DbWorkSession {
				id: row.get::<_, i64>(0)?.to_string(),
				name: row.get(1)?,
				color: row.get(2)?,
				start_time: row.get(3)?,
				end_time: row.get(4)?,
				total_secs: row.get(5)?,
				session_count: row.get(6)?,
				app_names,
				project_id: project_id.map(|v| v.to_string()),
				project_name: row.get(9)?,
				project_color: row.get(10)?,
			})
		},
	).optional().map_err(|error| error.to_string())
}

pub fn create_work_session(
	path: &Path,
	user_id: &str,
	name: &str,
	session_ids: &[String],
	color: Option<&str>,
	now_iso: &str,
) -> Result<DbWorkSession, String> {
	if session_ids.is_empty() {
		return Err("No sessions provided".to_string());
	}
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	let placeholders = ids_placeholders(session_ids.len());
	let min_start_sql = format!(
		"SELECT MIN(start_time) FROM sessions WHERE user_id = ? AND public_id IN ({})",
		placeholders
	);
	let mut min_params: Vec<rusqlite::types::Value> = vec![user_id.to_string().into()];
	for sid in session_ids {
		min_params.push(sid.clone().into());
	}
	let min_start = connection
		.query_row(&min_start_sql, rusqlite::params_from_iter(min_params), |row| row.get::<_, Option<String>>(0))
		.optional()
		.map_err(|error| error.to_string())?
		.flatten();
	let created_at = min_start.unwrap_or_else(|| now_iso.to_string());
	connection
		.execute(
			"INSERT INTO work_sessions (user_id, name, color, created_at) VALUES (?1, ?2, ?3, ?4)",
			params![user_id, name.trim(), color.unwrap_or("#58a6ff"), created_at],
		)
		.map_err(|error| error.to_string())?;
	let ws_id = connection.last_insert_rowid();
	let update_sql = format!(
		"UPDATE sessions SET work_session_id = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND public_id IN ({})",
		placeholders
	);
	let mut update_params: Vec<rusqlite::types::Value> = vec![ws_id.into(), user_id.to_string().into()];
	for sid in session_ids {
		update_params.push(sid.clone().into());
	}
	connection
		.execute(&update_sql, rusqlite::params_from_iter(update_params))
		.map_err(|error| error.to_string())?;
	fetch_work_session_by_id(path, user_id, ws_id)
		.and_then(|value| value.ok_or_else(|| "Work session not found after insert".to_string()))
}

pub fn list_work_sessions(path: &Path, user_id: &str, date: &str) -> Result<Vec<DbWorkSession>, String> {
	let start = format!("{}T00:00:00Z", date);
	let end = format!("{}T23:59:59Z", date);
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	let mut statement = connection
		.prepare(
			"SELECT DISTINCT work_session_id FROM sessions WHERE user_id = ?1 AND start_time >= ?2 AND start_time <= ?3 AND work_session_id IS NOT NULL",
		)
		.map_err(|error| error.to_string())?;
	let ids = statement
		.query_map(params![user_id, start, end], |row| row.get::<_, i64>(0))
		.map_err(|error| error.to_string())?;
	let mut result = Vec::new();
	for id in ids {
		if let Some(ws) = fetch_work_session_by_id(path, user_id, id.map_err(|error| error.to_string())?)? {
			result.push(ws);
		}
	}
	result.sort_by(|a, b| a.start_time.cmp(&b.start_time));
	Ok(result)
}

pub fn list_all_work_sessions(path: &Path, user_id: &str) -> Result<Vec<DbWorkSession>, String> {
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	let mut statement = connection
		.prepare("SELECT id FROM work_sessions WHERE user_id = ?1 ORDER BY created_at ASC")
		.map_err(|error| error.to_string())?;
	let ids = statement
		.query_map([user_id], |row| row.get::<_, i64>(0))
		.map_err(|error| error.to_string())?;
	let mut result = Vec::new();
	for id in ids {
		if let Some(ws) = fetch_work_session_by_id(path, user_id, id.map_err(|error| error.to_string())?)? {
			result.push(ws);
		}
	}
	Ok(result)
}

pub fn update_work_session(path: &Path, user_id: &str, id: &str, name: &str) -> Result<(), String> {
	let ws_id = parse_id_i64(id, "work session")?;
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	connection
		.execute(
			"UPDATE work_sessions SET name = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2 AND user_id = ?3",
			params![name.trim(), ws_id, user_id],
		)
		.map(|_| ())
		.map_err(|error| error.to_string())
}

pub fn delete_work_session(path: &Path, user_id: &str, id: &str) -> Result<(), String> {
	let ws_id = parse_id_i64(id, "work session")?;
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	connection
		.execute(
			"UPDATE sessions SET work_session_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE work_session_id = ?1 AND user_id = ?2",
			params![ws_id, user_id],
		)
		.map_err(|error| error.to_string())?;
	connection
		.execute(
			"DELETE FROM work_sessions WHERE id = ?1 AND user_id = ?2",
			params![ws_id, user_id],
		)
		.map(|_| ())
		.map_err(|error| error.to_string())
}

pub fn list_sessions_for_work_session(path: &Path, user_id: &str, work_session_id: &str) -> Result<Vec<DbSession>, String> {
	let ws_id = parse_id_i64(work_session_id, "work session")?;
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	let mut statement = connection.prepare(
		r#"
		SELECT public_id, app_name, start_time, end_time, duration, task_name, status, CAST(work_session_id AS TEXT)
		FROM sessions
		WHERE user_id = ?1 AND work_session_id = ?2
		ORDER BY start_time ASC
		"#,
	).map_err(|error| error.to_string())?;
	let rows = statement.query_map(params![user_id, ws_id], db_session_from_row)
		.map_err(|error| error.to_string())?;
	rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

pub fn remove_session_from_work_session(path: &Path, user_id: &str, session_id: &str) -> Result<(), String> {
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	connection
		.execute(
			"UPDATE sessions SET work_session_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?1 AND public_id = ?2",
			params![user_id, session_id],
		)
		.map(|_| ())
		.map_err(|error| error.to_string())
}

pub fn add_session_to_work_session(path: &Path, user_id: &str, session_id: &str, work_session_id: &str) -> Result<(), String> {
	let ws_id = parse_id_i64(work_session_id, "work session")?;
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	let ws_exists = connection
		.query_row(
			"SELECT 1 FROM work_sessions WHERE id = ?1 AND user_id = ?2",
			params![ws_id, user_id],
			|row| row.get::<_, i64>(0),
		)
		.optional()
		.map_err(|error| error.to_string())?
		.is_some();
	if !ws_exists {
		return Err("Work session not found".to_string());
	}
	connection
		.execute(
			"UPDATE sessions SET work_session_id = ?1, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?2 AND public_id = ?3",
			params![ws_id, user_id, session_id],
		)
		.map(|_| ())
		.map_err(|error| error.to_string())
}

pub fn assign_work_session_project(path: &Path, user_id: &str, work_session_id: &str, project_id: Option<&str>) -> Result<(), String> {
	let ws_id = parse_id_i64(work_session_id, "work session")?;
	let project_id_i64 = opt_id_i64(project_id, "project")?;
	let connection = open_connection(path).map_err(|error| error.to_string())?;
	connection
		.execute(
			"UPDATE work_sessions SET project_id = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2 AND user_id = ?3",
			params![project_id_i64, ws_id, user_id],
		)
		.map(|_| ())
		.map_err(|error| error.to_string())
}

pub fn export_backup_json(path: &Path, user_id: &str) -> Result<String, String> {
	let connection = open_connection(path).map_err(|error| error.to_string())?;

	let mut settings_stmt = connection
		.prepare("SELECT key, value FROM settings WHERE user_id = ?1 ORDER BY key ASC")
		.map_err(|error| error.to_string())?;
	let settings_rows = settings_stmt
		.query_map([user_id], |row| {
			Ok(BackupSetting {
				key: row.get(0)?,
				value: row.get(1)?,
			})
		})
		.map_err(|error| error.to_string())?;
	let settings = settings_rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;

	let mut app_stmt = connection
		.prepare("SELECT name, process_name, icon, is_enabled FROM applications WHERE user_id = ?1 ORDER BY name ASC")
		.map_err(|error| error.to_string())?;
	let app_rows = app_stmt
		.query_map([user_id], |row| {
			Ok(BackupApplication {
				name: row.get(0)?,
				process_name: row.get(1)?,
				icon: row.get(2)?,
				is_enabled: row.get::<_, i64>(3)? != 0,
			})
		})
		.map_err(|error| error.to_string())?;
	let applications = app_rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;

	let mut clients_stmt = connection
		.prepare("SELECT id, name FROM clients WHERE user_id = ?1 ORDER BY id ASC")
		.map_err(|error| error.to_string())?;
	let clients_rows = clients_stmt
		.query_map([user_id], |row| {
			Ok(BackupClient {
				id: row.get(0)?,
				name: row.get(1)?,
			})
		})
		.map_err(|error| error.to_string())?;
	let clients = clients_rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;

	let mut projects_stmt = connection
		.prepare("SELECT id, name, color, description, client_id FROM projects WHERE user_id = ?1 ORDER BY id ASC")
		.map_err(|error| error.to_string())?;
	let projects_rows = projects_stmt
		.query_map([user_id], |row| {
			Ok(BackupProject {
				id: row.get(0)?,
				name: row.get(1)?,
				color: row.get(2)?,
				description: row.get(3)?,
				client_id: row.get(4)?,
			})
		})
		.map_err(|error| error.to_string())?;
	let projects = projects_rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;

	let mut ws_stmt = connection
		.prepare("SELECT id, name, color, project_id, created_at FROM work_sessions WHERE user_id = ?1 ORDER BY id ASC")
		.map_err(|error| error.to_string())?;
	let ws_rows = ws_stmt
		.query_map([user_id], |row| {
			Ok(BackupWorkSession {
				id: row.get(0)?,
				name: row.get(1)?,
				color: row.get(2)?,
				project_id: row.get(3)?,
				created_at: row.get(4)?,
			})
		})
		.map_err(|error| error.to_string())?;
	let work_sessions = ws_rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;

	let mut sessions_stmt = connection
		.prepare(
			"SELECT public_id, app_name, process_name, start_time, end_time, duration, task_name, status, work_session_id FROM sessions WHERE user_id = ?1 ORDER BY start_time ASC",
		)
		.map_err(|error| error.to_string())?;
	let sessions_rows = sessions_stmt
		.query_map([user_id], |row| {
			Ok(BackupSession {
				public_id: row.get(0)?,
				app_name: row.get(1)?,
				process_name: row.get(2)?,
				start_time: row.get(3)?,
				end_time: row.get(4)?,
				duration: row.get(5)?,
				task_name: row.get(6)?,
				status: row.get(7)?,
				work_session_id: row.get::<_, Option<i64>>(8)?,
			})
		})
		.map_err(|error| error.to_string())?;
	let sessions = sessions_rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;

	let payload = BackupPayload {
		schema_version: 1,
		exported_at: chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
		user_id: user_id.to_string(),
		settings,
		applications,
		clients,
		projects,
		work_sessions,
		sessions,
	};

	serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())
}

pub fn import_backup_json(path: &Path, user_id: &str, backup_json: &str) -> Result<BackupImportSummary, String> {
	let payload: BackupPayload = serde_json::from_str(backup_json).map_err(|error| format!("Invalid backup JSON: {error}"))?;

	if payload.schema_version != 1 {
		return Err(format!("Unsupported backup schema_version: {}", payload.schema_version));
	}

	let mut connection = open_connection(path).map_err(|error| error.to_string())?;
	let tx = connection.transaction().map_err(|error| error.to_string())?;

	for setting in &payload.settings {
		tx.execute(
			"INSERT INTO settings (user_id, key, value) VALUES (?1, ?2, ?3) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
			params![user_id, setting.key, setting.value],
		).map_err(|error| error.to_string())?;
	}

	for app in &payload.applications {
		tx.execute(
			"INSERT INTO applications (user_id, name, process_name, icon, is_enabled) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(user_id, process_name) DO UPDATE SET name = excluded.name, icon = excluded.icon, is_enabled = excluded.is_enabled, updated_at = CURRENT_TIMESTAMP",
			params![user_id, app.name, app.process_name, app.icon, if app.is_enabled { 1 } else { 0 }],
		).map_err(|error| error.to_string())?;
	}

	for client in &payload.clients {
		tx.execute(
			"INSERT INTO clients (id, user_id, name) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET name = excluded.name",
			params![client.id, user_id, client.name],
		).map_err(|error| error.to_string())?;
	}

	for project in &payload.projects {
		tx.execute(
			"INSERT INTO projects (id, user_id, name, color, description, client_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color, description = excluded.description, client_id = excluded.client_id, updated_at = CURRENT_TIMESTAMP",
			params![project.id, user_id, project.name, project.color, project.description, project.client_id],
		).map_err(|error| error.to_string())?;
	}

	for work_session in &payload.work_sessions {
		tx.execute(
			"INSERT INTO work_sessions (id, user_id, name, color, project_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, COALESCE(?6, CURRENT_TIMESTAMP)) ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color, project_id = excluded.project_id, updated_at = CURRENT_TIMESTAMP",
			params![work_session.id, user_id, work_session.name, work_session.color, work_session.project_id, work_session.created_at],
		).map_err(|error| error.to_string())?;
	}

	for session in &payload.sessions {
		tx.execute(
			"INSERT INTO sessions (public_id, user_id, app_name, process_name, start_time, end_time, duration, task_name, status, work_session_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) ON CONFLICT(public_id) DO UPDATE SET app_name = excluded.app_name, process_name = excluded.process_name, start_time = excluded.start_time, end_time = excluded.end_time, duration = excluded.duration, task_name = excluded.task_name, status = excluded.status, work_session_id = excluded.work_session_id, updated_at = CURRENT_TIMESTAMP",
			params![
				session.public_id,
				user_id,
				session.app_name,
				session.process_name,
				session.start_time,
				session.end_time,
				session.duration,
				session.task_name,
				session.status,
				session.work_session_id,
			],
		).map_err(|error| error.to_string())?;
	}

	tx.commit().map_err(|error| error.to_string())?;

	Ok(BackupImportSummary {
		settings: payload.settings.len(),
		applications: payload.applications.len(),
		clients: payload.clients.len(),
		projects: payload.projects.len(),
		work_sessions: payload.work_sessions.len(),
		sessions: payload.sessions.len(),
	})
}

pub fn clear_user_data(path: &Path, user_id: &str) -> Result<(), String> {
	let mut connection = open_connection(path).map_err(|error| error.to_string())?;
	let tx = connection.transaction().map_err(|error| error.to_string())?;

	tx.execute("DELETE FROM sessions WHERE user_id = ?1", [user_id]).map_err(|error| error.to_string())?;
	tx.execute("DELETE FROM work_sessions WHERE user_id = ?1", [user_id]).map_err(|error| error.to_string())?;
	tx.execute("DELETE FROM projects WHERE user_id = ?1", [user_id]).map_err(|error| error.to_string())?;
	tx.execute("DELETE FROM clients WHERE user_id = ?1", [user_id]).map_err(|error| error.to_string())?;
	tx.execute("DELETE FROM applications WHERE user_id = ?1", [user_id]).map_err(|error| error.to_string())?;
	tx.execute("DELETE FROM settings WHERE user_id = ?1", [user_id]).map_err(|error| error.to_string())?;

	tx.commit().map_err(|error| error.to_string())
}
