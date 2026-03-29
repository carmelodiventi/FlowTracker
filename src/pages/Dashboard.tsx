import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  dailySummary,
  listSessionsForDate,
  nameSession,
  deleteSession,
  listTaskNames,
  renameTaskGroup,
  listWorkSessions,
  createWorkSession,
  updateWorkSession,
  deleteWorkSession,
  listProjects,
  createProject,
  assignWorkSessionProject,
} from "../api";
import type { Session, AppSummary, WorkSession, Project } from "../api";

// ─── Color helpers ────────────────────────────────────────────────────────────

const APP_COLORS: Record<string, string> = {
  Code: "#007acc",
  "VS Code": "#007acc",
  Chrome: "#ea4335",
  Safari: "#006cff",
  Terminal: "#4caf50",
  iTerm2: "#4caf50",
  Slack: "#4a154b",
  Discord: "#5865f2",
  Finder: "#62b7f5",
};

function appColor(name: string): string {
  if (APP_COLORS[name]) return APP_COLORS[name];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return `hsl(${h % 360}, 65%, 55%)`;
}

function appIcon(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("code") || n.includes("vscode")) return "code";
  if (n.includes("chrome") || n.includes("safari") || n.includes("firefox") || n.includes("browser"))
    return "language";
  if (n.includes("terminal") || n.includes("iterm") || n.includes("warp")) return "terminal";
  if (n.includes("slack")) return "chat";
  if (n.includes("discord")) return "forum";
  if (n.includes("finder")) return "folder_open";
  if (n.includes("figma") || n.includes("sketch")) return "design_services";
  if (n.includes("mail") || n.includes("outlook")) return "mail";
  return "apps";
}

