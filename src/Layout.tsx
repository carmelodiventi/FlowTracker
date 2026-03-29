import { NavLink, Outlet } from "react-router-dom";
import { useEffect, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { nameSession } from "./api";

interface SessionClosedPayload {
  session_id: number;
  app_name: string;
  duration_secs: number;
}

interface NamingToast {
  session_id: number;
  app_name: string;
  duration_secs: number;
  input: string;
}

const NAV = [
  { to: "/", icon: "timeline", label: "Dashboard/Timeline" },
  { to: "/projects", icon: "folder_open", label: "Projects" },
  { to: "/whitelist", icon: "verified_user", label: "Whitelist" },
  { to: "/settings", icon: "settings", label: "Settings" },
];

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function Layout() {
  const [toasts, setToasts] = useState<NamingToast[]>([]);

  useEffect(() => {
    const unlisten = listen<SessionClosedPayload>("flow:session-closed", ({ payload }) => {
      if (payload.duration_secs < 60) return;
      setToasts((prev) => [...prev.slice(-4), { ...payload, input: "" }]);
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  const confirmName = useCallback(async (toast: NamingToast) => {
    if (toast.input.trim()) {
      await nameSession(toast.session_id, toast.input.trim()).catch(console.error);
    }
    setToasts((prev) => prev.filter((t) => t.session_id !== toast.session_id));
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.session_id !== id));
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
              Tracking: ATTIVO
            </div>
          </div>
        </div>

        {/* Nav links */}
        <nav style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
          {NAV.map(({ to, icon, label }) => (
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
              {label}
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
                System Tray
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#c0c7d4" }}>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>desktop_windows</span>
              <span style={{ fontSize: 12 }}>Flow Tracker Helper</span>
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
        <div style={{ position: "fixed", bottom: 24, right: 24, display: "flex", flexDirection: "column", gap: 10, zIndex: 100, width: 340 }}>
          {toasts.map((toast) => (
            <div
              key={toast.session_id}
              style={{ background: "#1c2026", border: "1px solid rgba(65,71,82,0.5)", borderLeft: "3px solid #58a6ff", borderRadius: 6, padding: "14px 16px" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <div>
                  <div style={{ fontWeight: 600, color: "#f0f6fc", fontSize: 13 }}>{toast.app_name}</div>
                  <div style={{ fontSize: 11, color: "#8b919d", fontFamily: "Roboto Mono, monospace" }}>
                    {formatDuration(toast.duration_secs)} — What task was this?
                  </div>
                </div>
                <button onClick={() => dismissToast(toast.session_id)} style={{ color: "#8b919d", background: "none", border: "none", cursor: "pointer", fontSize: 20, lineHeight: 1, padding: 0 }}>×</button>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type="text"
                  placeholder="e.g. Fix auth bug…"
                  value={toast.input}
                  onChange={(e) => setToasts((prev) => prev.map((t) => t.session_id === toast.session_id ? { ...t, input: e.target.value } : t))}
                  onKeyDown={(e) => e.key === "Enter" && confirmName(toast)}
                  style={{ flex: 1, background: "#10141a", border: "1px solid #414752", borderRadius: 4, padding: "6px 10px", color: "#dfe2eb", fontSize: 12, outline: "none" }}
                />
                <button
                  onClick={() => confirmName(toast)}
                  style={{ background: "#58a6ff", color: "#001c38", border: "none", borderRadius: 4, padding: "6px 12px", fontWeight: 700, fontSize: 11, cursor: "pointer", letterSpacing: "0.05em", textTransform: "uppercase" }}
                >
                  OK
                </button>
              </div>
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

