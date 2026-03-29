/**
 * Typed wrappers around Tauri invoke() calls.
 * All functions map 1:1 to a #[tauri::command] in src-tauri/src/commands.rs.
 */
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Types (mirror the Rust structs)
// ---------------------------------------------------------------------------

export interface Application {
  id: number;
  name: string;
  process_name: string;
  icon: string | null;
  is_enabled: boolean;
}

export interface Session {
  id: number;
  app_id: number;
  app_name: string;
  start_time: string; // ISO-8601 UTC
  end_time: string | null;
  duration: number | null; // seconds
  task_name: string | null;
  status: string; // "active" | "pending" | "confirmed" | "idle"
  work_session_id: number | null;
}

export interface AppSummary {
  app_name: string;
  process_name: string;
  total_secs: number;
  session_count: number;
}

export interface WorkSession {
  id: number;
  name: string;
  color: string;
  start_time: string;
  end_time: string | null;
  total_secs: number;      // computed: sum of linked sessions' duration
  session_count: number;   // number of linked app sessions
  app_names: string;       // comma-separated app names in this work session
  project_id: number | null;
  project_name: string | null;
  project_color: string | null;
}

export interface Project {
  id: number;
  name: string;
  color: string;
}

// ---------------------------------------------------------------------------
// Application / Whitelist
// ---------------------------------------------------------------------------

export const listApplications = (): Promise<Application[]> =>
  invoke("list_applications");

export const upsertApplication = (
  name: string,
  process_name: string,
  is_enabled: boolean
): Promise<number> =>
  invoke("upsert_application", { name, process_name, isEnabled: is_enabled });

export const toggleApplication = (
  id: number,
  enabled: boolean
): Promise<void> => invoke("toggle_application", { id, enabled });

/** Enumerate all currently running GUI apps, upsert into DB, return updated list. */
export const scanRunningApps = (): Promise<Application[]> =>
  invoke("scan_running_apps");

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const listTodaySessions = (): Promise<Session[]> =>
  invoke("list_today_sessions");

export const listSessionsForDate = (date: string): Promise<Session[]> =>
  invoke("list_sessions_for_date", { date });

export const listPendingSessions = (): Promise<Session[]> =>
  invoke("list_pending_sessions");

export const nameSession = (id: number, task_name: string): Promise<void> =>
  invoke("name_session", { id, taskName: task_name });

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export const dailySummary = (date: string): Promise<AppSummary[]> =>
  invoke("daily_summary", { date });

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const getSetting = (key: string): Promise<string> =>
  invoke("get_setting", { key });

export const setSetting = (key: string, value: string): Promise<void> =>
  invoke("set_setting", { key, value });

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

export const checkAccessibility = (): Promise<boolean> =>
  invoke("check_accessibility");

export const openAccessibilitySettings = (): Promise<void> =>
  invoke("open_accessibility_settings");

// ---------------------------------------------------------------------------
// Work Sessions
// ---------------------------------------------------------------------------

export const createWorkSession = (
  name: string,
  session_ids: number[],
  color?: string
): Promise<WorkSession> =>
  invoke("create_work_session", { name, sessionIds: session_ids, color });

export const listWorkSessions = (date: string): Promise<WorkSession[]> =>
  invoke("list_work_sessions", { date });

export const updateWorkSession = (id: number, name: string): Promise<void> =>
  invoke("update_work_session", { id, name });

export const deleteWorkSession = (id: number): Promise<void> =>
  invoke("delete_work_session", { id });

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const listProjects = (): Promise<Project[]> =>
  invoke("list_projects");

export const createProject = (name: string, color?: string): Promise<Project> =>
  invoke("create_project", { name, color });

export const assignWorkSessionProject = (
  workSessionId: number,
  projectId: number | null
): Promise<void> =>
  invoke("assign_work_session_project", { workSessionId, projectId });

export const deleteSession = (id: number): Promise<void> =>
  invoke("delete_session", { id });
