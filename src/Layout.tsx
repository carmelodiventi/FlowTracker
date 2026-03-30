import { NavLink, Outlet } from "react-router-dom";
import { useEffect, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { nameSession, listProjects, createWorkSession, assignWorkSessionProject, Project } from "./api";

interface SessionClosedPayload {
  session_id: string;
  app_name: string;
  duration_secs: number;
}

interface NamingToast {
  session_id: string;
  app_name: string;
  duration_secs: number;
  input: string;
  project_id: string | null;
  showProjects: boolean;
}

const NAV = [
  { to: "/", icon: "timeline", labelKey: "nav.dashboard" },
  { to: "/projects", icon: "folder_open", labelKey: "nav.projects" },
  { to: "/whitelist", icon: "verified_user", labelKey: "nav.whitelist" },
  { to: "/settings", icon: "settings", labelKey: "nav.settings" },
];

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function Layout() {
  const { t } = useTranslation();
  const [toasts,   setToasts]   = useState<NamingToast[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    listProjects().then(setProjects).catch(console.error);
  }, []);

  useEffect(() => {
    const unlisten = listen<SessionClosedPayload>("flow:session-closed", ({ payload }) => {
      if (payload.duration_secs < 60) return;
      setToasts((prev) => [...prev.slice(-4), { ...payload, input: "", project_id: null, showProjects: false }]);
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  const confirmName = useCallback(async (toast: NamingToast) => {
    const name = toast.input.trim();
    try {
      if (name) {
        // Create a work session and optionally assign a project
        const ws = await createWorkSession(name, [toast.session_id]);
        if (toast.project_id) {
          await assignWorkSessionProject(ws.id, toast.project_id);
        }
      } else {
        // Just tag the session with a task name if no work session
        await nameSession(toast.session_id, name).catch(() => {});
      }
    } catch (e) {
      console.error("[toast] confirm error:", e);
    }
    setToasts((prev) => prev.filter((t) => t.session_id !== toast.session_id));
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.session_id !== id));
  }, []);

  const updateToast = useCallback((session_id: string, patch: Partial<NamingToast>) => {
    setToasts((prev) => prev.map((t) => t.session_id === session_id ? { ...t, ...patch } : t));
  }, []);

  return (
    <>
      {/* Fixed sidebar — exactly as Stitch designed */}
      <aside
        style={{
          position: "fixed",
          left: 0, top: 0,
          width: 256,
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          paddingTop: 24,
          paddingBottom: 24,
          background: "#10141a",
          borderRight: "1px solid rgba(65,71,82,0.2)",
          zIndex: 50,
          fontFamily: "Inter, sans-serif",
        }}
      >
        {/* Logo */}
        <div style={{ padding: "0 24px", marginBottom: 40, display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: "#000", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <img src="/img/logo.svg" width={32} alt="logo"/>
          </div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: "#f0f6fc", letterSpacing: "-0.05em", lineHeight: 1 }}>Flow</div>
            <div style={{ fontFamily: "Roboto Mono, monospace", fontSize: 10, color: "#67df70", letterSpacing: "0.15em", textTransform: "uppercase" }}>
              {t("layout.trackingActive")}
            </div>
          </div>
        </div>

        {/* Nav links */}
        <nav style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
          {NAV.map(({ to, icon, labelKey }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              style={({ isActive }) => ({
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "12px 24px",
                color: isActive ? "#f0f6fc" : "#c0c7d4",
                borderLeft: `4px solid ${isActive ? "#58a6ff" : "transparent"}`,
                background: isActive ? "#1c2026" : "transparent",
                textDecoration: "none",
                fontSize: 14,
                fontWeight: 500,
                transition: "all 0.15s",
              })}
            >
              <span
                className="material-symbols-outlined"
                style={{ fontSize: 20, fontVariationSettings: "'FILL' 1" }}
              >
                {icon}
              </span>
              {t(labelKey)}
            </NavLink>
          ))}
        </nav>

        {/* System Tray status */}
        <div style={{ padding: "0 20px", marginTop: "auto" }}>
          <div style={{ padding: 16, borderRadius: 12, background: "#181c22", border: "1px solid rgba(65,71,82,0.3)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <span style={{ position: "relative", display: "inline-flex" }}>
                <span style={{ position: "absolute", width: 8, height: 8, borderRadius: "50%", background: "#67df70", opacity: 0.75, animation: "ping 2s cubic-bezier(0,0,0.2,1) infinite" }} />
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#67df70", display: "inline-block" }} />
              </span>
              <span style={{ fontFamily: "Roboto Mono, monospace", fontSize: 10, color: "#c0c7d4", letterSpacing: "0.15em", textTransform: "uppercase" }}>
                {t("layout.systemTray")}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#c0c7d4" }}>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>desktop_windows</span>
              <span style={{ fontSize: 12 }}>{t("layout.helperApp")}</span>
            </div>
          </div>
        </div>
      </aside>

      {/* Main content — offset by sidebar width, exactly as Stitch */}
      <main
        style={{
          marginLeft: 256,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          background: "#10141a",
        }}
      >
        <Outlet />
      </main>

      {/* Session naming toasts */}
      {toasts.length > 0 && (
        <div style={{ position: "fixed", bottom: 24, right: 24, display: "flex", flexDirection: "column", gap: 10, zIndex: 100, width: 360 }}>
          {toasts.map((toast) => (
            <div
              key={toast.session_id}
              style={{ background: "#1c2026", border: "1px solid rgba(65,71,82,0.5)", borderLeft: "3px solid #58a6ff", borderRadius: 6, padding: "14px 16px" }}
            >
              {/* Title row */}
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
                <div>
                  <div style={{ fontWeight: 600, color: "#f0f6fc", fontSize: 13 }}>{toast.app_name}</div>
                  <div style={{ fontSize: 11, color: "#8b919d", fontFamily: "Roboto Mono, monospace" }}>
                    {formatDuration(toast.duration_secs)} — {t("toast.whatTask")}
                  </div>
                </div>
                <button onClick={() => dismissToast(toast.session_id)} style={{ color: "#8b919d", background: "none", border: "none", cursor: "pointer", fontSize: 20, lineHeight: 1, padding: 0 }}>×</button>
              </div>

              {/* Task name input + OK */}
              <div style={{ display: "flex", gap: 8, marginBottom: projects.length > 0 ? 8 : 0 }}>
                <input
                  type="text"
                  placeholder={t("toast.placeholder")}
                  value={toast.input}
                  onChange={(e) => updateToast(toast.session_id, { input: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && confirmName(toast)}
                  style={{ flex: 1, background: "#10141a", border: "1px solid #414752", borderRadius: 4, padding: "6px 10px", color: "#dfe2eb", fontSize: 12, outline: "none" }}
                />
                <button
                  onClick={() => confirmName(toast)}
                  style={{ background: "#58a6ff", color: "#001c38", border: "none", borderRadius: 4, padding: "6px 12px", fontWeight: 700, fontSize: 11, cursor: "pointer", letterSpacing: "0.05em", textTransform: "uppercase" }}
                >
                  {t("toast.ok")}
                </button>
              </div>

              {/* Project picker toggle */}
              {projects.length > 0 && (
                <>
                  <button
                    onClick={() => updateToast(toast.session_id, { showProjects: !toast.showProjects })}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "#8b919d", fontSize: 11, padding: 0, display: "flex", alignItems: "center", gap: 4 }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                      {toast.showProjects ? "expand_less" : "expand_more"}
                    </span>
                    {toast.project_id
                      ? t("toast.project", { name: projects.find(p => p.id === toast.project_id)?.name ?? "?" })
                      : t("toast.assignProject")}
                  </button>
                  {toast.showProjects && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                      {/* Clear option */}
                      <button
                        onClick={() => updateToast(toast.session_id, { project_id: null })}
                        style={{
                          background: toast.project_id === null ? "#262a31" : "transparent",
                          border: `1px solid ${toast.project_id === null ? "#58a6ff" : "#414752"}`,
                          borderRadius: 12, padding: "3px 10px", cursor: "pointer",
                          color: toast.project_id === null ? "#a2c9ff" : "#8b919d", fontSize: 11,
                        }}
                      >
                        {t("toast.none")}
                      </button>
                      {projects.map(p => (
                        <button
                          key={p.id}
                          onClick={() => updateToast(toast.session_id, { project_id: p.id })}
                          style={{
                            background: toast.project_id === p.id ? p.color + "33" : "transparent",
                            border: `1px solid ${toast.project_id === p.id ? p.color : "#414752"}`,
                            borderRadius: 12, padding: "3px 10px", cursor: "pointer",
                            color: toast.project_id === p.id ? p.color : "#c0c7d4", fontSize: 11,
                            display: "flex", alignItems: "center", gap: 4,
                          }}
                        >
                          <span style={{ width: 6, height: 6, borderRadius: "50%", background: p.color, display: "inline-block" }} />
                          {p.name}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <style>{`
        @keyframes ping {
          75%, 100% { transform: scale(2); opacity: 0; }
        }
      `}</style>
    </>
  );
}

