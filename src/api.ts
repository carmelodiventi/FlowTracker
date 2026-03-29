/**
 * Typed wrappers around Tauri invoke() calls.
 * All IDs are MongoDB ObjectId hex strings.
 */
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Types (mirror the Rust structs)
// ---------------------------------------------------------------------------

export interface Application {
  id: string;
  name: string;
  process_name: string;
  icon: string | null;
  is_enabled: boolean;
}

export interface Session {
  id: string;
  app_name: string;
  start_time: string; // ISO-8601 UTC
  end_time: string | null;
  duration: number | null; // seconds
  task_name: string | null;
  status: string; // "active" | "pending" | "confirmed" | "idle"
  work_session_id: string | null;
}

export interface AppSummary {
  app_name: string;
  process_name: string;
  total_secs: number;
  session_count: number;
}

export interface WorkSession {
  id: string;
  name: string;
  color: string;
  start_time: string;
  end_time: string | null;
  total_secs: number;
  session_count: number;
  app_names: string;
  project_id: string | null;
  project_name: string | null;
  project_color: string | null;
}

export interface Project {
  id: string;
  name: string;
  color: string;
}

export interface Client {
  id: string;
  name: string;
}

export interface ProjectDetail {
  id: string;
  name: string;
  color: string;
  description: string | null;
  client_id: string | null;
  client_name: string | null;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Returns the persistent user ID from ~/.flowtracker/user_id (generated on first launch). */
export const getUserId = (): Promise<string> =>
  invoke("get_user_id");

// ---------------------------------------------------------------------------
// Application / Whitelist
// ---------------------------------------------------------------------------

export const listApplications = (): Promise<Application[]> =>
  invoke("list_applications");

export const upsertApplication = (
  name: string,
  process_name: string,
  is_enabled: boolean
): Promise<string> =>
  invoke("upsert_application", { name, processName: process_name, isEnabled: is_enabled });

export const toggleApplication = (id: string, enabled: boolean): Promise<void> =>
  invoke("toggle_application", { id, enabled });

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

export const nameSession = (id: string, task_name: string): Promise<void> =>
  invoke("name_session", { id, taskName: task_name });

export const deleteSession = (id: string): Promise<void> =>
  invoke("delete_session", { id });

export const stopActiveSession = (): Promise<void> =>
  invoke("stop_active_session");

export const getSessionsForExport = (fromDate: string, toDate: string): Promise<Session[]> =>
  invoke("get_sessions_for_export", { fromDate, toDate });

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
// Task names
// ---------------------------------------------------------------------------

export const listTaskNames = (): Promise<string[]> =>
  invoke("list_task_names");

export const renameTaskGroup = (oldName: string, newName: string): Promise<void> =>
  invoke("rename_task_group", { oldName, newName });

export const deleteTaskGroup = (name: string): Promise<void> =>
  invoke("delete_task_group", { name });

// ---------------------------------------------------------------------------
// Work Sessions
// ---------------------------------------------------------------------------

export const createWorkSession = (
  name: string,
  session_ids: string[],
  color?: string
): Promise<WorkSession> =>
  invoke("create_work_session", { name, sessionIds: session_ids, color });

export const listWorkSessions = (date: string): Promise<WorkSession[]> =>
  invoke("list_work_sessions", { date });

export const listAllWorkSessions = (): Promise<WorkSession[]> =>
  invoke("list_all_work_sessions");

export const updateWorkSession = (id: string, name: string): Promise<void> =>
  invoke("update_work_session", { id, name });

export const deleteWorkSession = (id: string): Promise<void> =>
  invoke("delete_work_session", { id });

export const listSessionsForWorkSession = (workSessionId: string): Promise<Session[]> =>
  invoke("list_sessions_for_work_session", { workSessionId });

export const removeSessionFromWorkSession = (sessionId: string): Promise<void> =>
  invoke("remove_session_from_work_session", { sessionId });

export const assignWorkSessionProject = (
  workSessionId: string,
  projectId: string | null
): Promise<void> =>
  invoke("assign_work_session_project", { workSessionId, projectId });

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const listProjects = (): Promise<Project[]> =>
  invoke("list_projects");

export const listProjectsDetail = (): Promise<ProjectDetail[]> =>
  invoke("list_projects_detail");

export const createProject = (
  name: string,
  description: string | null,
  clientId: string | null
): Promise<ProjectDetail> =>
  invoke("create_project", { name, description, clientId });

export const updateProject = (
  id: string,
  name: string,
  description: string | null,
  clientId: string | null
): Promise<void> =>
  invoke("update_project", { id, name, description, clientId });

export const deleteProject = (id: string): Promise<void> =>
  invoke("delete_project", { id });

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export const listClients = (): Promise<Client[]> =>
  invoke("list_clients");

export const createClient = (name: string): Promise<Client> =>
  invoke("create_client", { name });

export const deleteClient = (id: string): Promise<void> =>
  invoke("delete_client", { id });
