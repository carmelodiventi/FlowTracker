import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import {
  dailySummary,
  listSessionsForDate,
  deleteSession,
  stopActiveSession,
  pauseTracking,
  resumeTracking,
  listWorkSessions,
  createWorkSession,
  updateWorkSession,
  deleteWorkSession,
  listProjects,
  createProject,
  assignWorkSessionProject,
  listSessionsForWorkSession,
  removeSessionFromWorkSession,
  addSessionToWorkSession,
} from "../api";
import type { Session, AppSummary, WorkSession, Project } from "../api";
import ExportModal from "../components/ExportModal";
import { suggestWorkSessionName, generateInvoiceDescription } from "../lib/ai";

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
  if (
    n.includes("chrome") ||
    n.includes("safari") ||
    n.includes("firefox") ||
    n.includes("browser")
  )
    return "language";
  if (n.includes("terminal") || n.includes("iterm") || n.includes("warp"))
    return "terminal";
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
  const { t } = useTranslation();
  const [date, setDate] = useState(todayISO());
  const [sessions, setSessions] = useState<Session[]>([]);
  const [summary, setSummary] = useState<AppSummary[]>([]);
  const [workSessions, setWorkSessions] = useState<WorkSession[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupName, setGroupName] = useState("");
  const [showGroupDialog, setShowGroupDialog] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmDeleteSelected, setConfirmDeleteSelected] = useState(false);
  const [liveSecs, setLiveSecs] = useState(0);
  const [loading, setLoading] = useState(true);

  // Projects state
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [showNewProject, setShowNewProject] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [groupMode, setGroupMode] = useState<"new" | "existing">("new");
  const [groupExistingWsId, setGroupExistingWsId] = useState<string | null>(null);

  // Collapsible groups state — kept for Work Session (Task) expand/collapse
  const [editingWsId, setEditingWsId] = useState<string | null>(null);
  const [editWsName, setEditWsName] = useState("");
  const [editWsProjectId, setEditWsProjectId] = useState<string | null>(null);
  const [collapsedWs, setCollapsedWs] = useState<Set<string>>(new Set());
  const [wsExpandedSessions, setWsExpandedSessions] = useState<
    Map<string, Session[]>
  >(new Map());
  const [suggestingWsId, setSuggestingWsId] = useState<string | null>(null);
  const [invoiceDescWsId, setInvoiceDescWsId] = useState<string | null>(null);
  const [invoiceDescText, setInvoiceDescText] = useState<string>("");
  const [generatingInvoiceWsId, setGeneratingInvoiceWsId] = useState<string | null>(null);
  const [isTrackingPaused, setIsTrackingPaused] = useState(false);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isToday = date === todayISO();

  // ── Data loading ────────────────────────────────────────────────────────────

  const initialLoadDone = useRef(false);

  const load = useCallback(async () => {
    // Only show the full-page spinner on the very first load
    if (!initialLoadDone.current) setLoading(true);
    try {
      const [sess, summ, ws, projs] = await Promise.all([
        listSessionsForDate(date).catch(() => [] as Session[]),
        dailySummary(date).catch(() => [] as AppSummary[]),
        listWorkSessions(date).catch(() => [] as WorkSession[]),
        listProjects().catch(() => [] as Project[]),
      ]);
      setSessions(sess);
      setSummary(summ);
      setWorkSessions(ws);
      setProjects(projs);
    } finally {
      if (!initialLoadDone.current) {
        initialLoadDone.current = true;
        setLoading(false);
      }
    }
  }, [date]);

  useEffect(() => {
    initialLoadDone.current = false;
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
            active.start_time.endsWith("Z")
              ? active.start_time
              : active.start_time + "Z",
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
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isToday, sessions.length]);

  // ── Derived values ──────────────────────────────────────────────────────────

  // Only the most recent active session is truly live — guard against stale DB rows.
  const activeSession = useMemo(
    () =>
      sessions
        .filter((s) => s.status === "active")
        .sort((a, b) => b.start_time.localeCompare(a.start_time))[0] ?? null,
    [sessions],
  );

  const totalRecorded = useMemo(
    () => summary.reduce((a, s) => a + s.total_secs, 0),
    [summary],
  );
  const totalSecs = totalRecorded + liveSecs;
  const maxSecs = summary[0]?.total_secs || 1;

  // Past sessions (excluding the currently active one)
  const pastSessions = useMemo(
    () => sessions.filter((s) => s.id !== activeSession?.id),
    [sessions, activeSession],
  );

  // Unlabelled = past sessions not yet assigned to any Task (work_session_id is null/0)
  const unlabelledSessions = useMemo(
    () => pastSessions.filter((s) => !s.work_session_id),
    [pastSessions],
  );

  // ── Handlers ────────────────────────────────────────────────────────────────

  const offsetDate = (delta: number) => {
    const d = new Date(date + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + delta);
    setDate(d.toISOString().slice(0, 10));
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleDeleteSession = async (id: string) => {
    await deleteSession(id).catch(console.error);
    setSelected((prev) => {
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
    await load();
  };

  const handleDeleteSelected = async () => {
    await Promise.all([...selected].map((id) => deleteSession(id).catch(console.error)));
    setSelected(new Set());
    setConfirmDeleteSelected(false);
    await load();
  };

  const resetGroupDialog = () => {
    setGroupName("");
    setSelectedProject(null);
    setShowNewProject(false);
    setNewProjectName("");
    setGroupMode("new");
    setGroupExistingWsId(null);
    setShowGroupDialog(false);
  };

  const handleCreateWorkSession = async () => {
    if (selected.size < 1 || !groupName.trim()) return;
    const ws = await createWorkSession(
      groupName.trim(),
      Array.from(selected),
    ).catch(console.error);
    if (ws && selectedProject !== null) {
      await assignWorkSessionProject(ws.id, selectedProject).catch(
        console.error,
      );
    }
    setSelected(new Set());
    resetGroupDialog();
    await load();
  };

  const handleAddToExistingWorkSession = async () => {
    if (selected.size < 1 || !groupExistingWsId) return;
    await Promise.all(
      Array.from(selected).map(sid => addSessionToWorkSession(sid, groupExistingWsId))
    ).catch(console.error);
    setSelected(new Set());
    resetGroupDialog();
    await load();
  };

  const handleDeleteWorkSession = async (id: string) => {
    await deleteWorkSession(id).catch(console.error);
    await load();
  };

  const handleUpdateWorkSession = async (id: string) => {
    const trimmed = editWsName.trim();
    if (trimmed) await updateWorkSession(id, trimmed).catch(console.error);
    await assignWorkSessionProject(id, editWsProjectId).catch(console.error);
    setEditingWsId(null);
    setEditWsName("");
    setEditWsProjectId(null);
    await load();
  };

  const handleSuggestWsName = async (ws: WorkSession) => {
    setSuggestingWsId(ws.id);
    // Build app usage list from sessions assigned to this work session
    const wsSessions = wsExpandedSessions.get(ws.id) ?? await listSessionsForWorkSession(ws.id).catch(() => [] as Session[]);
    const appMap = new Map<string, number>();
    for (const s of wsSessions) {
      appMap.set(s.app_name, (appMap.get(s.app_name) ?? 0) + (s.duration ?? 0));
    }
    // Fallback: use daily summary if no sessions loaded
    const usages = appMap.size > 0
      ? Array.from(appMap.entries()).map(([app, duration_secs]) => ({ app, duration_secs }))
      : summary.map((s) => ({ app: s.app_name, duration_secs: s.total_secs }));

    const suggestion = await suggestWorkSessionName(usages);
    setSuggestingWsId(null);
    if (suggestion) {
      setEditWsName(suggestion);
    }
  };

  const handleGenerateInvoiceDesc = async (ws: WorkSession) => {
    setGeneratingInvoiceWsId(ws.id);
    setInvoiceDescWsId(ws.id);
    setInvoiceDescText("");
    const wsSessions = wsExpandedSessions.get(ws.id) ?? await listSessionsForWorkSession(ws.id).catch(() => [] as Session[]);
    const apps = [...new Set(wsSessions.map((s) => s.app_name))];
    const desc = await generateInvoiceDescription({
      sessionName: ws.name,
      projectName: ws.project_name ?? undefined,
      durationHours: ws.total_secs / 3600,
      apps,
    });
    setGeneratingInvoiceWsId(null);
    setInvoiceDescText(desc ?? "Could not generate description — check your AI settings.");
  };

  const handleToggleWsCollapse = async (wsId: string) => {
    setCollapsedWs((prev) => {
      const next = new Set(prev);
      if (next.has(wsId)) {
        next.delete(wsId);
        // also clear cached sessions when collapsing
        setWsExpandedSessions((m) => {
          const nm = new Map(m);
          nm.delete(wsId);
          return nm;
        });
      } else {
        next.add(wsId);
        // Fetch sessions when expanding
        listSessionsForWorkSession(wsId)
          .then((sessions) => {
            setWsExpandedSessions((m) => new Map(m).set(wsId, sessions));
          })
          .catch(console.error);
      }
      return next;
    });
  };

  const handleRemoveSessionFromWs = async (sessionId: string, wsId: string) => {
    await removeSessionFromWorkSession(sessionId).catch(console.error);
    // Refresh the expanded list
    const updated = await listSessionsForWorkSession(wsId).catch(
      () => [] as Session[],
    );
    setWsExpandedSessions((m) => new Map(m).set(wsId, updated));
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
          position: "relative",
          top: 0,
          zIndex: 20,
        }}
      >
        {/* Left: title + date nav */}
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <h1
              style={{
                fontFamily: "'Inter', sans-serif",
                fontWeight: 800,
                fontSize: 18,
                letterSpacing: "-0.03em",
                color: "#f6f6fc",
                margin: 0,
              }}
            >
            {t("dashboard.timeline")}
            </h1>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <button onClick={() => offsetDate(-1)} style={navBtnStyle}>
              <span
                className="material-symbols-outlined"
                style={{ fontSize: 16 }}
              >
                chevron_left
              </span>
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
              {isToday ? t("dashboard.today") : date}
            </button>
            <button
              onClick={() => offsetDate(1)}
              disabled={isToday}
              style={{ ...navBtnStyle, opacity: isToday ? 0.3 : 1 }}
            >
              <span
                className="material-symbols-outlined"
                style={{ fontSize: 16 }}
              >
                chevron_right
              </span>
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

        {/* Right: export + compact daily total */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            onClick={() => setShowExport(true)}
            title="Export time report"
            style={{
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 6,
              color: "#aaabb0",
              cursor: "pointer",
              padding: "4px 10px",
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            <span
              className="material-symbols-outlined"
              style={{ fontSize: 15 }}
            >
              download
            </span>
            {t("dashboard.export")}
          </button>
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
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "#6affc9",
                  display: "inline-block",
                  animation: "pulse 1.4s infinite",
                }}
              />
              {t("dashboard.live")}
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
          <span
            style={{
              fontSize: 10,
              color: "#74757a",
              fontWeight: 500,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            {t("dashboard.dailyTotal")}
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
          <div
            style={{
              color: "#8b949e",
              textAlign: "center",
              paddingTop: 80,
              fontSize: 14,
            }}
          >
            {t("dashboard.loading")}
          </div>
        ) : (
          <>
            {/* ── Hero: Date + Big Timer ── */}
            <section style={{ marginBottom: 36 }}>
              <p
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: "#aaabb0",
                  fontFamily: "'Inter', sans-serif",
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                  marginBottom: 6,
                }}
              >
                {new Date(date + "T12:00:00").toLocaleDateString("en-US", {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })}
              </p>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
                <h2
                  style={{
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 64,
                    fontWeight: 800,
                    color: "#f6f6fc",
                    letterSpacing: "-0.04em",
                    lineHeight: 1,
                    margin: 0,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {fmtClock(totalSecs)}
                </h2>
                {isToday && (
                  <span
                    style={{
                      fontFamily: "Roboto Mono, monospace",
                      fontSize: 13,
                      fontWeight: 500,
                      color: "#6affc9",
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                    }}
                  >
                    {liveSecs > 0 ? `● ${t("dashboard.activeFlow")}` : t("dashboard.activeFlow")}
                  </span>
                )}
              </div>
              {isToday && (
                <div style={{ marginTop: 14 }}>
                  <button
                    onClick={async () => {
                      if (isTrackingPaused) {
                        await resumeTracking().catch(console.error);
                        setIsTrackingPaused(false);
                      } else {
                        await pauseTracking().catch(console.error);
                        setIsTrackingPaused(true);
                      }
                      await load();
                    }}
                    title={isTrackingPaused ? "Resume tracking" : "Pause tracking"}
                    style={{
                      background: isTrackingPaused ? "rgba(255,184,28,0.1)" : "rgba(88,166,255,0.1)",
                      border: isTrackingPaused ? "1px solid rgba(255,184,28,0.3)" : "1px solid rgba(88,166,255,0.3)",
                      borderRadius: 6,
                      padding: "6px 12px",
                      color: isTrackingPaused ? "#ffc107" : "#58a6ff",
                      cursor: "pointer",
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: "0.04em",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      transition: "background 0.12s",
                    }}
                    onMouseEnter={(e) => {
                      if (isTrackingPaused) {
                        e.currentTarget.style.background = "rgba(255,184,28,0.2)";
                      } else {
                        e.currentTarget.style.background = "rgba(88,166,255,0.2)";
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (isTrackingPaused) {
                        e.currentTarget.style.background = "rgba(255,184,28,0.1)";
                      } else {
                        e.currentTarget.style.background = "rgba(88,166,255,0.1)";
                      }
                    }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                      {isTrackingPaused ? "play_circle" : "pause_circle"}
                    </span>
                    {isTrackingPaused ? t("dashboard.resume") : t("dashboard.pause")}
                  </button>
                </div>
              )}
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
                <span style={sectionLabel}>{t("dashboard.applicationDistribution")}</span>
                <span
                  style={{
                    fontFamily: "Roboto Mono, monospace",
                    fontSize: 11,
                    color: "#8b949e",
                    letterSpacing: "0.04em",
                  }}
                >
                  {t("dashboard.totalRecorded")}: {fmtClock(totalRecorded)}
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
                  <div
                    style={{ display: "flex", flexDirection: "column", gap: 7 }}
                  >
                    {summary.map((app) => (
                      <div
                        key={app.process_name}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                        }}
                      >
                        <div
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: 2,
                            background: appColor(app.app_name),
                            flexShrink: 0,
                          }}
                        />
                        <span
                          style={{
                            fontSize: 12,
                            color: "#c9d1d9",
                            flex: "0 0 140px",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {app.app_name}
                        </span>
                        <div
                          style={{
                            flex: 1,
                            height: 4,
                            background: "rgba(255,255,255,0.05)",
                            borderRadius: 2,
                            overflow: "hidden",
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
                            fontSize: 11,
                            color: "#8b949e",
                            width: 60,
                            textAlign: "right",
                            flexShrink: 0,
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
                    {["08:00", "10:00", "12:00", "14:00", "16:00", "18:00"].map(
                      (t) => (
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
                      ),
                    )}
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
                  {t("dashboard.noActivity")}
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
                    display: "flex",
                    height: "auto",
                    background: "#161b22",
                    borderRadius: 8,
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 12,
                    border: "1px solid rgba(255,255,255,0.05)",
                  }}
                >
                  <span
                    className="material-symbols-outlined"
                    style={{ fontSize: 40, display: "block", marginBottom: 8 }}
                  >
                    timeline
                  </span>
                  <span style={{ fontSize: 13 }}>
                    {t("dashboard.noSessions", { date: isToday ? t("dashboard.today").toLowerCase() : date })}
                  </span>
                </div>
              ) : (
                <>
                  {/* ── 1. LIVE container ── */}
                  {activeSession &&
                    (() => {
                      const s = activeSession;
                      const isSelected = selected.has(s.id);
                      const linkedWs = workSessions.find(
                        (w) => w.id === s.work_session_id,
                      );
                      return (
                        <div style={{ marginBottom: 20 }}>
                          <div
                            style={{
                              fontSize: 10,
                              color: "#484f58",
                              fontFamily: "Roboto Mono, monospace",
                              letterSpacing: "0.1em",
                              textTransform: "uppercase",
                              marginBottom: 8,
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                            }}
                          >
                            <span
                              style={{
                                width: 7,
                                height: 7,
                                borderRadius: "50%",
                                background: "#6affc9",
                                display: "inline-block",
                                animation: "pulse 1.4s infinite",
                              }}
                            />
                            {t("dashboard.nowTracking")}
                          </div>
                          <div
                            key={s.id}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
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
                              style={{
                                accentColor: "#58a6ff",
                                flexShrink: 0,
                                cursor: "pointer",
                              }}
                            />
                            <span
                              className="material-symbols-outlined"
                              style={{
                                fontSize: 16,
                                color: "#6affc9",
                                flexShrink: 0,
                              }}
                            >
                              {appIcon(s.app_name)}
                            </span>
                            <span
                              style={{
                                fontFamily: "Roboto Mono, monospace",
                                fontSize: 11,
                                color: "#6affc9",
                                flexShrink: 0,
                                minWidth: 50,
                              }}
                            >
                              {fmtTime(s.start_time)} →
                            </span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <span
                                style={{
                                  fontSize: 13,
                                  color: "#f6f6fc",
                                  fontWeight: 500,
                                  display: "block",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {s.app_name}
                              </span>
                            </div>
                            <span
                              style={{
                                fontFamily: "Roboto Mono, monospace",
                                fontSize: 12,
                                color: "#6affc9",
                                fontWeight: 700,
                                flexShrink: 0,
                              }}
                            >
                              {fmtDuration(liveSecs)}
                            </span>
                            <button
                              onClick={async () => {
                                await stopActiveSession().catch(console.error);
                                setIsTrackingPaused(false);
                                await load();
                              }}
                              title="Stop tracking"
                              style={{
                                background: "rgba(248,81,73,0.1)",
                                border: "1px solid rgba(248,81,73,0.3)",
                                borderRadius: 6,
                                padding: "4px 10px",
                                color: "#f85149",
                                cursor: "pointer",
                                fontSize: 11,
                                fontWeight: 700,
                                letterSpacing: "0.04em",
                                flexShrink: 0,
                                display: "flex",
                                alignItems: "center",
                                gap: 4,
                                transition: "background 0.12s",
                              }}
                              onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(248,81,73,0.2)")}
                              onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(248,81,73,0.1)")}
                            >
                              <span className="material-symbols-outlined" style={{ fontSize: 13 }}>stop_circle</span>
                              {t("dashboard.stop")}
                            </button>
                            {linkedWs && (
                              <span
                                style={{
                                  fontSize: 10,
                                  padding: "1px 7px",
                                  borderRadius: 10,
                                  background: `${linkedWs.color}22`,
                                  color: linkedWs.color,
                                  border: `1px solid ${linkedWs.color}44`,
                                  fontWeight: 600,
                                  whiteSpace: "nowrap",
                                  flexShrink: 0,
                                }}
                              >
                                {linkedWs.name}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })()}

                  {/* ── 2. UNLABELLED container — sessions not yet assigned to a Task ── */}
                  {unlabelledSessions.length > 0 && (
                    <div style={{ marginBottom: 20 }}>
                      <div
                        style={{
                          fontSize: 10,
                          color: "#484f58",
                          fontFamily: "Roboto Mono, monospace",
                          letterSpacing: "0.1em",
                          textTransform: "uppercase",
                          marginBottom: 8,
                        }}
                      >
                        <span className="material-symbols-outlined">
                          lightbulb_2
                        </span>{" "}
                        {t("dashboard.sessionsNeedingTask")}
                      </div>
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 6,
                        }}
                      >
                        {unlabelledSessions.map((s) => {
                          const isSelected = selected.has(s.id);
                          return (
                            <div
                              key={s.id}
                              style={{
                                display: "flex",
                                flexDirection: "column",
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 10,
                                  padding: "10px 14px",
                                  background: isSelected
                                    ? "rgba(88,166,255,0.07)"
                                    : "#161b22",
                                  borderRadius: 8,
                                  border: isSelected
                                    ? "1px solid rgba(88,166,255,0.28)"
                                    : "1px solid rgba(255,255,255,0.06)",
                                  transition:
                                    "background 0.12s, border-color 0.12s",
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => toggleSelect(s.id)}
                                  style={{
                                    width: 14,
                                    height: 14,
                                    cursor: "pointer",
                                    accentColor: "#58a6ff",
                                    flexShrink: 0,
                                  }}
                                />
                                <div
                                  style={{
                                    width: 30,
                                    height: 30,
                                    borderRadius: 7,
                                    background: `${appColor(s.app_name)}18`,
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    flexShrink: 0,
                                  }}
                                >
                                  <span
                                    className="material-symbols-outlined"
                                    style={{
                                      fontSize: 16,
                                      color: appColor(s.app_name),
                                    }}
                                  >
                                    {appIcon(s.app_name)}
                                  </span>
                                </div>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div
                                    style={{
                                      display: "flex",
                                      alignItems: "center",
                                      gap: 6,
                                    }}
                                  >
                                    <span
                                      style={{
                                        fontSize: 13,
                                        fontWeight: 600,
                                        color: "#e6edf3",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap",
                                      }}
                                    >
                                      {s.app_name}
                                    </span>
                                    {s.status === "confirmed" && (
                                      <span
                                        className="material-symbols-outlined"
                                        style={{
                                          fontSize: 13,
                                          color: "#3fb950",
                                          flexShrink: 0,
                                        }}
                                      >
                                        check_circle
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <div
                                  style={{ textAlign: "right", flexShrink: 0 }}
                                >
                                  <div
                                    style={{
                                      fontSize: 11,
                                      fontFamily: "Roboto Mono, monospace",
                                      color: "#8b949e",
                                      marginBottom: 2,
                                    }}
                                  >
                                    {fmtTime(s.start_time)}
                                    {s.end_time
                                      ? ` – ${fmtTime(s.end_time)}`
                                      : " →"}
                                  </div>
                                  <div
                                    style={{
                                      fontSize: 12,
                                      fontFamily: "Roboto Mono, monospace",
                                      color: "#58a6ff",
                                      fontWeight: 700,
                                    }}
                                  >
                                    {s.duration ? fmtDuration(s.duration) : "…"}
                                  </div>
                                </div>
                                <button
                                  onClick={() => setConfirmDeleteId(s.id)}
                                  title="Delete session"
                                  style={{
                                    background: "none",
                                    border: "none",
                                    color: "#484f58",
                                    cursor: "pointer",
                                    padding: 4,
                                    borderRadius: 4,
                                    display: "flex",
                                    alignItems: "center",
                                    flexShrink: 0,
                                    transition: "color 0.12s",
                                  }}
                                  onMouseEnter={(e) =>
                                    (e.currentTarget.style.color = "#f85149")
                                  }
                                  onMouseLeave={(e) =>
                                    (e.currentTarget.style.color = "#484f58")
                                  }
                                >
                                  <span
                                    className="material-symbols-outlined"
                                    style={{ fontSize: 15 }}
                                  >
                                    delete
                                  </span>
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

            {/* ── Tasks Panel ── */}
            {workSessions.length > 0 && (
              <section style={{ marginBottom: 80 }}>
                <span
                  style={{
                    ...sectionLabel,
                    display: "block",
                    marginBottom: 10,
                  }}
                >
                  {t("dashboard.tasks")}
                </span>
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 8 }}
                >
                  {workSessions.map((ws) => {
                    const isExpanded = collapsedWs.has(ws.id);
                    const expandedSessions =
                      wsExpandedSessions.get(ws.id) ?? [];
                    return (
                      <div
                        key={ws.id}
                        style={{
                          background: "#161b22",
                          borderRadius: 8,
                          border: `1px solid ${ws.color}2a`,
                          overflow: "hidden",
                        }}
                      >
                        {/* ── Header row ── */}
                        <div
                          style={{
                            padding: "12px 16px",
                            display: "flex",
                            alignItems:
                              editingWsId === ws.id ? "flex-start" : "center",
                            gap: 12,
                          }}
                        >
                          {/* Chevron toggle */}
                          <button
                            onClick={() => handleToggleWsCollapse(ws.id)}
                            title={isExpanded ? t("dashboard.collapse") : t("dashboard.expand")}
                            style={{
                              background: "none",
                              border: "none",
                              padding: 0,
                              cursor: "pointer",
                              color: "#484f58",
                              display: "flex",
                              alignItems: "center",
                              flexShrink: 0,
                              marginTop: editingWsId === ws.id ? 4 : 0,
                              transition: "color 0.12s",
                            }}
                            onMouseEnter={(e) =>
                              (e.currentTarget.style.color = "#8b949e")
                            }
                            onMouseLeave={(e) =>
                              (e.currentTarget.style.color = "#484f58")
                            }
                          >
                            <span
                              className="material-symbols-outlined"
                              style={{
                                fontSize: 18,
                                transform: isExpanded
                                  ? "rotate(90deg)"
                                  : "rotate(0deg)",
                                transition: "transform 0.15s",
                              }}
                            >
                              chevron_right
                            </span>
                          </button>

                          {/* Color dot */}
                          <div
                            style={{
                              width: 10,
                              height: 10,
                              borderRadius: "50%",
                              background: ws.color,
                              flexShrink: 0,
                              marginTop: editingWsId === ws.id ? 4 : 0,
                            }}
                          />

                          {editingWsId === ws.id ? (
                            /* ── Edit mode ── */
                            <div
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: 8,
                                flex: 1,
                              }}
                            >
                              <input
                                autoFocus
                                value={editWsName}
                                onChange={(e) => setEditWsName(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter")
                                    handleUpdateWorkSession(ws.id);
                                  if (e.key === "Escape") {
                                    setEditingWsId(null);
                                  }
                                }}
                                style={inlineInput}
                                placeholder={t("dashboard.taskNamePlaceholder")}
                              />
                              <div
                                style={{
                                  display: "flex",
                                  gap: 6,
                                  flexWrap: "wrap",
                                }}
                              >
                                <button
                                  onClick={() => setEditWsProjectId(null)}
                                  style={{
                                    padding: "2px 10px",
                                    borderRadius: 10,
                                    fontSize: 11,
                                    background:
                                      editWsProjectId === null
                                        ? "rgba(139,148,158,0.2)"
                                        : "transparent",
                                    border:
                                      editWsProjectId === null
                                        ? "1px solid #8b949e"
                                        : "1px solid rgba(255,255,255,0.1)",
                                    color:
                                      editWsProjectId === null
                                        ? "#e6edf3"
                                        : "#8b949e",
                                    cursor: "pointer",
                                  }}
                                >
                                  {t("dashboard.noProject")}
                                </button>
                                {projects.map((p) => (
                                  <button
                                    key={p.id}
                                    onClick={() => setEditWsProjectId(p.id)}
                                    style={{
                                      padding: "2px 10px",
                                      borderRadius: 10,
                                      fontSize: 11,
                                      background:
                                        editWsProjectId === p.id
                                          ? `${p.color}22`
                                          : "transparent",
                                      border:
                                        editWsProjectId === p.id
                                          ? `1px solid ${p.color}`
                                          : "1px solid rgba(255,255,255,0.1)",
                                      color:
                                        editWsProjectId === p.id
                                          ? p.color
                                          : "#8b949e",
                                      cursor: "pointer",
                                    }}
                                  >
                                    {p.name}
                                  </button>
                                ))}
                              </div>
                              <div style={{ display: "flex", gap: 6 }}>
                                <button
                                  onClick={() => handleUpdateWorkSession(ws.id)}
                                  style={pillBtn("#3fb950", "#0d1117")}
                                >
                                  {t("dashboard.save")}
                                </button>
                                <button
                                  onClick={() => handleSuggestWsName(ws)}
                                  disabled={suggestingWsId === ws.id}
                                  title="Suggest name with AI"
                                  style={{
                                    ...pillBtn("rgba(88,166,255,0.12)", "#58a6ff"),
                                    border: "1px solid rgba(88,166,255,0.3)",
                                    opacity: suggestingWsId === ws.id ? 0.6 : 1,
                                    cursor: suggestingWsId === ws.id ? "wait" : "pointer",
                                  }}
                                >
                                  {suggestingWsId === ws.id ? t("dashboard.suggesting") : t("dashboard.suggest")}
                                </button>
                                <button
                                  onClick={() => setEditingWsId(null)}
                                  style={pillBtn(
                                    "rgba(255,255,255,0.08)",
                                    "#8b949e",
                                  )}
                                >
                                  ✕
                                </button>
                              </div>
                            </div>
                          ) : (
                            /* ── Display mode ── */
                            <>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div
                                  style={{
                                    fontSize: 13,
                                    fontWeight: 600,
                                    color: "#e6edf3",
                                    marginBottom: 2,
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 8,
                                    flexWrap: "wrap",
                                  }}
                                >
                                  {ws.name}
                                  {ws.project_name && (
                                    <span
                                      style={{
                                        padding: "2px 8px",
                                        borderRadius: 4,
                                        fontSize: 11,
                                        fontWeight: 500,
                                        background: `${ws.project_color ?? "#6affc9"}22`,
                                        border: `1px solid ${ws.project_color ?? "#6affc9"}44`,
                                        color: ws.project_color ?? "#6affc9",
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 4,
                                      }}
                                    >
                                      <span
                                        style={{
                                          width: 6,
                                          height: 6,
                                          borderRadius: "50%",
                                          background:
                                            ws.project_color ?? "#6affc9",
                                          display: "inline-block",
                                        }}
                                      />
                                      {ws.project_name}
                                    </span>
                                  )}
                                </div>
                                <div style={{ fontSize: 11, color: "#8b949e" }}>
                                  {ws.app_names || "—"}
                                  {" · "}
                                  <span
                                    style={{
                                      fontFamily: "Roboto Mono, monospace",
                                      color: ws.color,
                                    }}
                                  >
                                    {fmtDuration(ws.total_secs)}
                                  </span>
                                {" · "}
                                  {t("dashboard.sessionCount", { count: ws.session_count })}
                                </div>
                              </div>

                              <button
                                onClick={() => {
                                  setEditingWsId(ws.id);
                                  setEditWsName(ws.name);
                                  setEditWsProjectId(ws.project_id ?? null);
                                }}
                                title="Edit task"
                                style={{
                                  background: "none",
                                  border: "none",
                                  color: "#484f58",
                                  cursor: "pointer",
                                  padding: 4,
                                  borderRadius: 4,
                                  display: "flex",
                                  alignItems: "center",
                                  transition: "color 0.12s",
                                }}
                                onMouseEnter={(e) =>
                                  (e.currentTarget.style.color = "#8b949e")
                                }
                                onMouseLeave={(e) =>
                                  (e.currentTarget.style.color = "#484f58")
                                }
                              >
                                <span
                                  className="material-symbols-outlined"
                                  style={{ fontSize: 16 }}
                                >
                                  edit
                                </span>
                              </button>

                              {/* AI: Invoice description */}
                              <button
                                onClick={() => {
                                  if (invoiceDescWsId === ws.id) {
                                    setInvoiceDescWsId(null);
                                    setInvoiceDescText("");
                                  } else {
                                    handleGenerateInvoiceDesc(ws);
                                  }
                                }}
                                disabled={generatingInvoiceWsId === ws.id}
                                title="Generate invoice description with AI"
                                style={{
                                  background: invoiceDescWsId === ws.id ? "rgba(88,166,255,0.1)" : "none",
                                  border: "none",
                                  color: invoiceDescWsId === ws.id ? "#58a6ff" : "#484f58",
                                  cursor: generatingInvoiceWsId === ws.id ? "wait" : "pointer",
                                  padding: 4,
                                  borderRadius: 4,
                                  display: "flex",
                                  alignItems: "center",
                                  fontSize: 14,
                                  transition: "color 0.12s",
                                }}
                                onMouseEnter={(e) => { if (invoiceDescWsId !== ws.id) e.currentTarget.style.color = "#8b949e"; }}
                                onMouseLeave={(e) => { if (invoiceDescWsId !== ws.id) e.currentTarget.style.color = "#484f58"; }}
                              >
                                {generatingInvoiceWsId === ws.id ? "…" : "✨"}
                              </button>

                              <button
                                onClick={() => handleDeleteWorkSession(ws.id)}
                                title="Delete task"
                                style={{
                                  background: "none",
                                  border: "none",
                                  color: "#484f58",
                                  cursor: "pointer",
                                  padding: 4,
                                  borderRadius: 4,
                                  display: "flex",
                                  alignItems: "center",
                                  transition: "color 0.12s",
                                }}
                                onMouseEnter={(e) =>
                                  (e.currentTarget.style.color = "#f85149")
                                }
                                onMouseLeave={(e) =>
                                  (e.currentTarget.style.color = "#484f58")
                                }
                              >
                                <span
                                  className="material-symbols-outlined"
                                  style={{ fontSize: 16 }}
                                >
                                  delete
                                </span>
                              </button>
                            </>
                          )}
                        </div>

                        {/* ── AI Invoice Description panel ── */}
                        {invoiceDescWsId === ws.id && (
                          <div style={{
                            margin: "0 0 2px",
                            padding: "12px 16px",
                            background: "rgba(88,166,255,0.06)",
                            borderTop: "1px solid rgba(88,166,255,0.15)",
                            borderBottom: "1px solid rgba(88,166,255,0.1)",
                          }}>
                            <div style={{ fontSize: 11, color: "#58a6ff", fontWeight: 600, marginBottom: 6, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                              {t("dashboard.invoiceDesc")}
                            </div>
                            {generatingInvoiceWsId === ws.id ? (
                              <div style={{ fontSize: 13, color: "#8b949e", fontStyle: "italic" }}>{t("dashboard.generating")}</div>
                            ) : (
                              <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                                <p style={{ flex: 1, margin: 0, fontSize: 13, color: "#c9d1d9", lineHeight: 1.6 }}>
                                  {invoiceDescText}
                                </p>
                                <button
                                  onClick={() => navigator.clipboard.writeText(invoiceDescText)}
                                  title="Copy to clipboard"
                                  style={{ background: "none", border: "1px solid #414752", borderRadius: 4, padding: "4px 8px", color: "#8b949e", cursor: "pointer", fontSize: 11, whiteSpace: "nowrap", flexShrink: 0 }}
                                >
                                  {t("dashboard.copy")}
                                </button>
                              </div>
                            )}
                          </div>
                        )}

                        {/* ── Expanded sessions list ── */}
                        {isExpanded && (
                          <div style={{ borderTop: `1px solid ${ws.color}18` }}>
                            {expandedSessions.length === 0 ? (
                              <div
                                style={{
                                  padding: "10px 48px",
                                  fontSize: 12,
                                  color: "#484f58",
                                }}
                              >
                                {t("dashboard.loading")}
                              </div>
                            ) : (
                              expandedSessions.map((s) => (
                                <div
                                  key={s.id}
                                  style={{
                                    padding: "8px 48px",
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 12,
                                    borderBottom:
                                      "1px solid rgba(255,255,255,0.04)",
                                  }}
                                >
                                  <span
                                    style={{
                                      fontSize: 12,
                                      color: "#8b949e",
                                      flex: 1,
                                      minWidth: 0,
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    {s.app_name}
                                    {s.task_name ? (
                                      <span
                                        style={{
                                          marginLeft: 6,
                                          color: "#484f58",
                                        }}
                                      >
                                        · {s.task_name}
                                      </span>
                                    ) : null}
                                  </span>
                                  <span
                                    style={{
                                      fontSize: 11,
                                      fontFamily: "Roboto Mono, monospace",
                                      color: ws.color,
                                      flexShrink: 0,
                                    }}
                                  >
                                    {fmtDuration(s.duration ?? 0)}
                                  </span>
                                  <button
                                    onClick={() =>
                                      handleRemoveSessionFromWs(s.id, ws.id)
                                    }
                                    title="Remove from task"
                                    style={{
                                      background: "none",
                                      border: "none",
                                      color: "#484f58",
                                      cursor: "pointer",
                                      padding: 2,
                                      borderRadius: 4,
                                      display: "flex",
                                      alignItems: "center",
                                      transition: "color 0.12s",
                                      flexShrink: 0,
                                    }}
                                    onMouseEnter={(e) =>
                                      (e.currentTarget.style.color = "#f85149")
                                    }
                                    onMouseLeave={(e) =>
                                      (e.currentTarget.style.color = "#484f58")
                                    }
                                  >
                                    <span
                                      className="material-symbols-outlined"
                                      style={{ fontSize: 14 }}
                                    >
                                      remove_circle_outline
                                    </span>
                                  </button>
                                </div>
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* ── Empty state ── */}
            {sessions.length === 0 && summary.length === 0 && (
              <div
                style={{
                  textAlign: "center",
                  paddingTop: 64,
                  color: "#484f58",
                }}
              >
                <div style={{ fontSize: 12 }}>
                  {isToday
                    ? t("dashboard.enableAppsHintToday")
                    : t("dashboard.enableAppsHint", { date })}
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
            display: "flex",
            gap: 10,
          }}
        >
          <button
            onClick={() => { setGroupMode("new"); setGroupExistingWsId(null); setShowGroupDialog(true); }}
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
            <span
              className="material-symbols-outlined"
              style={{ fontSize: 18 }}
            >
              folder_special
            </span>
            {t("dashboard.addToTask", { count: selected.size })}
          </button>
          <button
            onClick={() => setConfirmDeleteSelected(true)}
            style={{
              background: "#f85149",
              color: "#fff",
              border: "none",
              borderRadius: 22,
              padding: "11px 22px",
              fontWeight: 700,
              fontSize: 13,
              cursor: "pointer",
              boxShadow: "0 4px 24px rgba(248,81,73,0.45)",
              display: "flex",
              alignItems: "center",
              gap: 8,
              letterSpacing: "0.01em",
            }}
          >
            <span
              className="material-symbols-outlined"
              style={{ fontSize: 18 }}
            >
              delete
            </span>
            {t("dashboard.deleteTask", { count: selected.size })}
          </button>
        </div>
      )}

      {/* ── Delete Confirm Dialog ── */}
      {confirmDeleteId !== null && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.72)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 300,
          }}
          onClick={() => setConfirmDeleteId(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#161b22",
              borderRadius: 10,
              padding: "28px 32px",
              border: "1px solid rgba(248,81,73,0.3)",
              maxWidth: 340,
              width: "100%",
              display: "flex",
              flexDirection: "column",
              gap: 20,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span
                className="material-symbols-outlined"
                style={{ color: "#f85149", fontSize: 22 }}
              >
                delete
              </span>
              <span style={{ fontSize: 15, fontWeight: 600, color: "#f6f6fc" }}>
                {t("dashboard.deleteSession")}
              </span>
            </div>
            <p
              style={{
                fontSize: 13,
                color: "#8b949e",
                margin: 0,
                lineHeight: 1.5,
              }}
            >
              {t("dashboard.deleteConfirm")}
            </p>
            <div
              style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}
            >
              <button
                onClick={() => setConfirmDeleteId(null)}
                style={{
                  padding: "8px 18px",
                  borderRadius: 6,
                  border: "1px solid rgba(255,255,255,0.1)",
                  background: "transparent",
                  color: "#8b949e",
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                {t("dashboard.cancel")}
              </button>
              <button
                onClick={async () => {
                  await handleDeleteSession(confirmDeleteId);
                  setConfirmDeleteId(null);
                }}
                style={{
                  padding: "8px 18px",
                  borderRadius: 6,
                  border: "none",
                  background: "#f85149",
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {t("dashboard.delete")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Bulk Delete Confirm Dialog ── */}
      {confirmDeleteSelected && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.72)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 300,
          }}
          onClick={() => setConfirmDeleteSelected(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#161b22",
              borderRadius: 10,
              padding: "28px 32px",
              border: "1px solid rgba(248,81,73,0.3)",
              maxWidth: 340,
              width: "100%",
              display: "flex",
              flexDirection: "column",
              gap: 20,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span
                className="material-symbols-outlined"
                style={{ color: "#f85149", fontSize: 22 }}
              >
                delete
              </span>
              <span style={{ fontSize: 15, fontWeight: 600, color: "#f6f6fc" }}>
                {t("dashboard.deleteTask", { count: selected.size })}
              </span>
            </div>
            <p
              style={{
                fontSize: 13,
                color: "#8b949e",
                margin: 0,
                lineHeight: 1.5,
              }}
            >
              {t("dashboard.deleteConfirm")}
            </p>
            <div
              style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}
            >
              <button
                onClick={() => setConfirmDeleteSelected(false)}
                style={{
                  padding: "8px 18px",
                  borderRadius: 6,
                  border: "1px solid rgba(255,255,255,0.1)",
                  background: "transparent",
                  color: "#8b949e",
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                {t("dashboard.cancel")}
              </button>
              <button
                onClick={handleDeleteSelected}
                style={{
                  padding: "8px 18px",
                  borderRadius: 6,
                  border: "none",
                  background: "#f85149",
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {t("dashboard.delete")}
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
          onClick={(e) => {
            if (e.target === e.currentTarget) resetGroupDialog();
          }}
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
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 6,
              }}
            >
              <span
                className="material-symbols-outlined"
                style={{ fontSize: 22, color: "#58a6ff" }}
              >
                folder_special
              </span>
              <h3
                style={{
                  margin: 0,
                  fontSize: 16,
                  fontWeight: 700,
                  color: "#e6edf3",
                }}
              >
                {groupMode === "new" ? t("dashboard.newTask") : "Add to Task"}
              </h3>
            </div>
            <p
              style={{
                margin: "0 0 16px",
                fontSize: 12,
                color: "#8b949e",
                lineHeight: 1.5,
              }}
            >
              {t("dashboard.groupSessions", { count: selected.size })}
            </p>

            {/* Mode toggle — only if work sessions exist */}
            {workSessions.length > 0 && (
              <div style={{ display: "flex", gap: 0, marginBottom: 20, borderRadius: 6, overflow: "hidden", border: "1px solid rgba(255,255,255,0.1)" }}>
                {(["new", "existing"] as const).map(mode => (
                  <button
                    key={mode}
                    onClick={() => { setGroupMode(mode); setGroupExistingWsId(null); }}
                    style={{
                      flex: 1, background: groupMode === mode ? "rgba(88,166,255,0.12)" : "transparent",
                      border: "none", cursor: "pointer",
                      color: groupMode === mode ? "#58a6ff" : "#8b949e",
                      fontSize: 12, fontWeight: groupMode === mode ? 700 : 400,
                      padding: "7px 0", letterSpacing: "0.04em",
                      borderBottom: groupMode === mode ? "2px solid #58a6ff" : "2px solid transparent",
                      transition: "all 0.15s",
                    }}
                  >
                    {mode === "new" ? "＋ New task" : "→ Existing task"}
                  </button>
                ))}
              </div>
            )}

            {groupMode === "existing" ? (
              /* ── Existing task picker ── */
              <>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto", marginBottom: 16 }}>
                  {workSessions.slice().reverse().map(ws => (
                    <button
                      key={ws.id}
                      onClick={() => setGroupExistingWsId(ws.id)}
                      style={{
                        background: groupExistingWsId === ws.id ? "rgba(88,166,255,0.1)" : "#0d1117",
                        border: `1px solid ${groupExistingWsId === ws.id ? "#58a6ff" : "rgba(255,255,255,0.08)"}`,
                        borderRadius: 6, padding: "9px 12px", cursor: "pointer",
                        display: "flex", alignItems: "center", gap: 10, textAlign: "left",
                        transition: "all 0.12s",
                      }}
                    >
                      <span style={{ width: 10, height: 10, borderRadius: "50%", background: ws.color, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: groupExistingWsId === ws.id ? "#a2c9ff" : "#e6edf3", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {ws.name}
                        </div>
                        {ws.project_name && (
                          <div style={{ fontSize: 10, color: "#8b949e", fontFamily: "Roboto Mono, monospace", marginTop: 1 }}>{ws.project_name}</div>
                        )}
                      </div>
                      {groupExistingWsId === ws.id && (
                        <span className="material-symbols-outlined" style={{ fontSize: 16, color: "#58a6ff", flexShrink: 0 }}>check_circle</span>
                      )}
                    </button>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                  <button
                    onClick={resetGroupDialog}
                    style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: "8px 18px", color: "#8b949e", fontSize: 13, cursor: "pointer" }}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    onClick={handleAddToExistingWorkSession}
                    disabled={!groupExistingWsId}
                    style={{
                      background: groupExistingWsId ? "#58a6ff" : "#2d333b",
                      border: "none", borderRadius: 6, padding: "8px 20px",
                      color: groupExistingWsId ? "#0d1117" : "#484f58",
                      fontWeight: 700, fontSize: 13, cursor: groupExistingWsId ? "pointer" : "default",
                    }}
                  >
                    Add {selected.size} session{selected.size > 1 ? "s" : ""}
                  </button>
                </div>
              </>
            ) : (
              /* ── New task form ── */
              <>
            <input
              autoFocus
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateWorkSession();
                if (e.key === "Escape") resetGroupDialog();
              }}
              placeholder={t("dashboard.taskNamePlaceholder")}
              style={{ ...inlineInput, width: "100%", boxSizing: "border-box" }}
            />

            {/* ── Project selector ── */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                marginTop: 16,
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  color: "#74757a",
                  fontWeight: 500,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                }}
              >
                {t("dashboard.projectOptional")}
              </span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {/* "None" chip */}
                <button
                  onClick={() => setSelectedProject(null)}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 4,
                    border: `1px solid ${selectedProject === null ? "#6affc9" : "rgba(255,255,255,0.1)"}`,
                    background:
                      selectedProject === null
                        ? "rgba(106,255,201,0.1)"
                        : "transparent",
                    color: selectedProject === null ? "#6affc9" : "#74757a",
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  {t("dashboard.none")}
                </button>

                {/* Existing project chips */}
                {projects.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setSelectedProject(p.id)}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 4,
                      border: `1px solid ${selectedProject === p.id ? p.color : "rgba(255,255,255,0.1)"}`,
                      background:
                        selectedProject === p.id
                          ? `${p.color}22`
                          : "transparent",
                      color: selectedProject === p.id ? p.color : "#aaabb0",
                      fontSize: 12,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: p.color,
                        display: "inline-block",
                      }}
                    />
                    {p.name}
                  </button>
                ))}

                {/* New project inline */}
                {!showNewProject ? (
                  <button
                    onClick={() => setShowNewProject(true)}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 4,
                      border: "1px dashed rgba(255,255,255,0.2)",
                      background: "transparent",
                      color: "#74757a",
                      fontSize: 12,
                      cursor: "pointer",
                    }}
                  >
                    {t("dashboard.newProject")}
                  </button>
                ) : (
                  <div
                    style={{ display: "flex", gap: 6, alignItems: "center" }}
                  >
                    <input
                      autoFocus
                      value={newProjectName}
                      onChange={(e) => setNewProjectName(e.target.value)}
                      onKeyDown={async (e) => {
                        if (e.key === "Enter" && newProjectName.trim()) {
                          const p = await createProject(
                            newProjectName.trim(),
                            null,
                            null,
                          );
                          setProjects((prev) => [
                            ...prev,
                            { id: p.id, name: p.name, color: p.color },
                          ]);
                          setSelectedProject(p.id);
                          setNewProjectName("");
                          setShowNewProject(false);
                        }
                        if (e.key === "Escape") {
                          setShowNewProject(false);
                          setNewProjectName("");
                        }
                      }}
                      placeholder={t("dashboard.projectNamePlaceholder")}
                      style={{
                        background: "#23262c",
                        border: "1px solid rgba(106,255,201,0.3)",
                        borderRadius: 4,
                        color: "#f6f6fc",
                        fontSize: 12,
                        padding: "4px 8px",
                        outline: "none",
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
                onClick={resetGroupDialog}
                style={pillBtn("rgba(255,255,255,0.07)", "#8b949e")}
              >
                {t("dashboard.cancel")}
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
                {t("dashboard.create")}
              </button>
            </div>
            </>
            )}
          </div>
        </div>
      )}

      {/* Export Modal */}
      {showExport && <ExportModal onClose={() => setShowExport(false)} />}

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