// ─── Format helpers ───────────────────────────────────────────────────────────

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function fmtDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0
    ? `${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m`
    : `${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
}

function fmtClock(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [date, setDate] = useState(todayISO());
  const [sessions, setSessions] = useState<Session[]>([]);
  const [summary, setSummary] = useState<AppSummary[]>([]);
  const [workSessions, setWorkSessions] = useState<WorkSession[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [groupName, setGroupName] = useState("");
  const [showGroupDialog, setShowGroupDialog] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [liveSecs, setLiveSecs] = useState(0);
  const [loading, setLoading] = useState(true);
  const [taskNames, setTaskNames] = useState<string[]>([]);
  const [editingGroup, setEditingGroup] = useState<string | null>(null); // current task_name being renamed
  const [editGroupName, setEditGroupName] = useState("");

  // Projects state
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<number | null>(null);
  const [newProjectName, setNewProjectName] = useState('');
  const [showNewProject, setShowNewProject] = useState(false);

  // Collapsible groups state
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // Work session inline edit state
  const [editingWsId, setEditingWsId] = useState<number | null>(null);
  const [editWsName, setEditWsName] = useState("");
  const [editWsProjectId, setEditWsProjectId] = useState<number | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isToday = date === todayISO();

  // ── Data loading ────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sess, summ, ws, projs, names] = await Promise.all([
        listSessionsForDate(date).catch(() => [] as Session[]),
        dailySummary(date).catch(() => [] as AppSummary[]),
        listWorkSessions(date).catch(() => [] as WorkSession[]),
        listProjects().catch(() => [] as Project[]),
        listTaskNames().catch(() => [] as string[]),
      ]);
      setSessions(sess);
      setSummary(summ);
      setWorkSessions(ws);
      setProjects(projs);
      setTaskNames(names);
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    load();
    setSelected(new Set());
  }, [load]);

  // ── Auto-refresh: listen to session events + poll every 30s (today only) ────

  useEffect(() => {
    if (!isToday) return;

    // Reload whenever the watcher opens or closes/merges a session
    const unlistenClosed = listen("flow:session-closed", () => load());
    const unlistenOpened = listen("flow:session-opened", () => load());

    // Also poll every 30s to catch new active sessions opening
    const pollId = setInterval(load, 30_000);

    return () => {
      unlistenClosed.then((fn) => fn());
      unlistenOpened.then((fn) => fn());
      clearInterval(pollId);
    };
  }, [isToday, load]);

  // ── Live timer (today only) ─────────────────────────────────────────────────

  useEffect(() => {
    if (!isToday) {
      setLiveSecs(0);
      return;
    }

    const tick = () => {
      setSessions((prev) => {
        // Only the most recent active session counts as live
        const active = prev
          .filter((s) => s.status === "active")
          .sort((a, b) => b.start_time.localeCompare(a.start_time))[0];
        if (active) {
          const started = new Date(
            active.start_time.endsWith("Z") ? active.start_time : active.start_time + "Z"
          );
          setLiveSecs(Math.floor((Date.now() - started.getTime()) / 1000));
        } else {
          setLiveSecs(0);
        }
        return prev;
      });
    };

    tick();
    timerRef.current = setInterval(tick, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [isToday, sessions.length]);

  // ── Derived values ──────────────────────────────────────────────────────────

  // Only the most recent active session is truly live — guard against stale DB rows.
  const activeSession = useMemo(
    () => sessions.filter((s) => s.status === "active").sort((a, b) =>
      b.start_time.localeCompare(a.start_time))[0] ?? null,
    [sessions]
  );

  const totalRecorded = useMemo(
    () => summary.reduce((a, s) => a + s.total_secs, 0),
    [summary]
  );
  const totalSecs = totalRecorded + liveSecs;
  const maxSecs = summary[0]?.total_secs || 1;

  // Group past sessions by task_name. Sessions without a task_name stay ungrouped.
  const pastSessions = useMemo(
    () => sessions.filter((s) => s.id !== activeSession?.id),
    [sessions, activeSession]
  );

  // Build display list: groups for named sessions, singles for unnamed.
  // Each item is either a "group" (task_name + sessions) or a "single" session.
  const groupedPast = useMemo(() => {
    const groups = new Map<string, Session[]>();
    const singles: Session[] = [];
    for (const s of pastSessions) {
      if (s.task_name) {
        const arr = groups.get(s.task_name) ?? [];
        arr.push(s);
        groups.set(s.task_name, arr);
      } else {
        singles.push(s);
      }
    }
    // Merge into ordered display items, keeping chronological order of first occurrence
    type DisplayItem =
      | { kind: "group"; task_name: string; sessions: Session[]; total_secs: number }
      | { kind: "single"; session: Session };

    const items: { sortKey: string; item: DisplayItem }[] = [];
    for (const [task_name, groupSessions] of groups) {
      const total_secs = groupSessions.reduce((a, s) => a + (s.duration ?? 0), 0);
      const sortKey = groupSessions[groupSessions.length - 1].start_time; // latest in group
      items.push({ sortKey, item: { kind: "group", task_name, sessions: groupSessions, total_secs } });
    }
    for (const s of singles) {
      items.push({ sortKey: s.start_time, item: { kind: "single", session: s } });
    }
    // Sort descending (newest first)
    items.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
    return items.map((i) => i.item);
  }, [pastSessions]);

  // Split groupedPast into tagged groups and unlabelled singles
  const groupItems = groupedPast.filter(
    (i): i is { kind: "group"; task_name: string; sessions: Session[]; total_secs: number } =>
      i.kind === "group"
  );
  const singleItems = groupedPast.filter(
    (i): i is { kind: "single"; session: Session } => i.kind === "single"
  );

  // ── Handlers ────────────────────────────────────────────────────────────────

  const offsetDate = (delta: number) => {
    const d = new Date(date + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + delta);
    setDate(d.toISOString().slice(0, 10));
  };

  const toggleSelect = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleRename = async (id: number) => {
    if (!editName.trim()) return;
    await nameSession(id, editName.trim()).catch(console.error);
    setEditingId(null);
    setEditName("");
    await load();
  };

  const handleDeleteSession = async (id: number) => {
    await deleteSession(id).catch(console.error);
    setSelected((prev) => { const n = new Set(prev); n.delete(id); return n; });
    await load();
  };

  const handleRenameGroup = async (oldName: string) => {
    const trimmed = editGroupName.trim();
    if (!trimmed || trimmed === oldName) { setEditingGroup(null); setEditGroupName(""); return; }
    await renameTaskGroup(oldName, trimmed).catch(console.error);
    setEditingGroup(null);
    setEditGroupName("");
    await load();
  };

  const handleCreateWorkSession = async () => {
    if (selected.size < 1 || !groupName.trim()) return;
    const ws = await createWorkSession(groupName.trim(), Array.from(selected)).catch(console.error);
    if (ws && selectedProject !== null) {
      await assignWorkSessionProject(ws.id, selectedProject).catch(console.error);
    }
    setSelected(new Set());
    setGroupName("");
    setSelectedProject(null);
    setShowNewProject(false);
    setNewProjectName('');
    setShowGroupDialog(false);
    await load();
  };

  const handleDeleteWorkSession = async (id: number) => {
    await deleteWorkSession(id).catch(console.error);
    await load();
  };

  const handleUpdateWorkSession = async (id: number) => {
    const trimmed = editWsName.trim();
    if (trimmed) await updateWorkSession(id, trimmed).catch(console.error);
    await assignWorkSessionProject(id, editWsProjectId).catch(console.error);
    setEditingWsId(null);
    setEditWsName("");
    setEditWsProjectId(null);
    await load();
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0d1117",
        color: "#e6edf3",
        display: "flex",
        flexDirection: "column",
        fontFamily: "'Inter', 'Segoe UI', sans-serif",
      }}
    >
      {/* ── Header ── */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 28px",
          height: 58,
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          background: "#010409",
          flexShrink: 0,
          position: "sticky",
          top: 0,
          zIndex: 20,
        }}
      >
        {/* Left: title + date nav */}
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <h1 style={{
              fontFamily: "'Inter', sans-serif",
              fontWeight: 800,
              fontSize: 18,
              letterSpacing: "-0.03em",
              color: "#f6f6fc",
              margin: 0,
            }}>Timeline</h1>
          
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <button onClick={() => offsetDate(-1)} style={navBtnStyle}>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>chevron_left</span>
            </button>
            <button
              onClick={() => !isToday && setDate(todayISO())}
              style={{
                background: "none",
                border: "none",
                cursor: isToday ? "default" : "pointer",
                color: "#aaabb0",
                fontFamily: "Roboto Mono, monospace",
                fontSize: 12,
                fontWeight: 500,
                minWidth: 76,
                textAlign: "center",
                padding: "3px 6px",
                borderRadius: 4,
              }}
            >
              {isToday ? "Today" : date}
            </button>
            <button onClick={() => offsetDate(1)} disabled={isToday} style={{ ...navBtnStyle, opacity: isToday ? 0.3 : 1 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>chevron_right</span>
            </button>
          </div>
          {/* Hidden date picker */}
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            style={{ opacity: 0, width: 1, height: 1, position: "absolute" }}
            tabIndex={-1}
          />
        </div>

        {/* Right: compact daily total */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {liveSecs > 0 && (
            <span
              style={{
                fontSize: 10,
                color: "#6affc9",
                fontFamily: "Roboto Mono, monospace",
                letterSpacing: "0.06em",
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <span
                style={{
                  width: 6, height: 6, borderRadius: "50%",
                  background: "#6affc9",
                  display: "inline-block",
                  animation: "pulse 1.4s infinite",
                }}
              />
              LIVE
            </span>
          )}
          <span
            style={{
              fontFamily: "Roboto Mono, monospace",
              fontSize: 15,
              fontWeight: 700,
              color: "#6affc9",
              letterSpacing: "0.04em",
            }}
          >
            {fmtDuration(totalSecs)}
          </span>
          <span style={{ fontSize: 10, color: "#74757a", fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase" }}>
            DAILY TOTAL
          </span>
        </div>
      </header>

      {/* ── Body ── */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "32px 44px",
          maxWidth: 900,
          width: "100%",
          margin: "0 auto",
          boxSizing: "border-box",
        }}
      >
        {loading ? (
          <div style={{ color: "#8b949e", textAlign: "center", paddingTop: 80, fontSize: 14 }}>
            Caricamento…
          </div>
        ) : (
          <>
            {/* ── Hero: Date + Big Timer ── */}
            <section style={{ marginBottom: 36 }}>
              <p style={{
                fontSize: 12,
                fontWeight: 500,
                color: "#aaabb0",
                fontFamily: "'Inter', sans-serif",
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                marginBottom: 6,
              }}>
                {new Date(date + "T12:00:00").toLocaleDateString("en-US", {
                  weekday: "long", month: "long", day: "numeric"
                })}
              </p>
              <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
                <h2 style={{
                  fontFamily: "'Inter', sans-serif",
                  fontSize: 64,
                  fontWeight: 800,
                  color: "#f6f6fc",
                  letterSpacing: "-0.04em",
                  lineHeight: 1,
                  margin: 0,
                  fontVariantNumeric: "tabular-nums",
                }}>
                  {fmtClock(totalSecs)}
                </h2>
                {isToday && (
                  <span style={{
                    fontFamily: "Roboto Mono, monospace",
                    fontSize: 13,
                    fontWeight: 500,
                    color: "#6affc9",
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                  }}>
                    {liveSecs > 0 ? "● ACTIVE FLOW" : "ACTIVE FLOW"}
                  </span>
                )}
              </div>
            </section>

            {/* ── Application Distribution ── */}
            <section style={{ marginBottom: 28 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 10,
                }}
              >
                <span style={sectionLabel}>Application Distribution</span>
                <span
                  style={{
                    fontFamily: "Roboto Mono, monospace",
                    fontSize: 11,
                    color: "#8b949e",
                    letterSpacing: "0.04em",
                  }}
                >
                  TOTALE REGISTRATO: {fmtClock(totalRecorded)}
                </span>
              </div>

              {summary.length > 0 ? (
                <>
                  {/* Stacked proportional bar */}
                  <div
                    style={{
                      display: "flex",
                      height: 8,
                      borderRadius: 4,
                      overflow: "hidden",
                      gap: 2,
                      marginBottom: 14,
                    }}
                  >
                    {summary.map((app) => (
                      <div
                        key={app.process_name}
                        title={`${app.app_name}: ${fmtDuration(app.total_secs)}`}
                        style={{
                          flex: app.total_secs,
                          background: appColor(app.app_name),
                          borderRadius: 2,
                          minWidth: 2,
                        }}
                      />
                    ))}
                  </div>

                  {/* Per-app rows */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                    {summary.map((app) => (
                      <div
                        key={app.process_name}
                        style={{ display: "flex", alignItems: "center", gap: 10 }}
                      >
                        <div
                          style={{
                            width: 8, height: 8, borderRadius: 2,
                            background: appColor(app.app_name), flexShrink: 0,
                          }}
                        />
                        <span
                          style={{
                            fontSize: 12, color: "#c9d1d9", flex: "0 0 140px",
                            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                          }}
                        >
                          {app.app_name}
                        </span>
                        <div
                          style={{
                            flex: 1, height: 4,
                            background: "rgba(255,255,255,0.05)",
                            borderRadius: 2, overflow: "hidden",
                          }}
                        >
                          <div
                            style={{
                              height: "100%",
                              width: `${(app.total_secs / maxSecs) * 100}%`,
                              background: appColor(app.app_name),
                              borderRadius: 2,
                              transition: "width 0.4s ease",
                            }}
                          />
                        </div>
                        <span
                          style={{
                            fontFamily: "Roboto Mono, monospace",
                            fontSize: 11, color: "#8b949e",
                            width: 60, textAlign: "right", flexShrink: 0,
                          }}
                        >
                          {fmtDuration(app.total_secs)}
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* Timeline ruler */}
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      marginTop: 16,
                      paddingLeft: 158,
                    }}
                  >
                    {["08:00", "10:00", "12:00", "14:00", "16:00", "18:00"].map((t) => (
                      <span
                        key={t}
                        style={{
                          fontSize: 10,
                          fontFamily: "Roboto Mono, monospace",
                          color: "rgba(139,148,158,0.45)",
                        }}
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </>
              ) : (
                <div
                  style={{
                    height: 52,
                    background: "#161b22",
                    borderRadius: 8,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#484f58",
                    fontSize: 12,
                    border: "1px solid rgba(255,255,255,0.05)",
                  }}
                >
                  Nessuna attività registrata
                </div>
              )}
            </section>

            {/* ── Session list ── */}
            <section style={{ marginBottom: 24 }}>
              {sessions.length === 0 ? (
                <div
                  style={{
                    textAlign: "center",
                    paddingTop: 52,
                    paddingBottom: 52,
                    color: "#484f58",
                  }}
                >
                  <span
                    className="material-symbols-outlined"
                    style={{ fontSize: 40, display: "block", marginBottom: 8 }}
                  >
                    timeline
                  </span>
                  <span style={{ fontSize: 13 }}>
                    No sessions for {isToday ? "today" : date}
                  </span>
                </div>
              ) : (
                <>
                  {/* ── 1. LIVE container ── */}
                  {activeSession && (() => {
                    const s = activeSession;
                    const isSelected = selected.has(s.id);
                    const isEditing = editingId === s.id;
                    const linkedWs = workSessions.find((w) => w.id === s.work_session_id);
                    return (
                      <div style={{ marginBottom: 20 }}>
                        <div style={{
                          fontSize: 10, color: "#484f58", fontFamily: "Roboto Mono, monospace",
                          letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8,
                          display: "flex", alignItems: "center", gap: 6,
                        }}>
                          <span style={{
                            width: 7, height: 7, borderRadius: "50%",
                            background: "#6affc9", display: "inline-block",
                            animation: "pulse 1.4s infinite",
                          }} />
                          Now Tracking
                        </div>
                        <div
                          key={s.id}
                          style={{
                            display: "flex", alignItems: "center", gap: 10,
                            padding: "12px 14px",
                            background: "rgba(106,255,201,0.05)",
                            borderRadius: 8,
                            border: "1px solid rgba(106,255,201,0.25)",
                            transition: "background 0.12s",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleSelect(s.id)}
                            style={{ accentColor: "#58a6ff", flexShrink: 0, cursor: "pointer" }}
                          />
                          <span
                            className="material-symbols-outlined"
                            style={{ fontSize: 16, color: "#6affc9", flexShrink: 0 }}
                          >
                            {appIcon(s.app_name)}
                          </span>
                          <span style={{
                            fontFamily: "Roboto Mono, monospace", fontSize: 11,
                            color: "#6affc9", flexShrink: 0, minWidth: 50,
                          }}>
                            {fmtTime(s.start_time)} →
                          </span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            {isEditing ? (
                              <input
                                autoFocus
                                value={editName}
                                onChange={(e) => setEditName(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") handleRename(s.id);
                                  if (e.key === "Escape") { setEditingId(null); setEditName(""); }
                                }}
                                onBlur={() => handleRename(s.id)}
                                style={{
                                  background: "#0d1117", border: "1px solid rgba(106,255,201,0.4)",
                                  borderRadius: 4, color: "#f6f6fc", fontSize: 12,
                                  padding: "3px 7px", outline: "none", width: "100%",
                                }}
                                placeholder="What are you working on?"
                              />
                            ) : (
                              <span style={{
                                fontSize: 13, color: "#f6f6fc", fontWeight: 500,
                                display: "block", overflow: "hidden",
                                textOverflow: "ellipsis", whiteSpace: "nowrap",
                              }}>
                                {s.app_name}
                                {s.task_name && (
                                  <span style={{ color: "#6affc9", fontWeight: 400 }}>
                                    {" · "}{s.task_name}
                                  </span>
                                )}
                              </span>
                            )}
                          </div>
                          <span style={{
                            fontFamily: "Roboto Mono, monospace",
                            fontSize: 12, color: "#6affc9", fontWeight: 700, flexShrink: 0,
                          }}>
                            {fmtDuration(liveSecs)}
                          </span>
                          <button
                            onClick={() => { setEditingId(s.id); setEditName(s.task_name ?? ""); }}
                            title="Name this session"
                            style={{ background: "none", border: "none", cursor: "pointer", color: "#6affc9", padding: 2, flexShrink: 0 }}
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: 15 }}>edit</span>
                          </button>
                          {linkedWs && (
                            <span style={{
                              fontSize: 10, padding: "1px 7px", borderRadius: 10,
                              background: `${linkedWs.color}22`, color: linkedWs.color,
                              border: `1px solid ${linkedWs.color}44`,
                              fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0,
                            }}>
                              {linkedWs.name}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {/* ── 2. GROUPED container (Tagged Sessions) ── */}
                  {groupItems.length > 0 && (
                    <div style={{ marginBottom: 20 }}>
                      <div style={{
                        fontSize: 10, color: "#484f58", fontFamily: "Roboto Mono, monospace",
                        letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8,
                      }}>
                        Tagged Sessions
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {groupItems.map((item) => {
                          const isCollapsed = collapsedGroups.has(item.task_name);
                          return (
                            <div key={`group-${item.task_name}`} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                              {/* Group header row */}
                              <div style={{
                                display: "flex", alignItems: "center", gap: 8,
                                padding: "7px 14px",
                                background: "rgba(88,166,255,0.05)",
                                borderRadius: 8,
                                border: "1px solid rgba(88,166,255,0.15)",
                              }}>
                                {/* Collapse toggle */}
                                <button
                                  onClick={() => setCollapsedGroups(prev => {
                                    const n = new Set(prev);
                                    n.has(item.task_name) ? n.delete(item.task_name) : n.add(item.task_name);
                                    return n;
                                  })}
                                  style={{ background: "none", border: "none", color: "#8b949e", cursor: "pointer", padding: 2, display: "flex", alignItems: "center", flexShrink: 0 }}
                                >
                                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                                    {isCollapsed ? "chevron_right" : "expand_more"}
                                  </span>
                                </button>

                                <span className="material-symbols-outlined" style={{ fontSize: 14, color: "#58a6ff" }}>
                                  label
                                </span>

                                {editingGroup === item.task_name ? (
                                  <>
                                    <input
                                      autoFocus
                                      value={editGroupName}
                                      onChange={(e) => setEditGroupName(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") handleRenameGroup(item.task_name);
                                        if (e.key === "Escape") { setEditingGroup(null); setEditGroupName(""); }
                                      }}
                                      style={{ ...inlineInput, flex: 1, fontSize: 12, fontWeight: 700 }}
                                    />
                                    <button onClick={() => handleRenameGroup(item.task_name)} style={pillBtn("#3fb950", "#0d1117")}>Save</button>
                                    <button onClick={() => { setEditingGroup(null); setEditGroupName(""); }} style={pillBtn("rgba(255,255,255,0.08)", "#8b949e")}>✕</button>
                                  </>
                                ) : (
                                  <>
                                    <span style={{ fontSize: 12, fontWeight: 700, color: "#58a6ff", flex: 1 }}>
                                      {item.task_name}
                                    </span>
                                    <span style={{
                                      fontSize: 10, color: "#484f58",
                                      fontFamily: "Roboto Mono, monospace",
                                      marginRight: 6,
                                    }}>
                                      {item.sessions.length} session{item.sessions.length !== 1 ? "s" : ""}
                                    </span>
                                    <span style={{
                                      fontSize: 12, fontWeight: 700, color: "#58a6ff",
                                      fontFamily: "Roboto Mono, monospace",
                                      marginRight: 4,
                                    }}>
                                      {fmtDuration(item.total_secs)}
                                    </span>
                                    <button
                                      onClick={() => { setEditingGroup(item.task_name); setEditGroupName(item.task_name); }}
                                      title="Rename group"
                                      style={{ background: "none", border: "none", color: "#484f58", cursor: "pointer", padding: "2px 4px", borderRadius: 4, display: "flex", alignItems: "center" }}
                                      onMouseEnter={(e) => (e.currentTarget.style.color = "#58a6ff")}
                                      onMouseLeave={(e) => (e.currentTarget.style.color = "#484f58")}
                                    >
                                      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>edit</span>
                                    </button>
                                  </>
                                )}
                              </div>
                              {/* Sessions within group — indented, only when not collapsed */}
                              {!isCollapsed && (
                                <div style={{ display: "flex", flexDirection: "column", gap: 3, paddingLeft: 12 }}>
                                  {item.sessions.map((s) => {
                                    const isSelected = selected.has(s.id);
                                    const isEditing = editingId === s.id;
                                    const linkedWs = workSessions.find((w) => w.id === s.work_session_id);
                                    const suggestions = isEditing
                                      ? taskNames.filter((n) => n !== s.task_name && n.toLowerCase().includes(editName.toLowerCase())).slice(0, 6)
                                      : [];
                                    return (
                                      <div key={s.id} style={{ display: "flex", flexDirection: "column" }}>
                                        <div style={{
                                          display: "flex", alignItems: "center", gap: 10,
                                          padding: "9px 14px",
                                          background: isSelected ? "rgba(88,166,255,0.07)" : "#0d1117",
                                          borderRadius: 8,
                                          border: isSelected ? "1px solid rgba(88,166,255,0.28)" : "1px solid rgba(255,255,255,0.04)",
                                          borderLeft: "2px solid rgba(88,166,255,0.35)",
                                        }}>
                                          <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(s.id)} style={{ width: 14, height: 14, cursor: "pointer", accentColor: "#58a6ff", flexShrink: 0 }} />
                                          <div style={{ width: 28, height: 28, borderRadius: 7, background: `${appColor(s.app_name)}18`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                                            <span className="material-symbols-outlined" style={{ fontSize: 14, color: appColor(s.app_name) }}>{appIcon(s.app_name)}</span>
                                          </div>
                                          <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                              <span style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.app_name}</span>
                                              {linkedWs && <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 10, background: `${linkedWs.color}22`, color: linkedWs.color, border: `1px solid ${linkedWs.color}44`, fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>{linkedWs.name}</span>}
                                            </div>
                                            {isEditing ? (
                                              <div style={{ display: "flex", gap: 6, marginTop: 4, position: "relative" }}>
                                                <div style={{ position: "relative", flex: 1 }}>
                                                  <input autoFocus value={editName} onChange={(e) => setEditName(e.target.value)}
                                                    onKeyDown={(e) => { if (e.key === "Enter") handleRename(s.id); if (e.key === "Escape") { setEditingId(null); setEditName(""); } }}
                                                    placeholder="Task name…" style={inlineInput} />
                                                  {suggestions.length > 0 && (
                                                    <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, background: "#1c2128", border: "1px solid rgba(88,166,255,0.3)", borderRadius: 6, zIndex: 100, overflow: "hidden" }}>
                                                      {suggestions.map((name) => (
                                                        <div key={name} onClick={() => { setEditName(name); setTimeout(() => handleRename(s.id), 0); }}
                                                          style={{ padding: "7px 12px", fontSize: 12, color: "#c9d1d9", cursor: "pointer", borderBottom: "1px solid rgba(255,255,255,0.04)" }}
                                                          onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(88,166,255,0.1)"; e.currentTarget.style.color = "#58a6ff"; }}
                                                          onMouseLeave={(e) => { e.currentTarget.style.background = ""; e.currentTarget.style.color = "#c9d1d9"; }}>
                                                          {name}
                                                        </div>
                                                      ))}
                                                    </div>
                                                  )}
                                                </div>
                                                <button onClick={() => handleRename(s.id)} style={pillBtn("#3fb950", "#0d1117")}>Salva</button>
                                                <button onClick={() => { setEditingId(null); setEditName(""); }} style={pillBtn("rgba(255,255,255,0.08)", "#8b949e")}>✕</button>
                                              </div>
                                            ) : null}
                                          </div>
                                          <div style={{ textAlign: "right", flexShrink: 0 }}>
                                            <div style={{ fontSize: 11, fontFamily: "Roboto Mono, monospace", color: "#8b949e", marginBottom: 2 }}>{fmtTime(s.start_time)}{s.end_time ? ` – ${fmtTime(s.end_time)}` : " →"}</div>
                                            <div style={{ fontSize: 12, fontFamily: "Roboto Mono, monospace", color: "#58a6ff", fontWeight: 700 }}>{s.duration ? fmtDuration(s.duration) : "…"}</div>
                                          </div>
                                          <button onClick={() => { setEditingId(s.id); setEditName(s.task_name ?? ""); }} title="Edit task name" style={{ background: "none", border: "none", color: "#484f58", cursor: "pointer", padding: 4, borderRadius: 4, display: "flex", alignItems: "center", flexShrink: 0 }} onMouseEnter={(e) => (e.currentTarget.style.color = "#8b949e")} onMouseLeave={(e) => (e.currentTarget.style.color = "#484f58")}>
                                            <span className="material-symbols-outlined" style={{ fontSize: 15 }}>edit</span>
                                          </button>
                                          <button onClick={() => setConfirmDeleteId(s.id)} title="Delete session" style={{ background: "none", border: "none", color: "#484f58", cursor: "pointer", padding: 4, borderRadius: 4, display: "flex", alignItems: "center", flexShrink: 0 }} onMouseEnter={(e) => (e.currentTarget.style.color = "#f85149")} onMouseLeave={(e) => (e.currentTarget.style.color = "#484f58")}>
                                            <span className="material-symbols-outlined" style={{ fontSize: 15 }}>delete</span>
                                          </button>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* ── 3. ORPHANS container (Unlabelled) ── */}
                  {singleItems.length > 0 && (
                    <div style={{ marginBottom: 20 }}>
                      <div style={{
                        fontSize: 10, color: "#484f58", fontFamily: "Roboto Mono, monospace",
                        letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8,
                      }}>
                        Unlabelled
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {singleItems.map((item) => {
                          const s = item.session;
                          const isSelected = selected.has(s.id);
                          const isEditing = editingId === s.id;
                          const linkedWs = workSessions.find((w) => w.id === s.work_session_id);
                          const suggestions = isEditing
                            ? taskNames.filter((n) => n.toLowerCase().includes(editName.toLowerCase())).slice(0, 6)
                            : [];
                          return (
                            <div key={s.id} style={{ display: "flex", flexDirection: "column" }}>
                              <div style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 10,
                                padding: "10px 14px",
                                background: isSelected ? "rgba(88,166,255,0.07)" : "#161b22",
                                borderRadius: 8,
                                border: isSelected
                                  ? "1px solid rgba(88,166,255,0.28)"
                                  : "1px solid rgba(255,255,255,0.06)",
                                transition: "background 0.12s, border-color 0.12s",
                              }}>
                                <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(s.id)} style={{ width: 14, height: 14, cursor: "pointer", accentColor: "#58a6ff", flexShrink: 0 }} />
                                <div style={{ width: 30, height: 30, borderRadius: 7, background: `${appColor(s.app_name)}18`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                                  <span className="material-symbols-outlined" style={{ fontSize: 16, color: appColor(s.app_name) }}>{appIcon(s.app_name)}</span>
                                </div>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: isEditing || s.task_name ? 3 : 0 }}>
                                    <span style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.app_name}</span>
                                    {s.status === "confirmed" && <span className="material-symbols-outlined" style={{ fontSize: 13, color: "#3fb950", flexShrink: 0 }}>check_circle</span>}
                                    {linkedWs && <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 10, background: `${linkedWs.color}22`, color: linkedWs.color, border: `1px solid ${linkedWs.color}44`, fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>{linkedWs.name}</span>}
                                  </div>
                                  {isEditing ? (
                                    <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                                      <div style={{ position: "relative", flex: 1 }}>
                                        <input autoFocus value={editName} onChange={(e) => setEditName(e.target.value)}
                                          onKeyDown={(e) => { if (e.key === "Enter") handleRename(s.id); if (e.key === "Escape") { setEditingId(null); setEditName(""); } }}
                                          placeholder="Task name…" style={inlineInput} />
                                        {suggestions.length > 0 && (
                                          <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, background: "#1c2128", border: "1px solid rgba(88,166,255,0.3)", borderRadius: 6, zIndex: 100, overflow: "hidden" }}>
                                            {suggestions.map((name) => (
                                              <div key={name} onClick={() => { setEditName(name); setTimeout(() => handleRename(s.id), 0); }}
                                                style={{ padding: "7px 12px", fontSize: 12, color: "#c9d1d9", cursor: "pointer", borderBottom: "1px solid rgba(255,255,255,0.04)" }}
                                                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(88,166,255,0.1)"; e.currentTarget.style.color = "#58a6ff"; }}
                                                onMouseLeave={(e) => { e.currentTarget.style.background = ""; e.currentTarget.style.color = "#c9d1d9"; }}>
                                                {name}
                                              </div>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                      <button onClick={() => handleRename(s.id)} style={pillBtn("#3fb950", "#0d1117")}>Salva</button>
                                      <button onClick={() => { setEditingId(null); setEditName(""); }} style={pillBtn("rgba(255,255,255,0.08)", "#8b949e")}>✕</button>
                                    </div>
                                  ) : (
                                    s.task_name && (
                                      <span style={{ fontSize: 11, color: "#8b949e", fontStyle: "italic" }}>{s.task_name}</span>
                                    )
                                  )}
                                </div>
                                <div style={{ textAlign: "right", flexShrink: 0 }}>
                                  <div style={{ fontSize: 11, fontFamily: "Roboto Mono, monospace", color: "#8b949e", marginBottom: 2 }}>{fmtTime(s.start_time)}{s.end_time ? ` – ${fmtTime(s.end_time)}` : " →"}</div>
                                  <div style={{ fontSize: 12, fontFamily: "Roboto Mono, monospace", color: "#58a6ff", fontWeight: 700 }}>{s.duration ? fmtDuration(s.duration) : "…"}</div>
                                </div>
                                <button onClick={() => { setEditingId(s.id); setEditName(s.task_name ?? ""); }} title="Edit task name"
                                  style={{ background: "none", border: "none", color: "#484f58", cursor: "pointer", padding: 4, borderRadius: 4, display: "flex", alignItems: "center", flexShrink: 0, transition: "color 0.12s" }}
                                  onMouseEnter={(e) => (e.currentTarget.style.color = "#8b949e")} onMouseLeave={(e) => (e.currentTarget.style.color = "#484f58")}>
                                  <span className="material-symbols-outlined" style={{ fontSize: 15 }}>edit</span>
                                </button>
                                <button onClick={() => setConfirmDeleteId(s.id)} title="Delete session"
                                  style={{ background: "none", border: "none", color: "#484f58", cursor: "pointer", padding: 4, borderRadius: 4, display: "flex", alignItems: "center", flexShrink: 0, transition: "color 0.12s" }}
                                  onMouseEnter={(e) => (e.currentTarget.style.color = "#f85149")} onMouseLeave={(e) => (e.currentTarget.style.color = "#484f58")}>
                                  <span className="material-symbols-outlined" style={{ fontSize: 15 }}>delete</span>
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              )}
            </section>

            {/* ── Work Sessions Panel ── */}
            {workSessions.length > 0 && (
              <section style={{ marginBottom: 80 }}>
                <span style={{ ...sectionLabel, display: "block", marginBottom: 10 }}>
                  Work Sessions
                </span>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {workSessions.map((ws) => (
                    <div
                      key={ws.id}
                      style={{
                        padding: "12px 16px",
                        background: "#161b22",
                        borderRadius: 8,
                        border: `1px solid ${ws.color}2a`,
                        display: "flex",
                        alignItems: editingWsId === ws.id ? "flex-start" : "center",
                        gap: 12,
                      }}
                    >
                      {/* Color dot */}
                      <div
                        style={{
                          width: 10, height: 10, borderRadius: "50%",
                          background: ws.color, flexShrink: 0,
                          marginTop: editingWsId === ws.id ? 4 : 0,
                        }}
                      />

                      {editingWsId === ws.id ? (
                        /* ── Edit mode ── */
                        <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
                          {/* Name input */}
                          <input
                            autoFocus
                            value={editWsName}
                            onChange={e => setEditWsName(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === "Enter") handleUpdateWorkSession(ws.id);
                              if (e.key === "Escape") { setEditingWsId(null); }
                            }}
                            style={inlineInput}
                            placeholder="Work session name…"
                          />
                          {/* Project picker — chip buttons */}
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            <button
                              onClick={() => setEditWsProjectId(null)}
                              style={{
                                padding: "2px 10px", borderRadius: 10, fontSize: 11,
                                background: editWsProjectId === null ? "rgba(139,148,158,0.2)" : "transparent",
                                border: editWsProjectId === null ? "1px solid #8b949e" : "1px solid rgba(255,255,255,0.1)",
                                color: editWsProjectId === null ? "#e6edf3" : "#8b949e",
                                cursor: "pointer",
                              }}
                            >
                              No project
                            </button>
                            {projects.map(p => (
                              <button
                                key={p.id}
                                onClick={() => setEditWsProjectId(p.id)}
                                style={{
                                  padding: "2px 10px", borderRadius: 10, fontSize: 11,
                                  background: editWsProjectId === p.id ? `${p.color}22` : "transparent",
                                  border: editWsProjectId === p.id ? `1px solid ${p.color}` : "1px solid rgba(255,255,255,0.1)",
                                  color: editWsProjectId === p.id ? p.color : "#8b949e",
                                  cursor: "pointer",
                                }}
                              >
                                {p.name}
                              </button>
                            ))}
                          </div>
                          {/* Save / cancel */}
                          <div style={{ display: "flex", gap: 6 }}>
                            <button onClick={() => handleUpdateWorkSession(ws.id)} style={pillBtn("#3fb950", "#0d1117")}>Save</button>
                            <button onClick={() => setEditingWsId(null)} style={pillBtn("rgba(255,255,255,0.08)", "#8b949e")}>✕</button>
                          </div>
                        </div>
                      ) : (
                        /* ── Display mode ── */
                        <>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div
                              style={{
                                fontSize: 13, fontWeight: 600, color: "#e6edf3", marginBottom: 2,
                                display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
                              }}
                            >
                              {ws.name}
                              {ws.project_name && (
                                <span style={{
                                  padding: '2px 8px',
                                  borderRadius: 4,
                                  background: `${ws.project_color ?? '#6affc9'}22`,
                                  border: `1px solid ${ws.project_color ?? '#6affc9'}44`,
                                  color: ws.project_color ?? '#6affc9',
                                  fontSize: 11,
                                  fontWeight: 500,
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 4,
                                }}>
                                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: ws.project_color ?? '#6affc9', display: 'inline-block' }} />
                                  {ws.project_name}
                                </span>
                              )}
                            </div>
                            <div style={{ fontSize: 11, color: "#8b949e" }}>
                              {ws.app_names || "—"}{" · "}
                              <span
                                style={{ fontFamily: "Roboto Mono, monospace", color: ws.color }}
                              >
                                {fmtDuration(ws.total_secs)}
                              </span>
                              {" · "}
                              {ws.session_count} session{ws.session_count !== 1 ? "i" : "e"}
                            </div>
                          </div>

                          {/* Edit button */}
                          <button
                            onClick={() => { setEditingWsId(ws.id); setEditWsName(ws.name); setEditWsProjectId(ws.project_id ?? null); }}
                            title="Edit work session"
                            style={{
                              background: "none", border: "none", color: "#484f58",
                              cursor: "pointer", padding: 4, borderRadius: 4,
                              display: "flex", alignItems: "center",
                              transition: "color 0.12s",
                            }}
                            onMouseEnter={(e) => (e.currentTarget.style.color = "#8b949e")}
                            onMouseLeave={(e) => (e.currentTarget.style.color = "#484f58")}
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                              edit
                            </span>
                          </button>

                          {/* Delete button */}
                          <button
                            onClick={() => handleDeleteWorkSession(ws.id)}
                            title="Elimina work session"
                            style={{
                              background: "none", border: "none", color: "#484f58",
                              cursor: "pointer", padding: 4, borderRadius: 4,
                              display: "flex", alignItems: "center",
                              transition: "color 0.12s",
                            }}
                            onMouseEnter={(e) => (e.currentTarget.style.color = "#f85149")}
                            onMouseLeave={(e) => (e.currentTarget.style.color = "#484f58")}
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                              delete
                            </span>
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* ── Empty state ── */}
            {sessions.length === 0 && summary.length === 0 && (
              <div style={{ textAlign: "center", paddingTop: 64, color: "#484f58" }}>
                <span
                  className="material-symbols-outlined"
                  style={{ fontSize: 48, display: "block", marginBottom: 12 }}
                >
                  query_stats
                </span>
                <div style={{ fontSize: 13, marginBottom: 6 }}>
                  Nessuna attività tracciata per {isToday ? "oggi" : date}.
                </div>
                <div style={{ fontSize: 12 }}>
                  Abilita le app nella whitelist per iniziare il tracking.
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Floating "Group Selected" button ── */}
      {selected.size >= 1 && !showGroupDialog && (
        <div
          style={{
            position: "fixed",
            bottom: 28,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 100,
          }}
        >
          <button
            onClick={() => setShowGroupDialog(true)}
            style={{
              background: "#58a6ff",
              color: "#0d1117",
              border: "none",
              borderRadius: 22,
              padding: "11px 26px",
              fontWeight: 700,
              fontSize: 13,
              cursor: "pointer",
              boxShadow: "0 4px 24px rgba(88,166,255,0.45)",
              display: "flex",
              alignItems: "center",
              gap: 8,
              letterSpacing: "0.01em",
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
              folder_special
            </span>
            Raggruppa {selected.size} session{selected.size > 1 ? "i" : "e"}
          </button>
        </div>
      )}

      {/* ── Delete Confirm Dialog ── */}
      {confirmDeleteId !== null && (
        <div
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.72)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 300,
          }}
          onClick={() => setConfirmDeleteId(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#161b22", borderRadius: 10, padding: "28px 32px",
              border: "1px solid rgba(248,81,73,0.3)", maxWidth: 340, width: "100%",
              display: "flex", flexDirection: "column", gap: 20,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className="material-symbols-outlined" style={{ color: "#f85149", fontSize: 22 }}>
                delete
              </span>
              <span style={{ fontSize: 15, fontWeight: 600, color: "#f6f6fc" }}>
                Delete session?
              </span>
            </div>
            <p style={{ fontSize: 13, color: "#8b949e", margin: 0, lineHeight: 1.5 }}>
              This session will be permanently removed and cannot be undone.
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                onClick={() => setConfirmDeleteId(null)}
                style={{
                  padding: "8px 18px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.1)",
                  background: "transparent", color: "#8b949e", fontSize: 13, cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  await handleDeleteSession(confirmDeleteId);
                  setConfirmDeleteId(null);
                }}
                style={{
                  padding: "8px 18px", borderRadius: 6, border: "none",
                  background: "#f85149", color: "#fff", fontSize: 13,
                  fontWeight: 600, cursor: "pointer",
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Group Dialog ── */}
      {showGroupDialog && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.72)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 200,
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowGroupDialog(false); }}
        >
          <div
            style={{
              background: "#161b22",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 14,
              padding: "28px 32px",
              width: 400,
              boxShadow: "0 20px 60px rgba(0,0,0,0.7)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <span
                className="material-symbols-outlined"
                style={{ fontSize: 22, color: "#58a6ff" }}
              >
                folder_special
              </span>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#e6edf3" }}>
                Crea Work Session
              </h3>
            </div>
            <p style={{ margin: "0 0 20px", fontSize: 12, color: "#8b949e", lineHeight: 1.5 }}>
              Raggruppa {selected.size} session{selected.size > 1 ? "i" : "e"} in un blocco
              di lavoro con nome e colore.
            </p>

            <input
              autoFocus
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateWorkSession();
                if (e.key === "Escape") setShowGroupDialog(false);
              }}
              placeholder="es. Sprint Planning, Deep Work…"
              style={{ ...inlineInput, width: "100%", boxSizing: "border-box" }}
            />

            {/* ── Project selector ── */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
              <span style={{ fontSize: 11, color: '#74757a', fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                Project (optional)
              </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {/* "None" chip */}
                <button
                  onClick={() => setSelectedProject(null)}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 4,
                    border: `1px solid ${selectedProject === null ? '#6affc9' : 'rgba(255,255,255,0.1)'}`,
                    background: selectedProject === null ? 'rgba(106,255,201,0.1)' : 'transparent',
                    color: selectedProject === null ? '#6affc9' : '#74757a',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  None
                </button>

                {/* Existing project chips */}
                {projects.map(p => (
                  <button
                    key={p.id}
                    onClick={() => setSelectedProject(p.id)}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 4,
                      border: `1px solid ${selectedProject === p.id ? p.color : 'rgba(255,255,255,0.1)'}`,
                      background: selectedProject === p.id ? `${p.color}22` : 'transparent',
                      color: selectedProject === p.id ? p.color : '#aaabb0',
                      fontSize: 12,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, display: 'inline-block' }} />
                    {p.name}
                  </button>
                ))}

                {/* New project inline */}
                {!showNewProject ? (
                  <button
                    onClick={() => setShowNewProject(true)}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 4,
                      border: '1px dashed rgba(255,255,255,0.2)',
                      background: 'transparent',
                      color: '#74757a',
                      fontSize: 12,
                      cursor: 'pointer',
                    }}
                  >
                    + New project
                  </button>
                ) : (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      autoFocus
                      value={newProjectName}
                      onChange={e => setNewProjectName(e.target.value)}
                      onKeyDown={async e => {
                        if (e.key === 'Enter' && newProjectName.trim()) {
                          const p = await createProject(newProjectName.trim());
                          setProjects(prev => [...prev, p]);
                          setSelectedProject(p.id);
                          setNewProjectName('');
                          setShowNewProject(false);
                        }
                        if (e.key === 'Escape') { setShowNewProject(false); setNewProjectName(''); }
                      }}
                      placeholder="Project name…"
                      style={{
                        background: '#23262c',
                        border: '1px solid rgba(106,255,201,0.3)',
                        borderRadius: 4,
                        color: '#f6f6fc',
                        fontSize: 12,
                        padding: '4px 8px',
                        outline: 'none',
                        width: 140,
                      }}
                    />
                  </div>
                )}
              </div>
            </div>

            <div
              style={{
                display: "flex",
                gap: 10,
                marginTop: 16,
                justifyContent: "flex-end",
              }}
            >
              <button
                onClick={() => setShowGroupDialog(false)}
                style={pillBtn("rgba(255,255,255,0.07)", "#8b949e")}
              >
                Annulla
              </button>
              <button
                onClick={handleCreateWorkSession}
                disabled={!groupName.trim()}
                style={{
                  ...pillBtn("#58a6ff", "#0d1117"),
                  opacity: groupName.trim() ? 1 : 0.4,
                  cursor: groupName.trim() ? "pointer" : "not-allowed",
                }}
              >
                Crea
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pulse animation for LIVE indicator */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}

// ─── Shared style constants ───────────────────────────────────────────────────

const sectionLabel: React.CSSProperties = {
  fontSize: 10,
  fontFamily: "Roboto Mono, monospace",
  textTransform: "uppercase",
  letterSpacing: "0.13em",
  color: "#8b949e",
  fontWeight: 700,
};

const navBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#8b949e",
  cursor: "pointer",
  padding: 4,
  borderRadius: 4,
  display: "flex",
  alignItems: "center",
};

const inlineInput: React.CSSProperties = {
  background: "#0d1117",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 6,
  padding: "7px 11px",
  color: "#e6edf3",
  fontSize: 13,
  outline: "none",
};

function pillBtn(bg: string, color: string): React.CSSProperties {
  return {
    background: bg,
    color,
    border: "none",
    borderRadius: 6,
    padding: "7px 16px",
    fontWeight: 600,
    fontSize: 12,
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}
