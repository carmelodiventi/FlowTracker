import { useEffect, useState, useMemo } from "react";
import { listApplications, toggleApplication, scanRunningApps } from "../api";
import type { Application } from "../api";

export default function Whitelist() {
  const [apps, setApps] = useState<Application[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);

  const load = async () => {
    setLoading(true);
    const list = await listApplications().catch(() => [] as Application[]);
    setApps(list);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(
    () =>
      apps.filter(
        (a) =>
          a.name.toLowerCase().includes(search.toLowerCase()) ||
          a.process_name.toLowerCase().includes(search.toLowerCase()),
      ),
    [apps, search],
  );

  const handleToggle = async (app: Application) => {
    // Optimistic update
    setApps((prev) =>
      prev.map((a) =>
        a.id === app.id ? { ...a, is_enabled: !a.is_enabled } : a,
      ),
    );
    await toggleApplication(app.id, !app.is_enabled).catch(() => load());
  };

  // Scan running apps via Tauri command (direct Rust ps call, no shell plugin needed).
  const handleScan = async () => {
    setScanning(true);
    try {
      const updated = await scanRunningApps();
      setApps(updated);
    } catch (e) {
      console.warn("Scan failed:", e);
    } finally {
      setScanning(false);
    }
  };

  const enabledCount = apps.filter((a) => a.is_enabled).length;

  return (
    <div
      style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}
    >
      {/* Top bar */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 32px",
          height: 56,
          flexShrink: 0,
          borderBottom: "1px solid rgba(65,71,82,0.2)",
          background: "#10141a",
        }}
      >
        <span
          style={{
            fontFamily: "Roboto Mono, monospace",
            fontSize: 13,
            color: "#a2c9ff",
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          Whitelist
        </span>
        <span
          style={{
            fontFamily: "Roboto Mono, monospace",
            fontSize: 12,
            color: "#67df70",
          }}
        >
          {enabledCount} app attive
        </span>
      </header>

      <div className="flex-1 overflow-y-auto" style={{ padding: "24px 32px" }}>
        {/* Title */}
        <div style={{ marginBottom: 24 }}>
          <h1
            style={{
              fontSize: 28,
              fontWeight: 800,
              color: "#f0f6fc",
              letterSpacing: "-0.04em",
              margin: "0 0 6px",
            }}
          >
            Gestione Whitelist
          </h1>
          <p
            style={{
              fontSize: 14,
              color: "#8b919d",
              margin: 0,
              maxWidth: "60%",
            }}
          >
            Scegli quali applicazioni devono essere tracciate automaticamente
            dal sistema FlowTracker per migliorare l'accuratezza del tuo
            workflow.
          </p>
        </div>

        {/* Action bar */}
        <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
          <div style={{ flex: 1, position: "relative" }}>
            <span
              className="material-symbols-outlined"
              style={{
                position: "absolute",
                left: 10,
                top: "50%",
                transform: "translateY(-50%)",
                fontSize: 18,
                color: "#8b919d",
              }}
            >
              search
            </span>
            <input
              type="text"
              placeholder="Cerca applicazione…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                width: "100%",
                background: "#181c22",
                border: "1px solid #414752",
                borderRadius: 4,
                padding: "8px 12px 8px 36px",
                color: "#dfe2eb",
                fontSize: 13,
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>
          <button
            onClick={handleScan}
            disabled={scanning}
            style={{
              background: "#1c2026",
              border: "1px solid #414752",
              color: "#a2c9ff",
              borderRadius: 4,
              padding: "8px 16px",
              fontWeight: 600,
              fontSize: 12,
              cursor: scanning ? "default" : "pointer",
              opacity: scanning ? 0.6 : 1,
              display: "flex",
              alignItems: "center",
              gap: 6,
              whiteSpace: "nowrap",
            }}
          >
            <span
              className="material-symbols-outlined"
              style={{ fontSize: 16 }}
            >
              radar
            </span>
            {scanning ? "Scansione…" : "Scansiona App"}
          </button>
        </div>

        {/* App list */}
        {loading ? (
          <div
            style={{ color: "#8b919d", textAlign: "center", paddingTop: 60 }}
          >
            Caricamento…
          </div>
        ) : filtered.length === 0 ? (
          <div
            style={{ textAlign: "center", paddingTop: 60, color: "#414752" }}
          >
            <span
              className="material-symbols-outlined"
              style={{ fontSize: 48, display: "block", marginBottom: 12 }}
            >
              verified_user
            </span>
            {search
              ? "Nessuna app trovata."
              : 'Nessuna app scoperta — clicca "Scansiona App".'}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {filtered.map((app) => (
              <div
                key={app.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  padding: "12px 16px",
                  borderRadius: 4,
                  background: app.is_enabled
                    ? "rgba(88,166,255,0.05)"
                    : "#181c22",
                  border: `1px solid ${app.is_enabled ? "rgba(88,166,255,0.2)" : "rgba(65,71,82,0.2)"}`,
                  transition: "all 0.15s",
                }}
              >
                {/* App icon placeholder */}
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 8,
                    background: app.is_enabled
                      ? "rgba(88,166,255,0.15)"
                      : "#262a31",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <span
                    className="material-symbols-outlined"
                    style={{
                      fontSize: 20,
                      color: app.is_enabled ? "#58a6ff" : "#8b919d",
                    }}
                  >
                    laptop_mac
                  </span>
                </div>

                {/* Name + process */}
                <div style={{ flex: 1, overflow: "hidden" }}>
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: "#f0f6fc",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {app.name}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "#8b919d",
                      fontFamily: "Roboto Mono, monospace",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {app.process_name}
                  </div>
                </div>

                {/* Toggle */}
                <button
                  onClick={() => handleToggle(app)}
                  aria-label={
                    app.is_enabled ? "Disabilita tracking" : "Abilita tracking"
                  }
                  style={{
                    width: 44,
                    height: 24,
                    borderRadius: 12,
                    border: "none",
                    background: app.is_enabled ? "#58a6ff" : "#31353c",
                    cursor: "pointer",
                    position: "relative",
                    flexShrink: 0,
                    transition: "background 0.2s",
                  }}
                >
                  <span
                    style={{
                      position: "absolute",
                      top: 3,
                      left: app.is_enabled ? 22 : 3,
                      width: 18,
                      height: 18,
                      borderRadius: "50%",
                      background: app.is_enabled ? "#001c38" : "#8b919d",
                      transition: "left 0.2s, background 0.2s",
                    }}
                  />
                </button>
              </div>
            ))}
          </div>
        )}

        <hr style={{
          height: 0,
          padding: 0,
          display: "block",
          border: 0,
          borderTop: "1px solid rgba(65,71,82,0.3)",
          marginTop: 24,
          marginBottom: 24
        }} />

        {/* App Security */}
        <p style={sectionTitle}>Sicurezza e Privacy</p>
        <p
          style={{
            fontSize: 14,
            display: "block",
            maxWidth: "60%",
            color: "#8b919d",
          }}
        >
          I dati di tracciamento sono memorizzati localmente. Le applicazioni
          non incluse in questa whitelist verranno completamente ignorate dal
          modulo di analisi del tempo.
        </p>
      </div>
    </div>
  );
}

const sectionTitle: React.CSSProperties = {
  fontSize: 11,
  fontFamily: "Roboto Mono, monospace",
  textTransform: "uppercase",
  letterSpacing: "0.15em",
  color: "#8b919d",
  marginBottom: 14,
};
