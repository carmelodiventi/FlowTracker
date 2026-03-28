import { useEffect, useState, useMemo } from "react";
import { dailySummary, listSessionsForDate, listPendingSessions, nameSession } from "../api";
import type { Session, AppSummary } from "../api";

// App colors for the timeline blocks
const APP_COLORS = [
  "#58a6ff", "#27a640", "#f78166", "#a2c9ff",
  "#67df70", "#ffb4a3", "#4de6b1", "#d3e4ff",
];

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function toLocalDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseIso(s: string): Date {
  return new Date(s.endsWith("Z") ? s : s + "Z");
}

// Map a time (minutes since midnight) to a % position on the 8h–22h timeline
const TIMELINE_START_H = 8;
const TIMELINE_END_H = 22;
const TIMELINE_SPAN = (TIMELINE_END_H - TIMELINE_START_H) * 60;

function timeToPercent(iso: string): number {
  const d = parseIso(iso);
  const minutesSinceMidnight = d.getUTCHours() * 60 + d.getUTCMinutes();
  const offset = minutesSinceMidnight - TIMELINE_START_H * 60;
  return Math.max(0, Math.min(100, (offset / TIMELINE_SPAN) * 100));
}

function durationToPercent(secs: number): number {
  return Math.max(0.3, (secs / 60 / TIMELINE_SPAN) * 100);
}

const HOUR_LABELS = Array.from({ length: TIMELINE_END_H - TIMELINE_START_H + 1 }, (_, i) => TIMELINE_START_H + i);

export default function Dashboard() {
  const [date, setDate] = useState(toLocalDateStr(new Date()));
  const [summary, setSummary] = useState<AppSummary[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [pending, setPending] = useState<Session[]>([]);
  const [naming, setNaming] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);

  const load = async (d: string) => {
    setLoading(true);
    const [s, sess, p] = await Promise.all([
      dailySummary(d).catch(() => [] as AppSummary[]),
      listSessionsForDate(d).catch(() => [] as Session[]),
      listPendingSessions().catch(() => [] as Session[]),
    ]);
    setSummary(s);
    setSessions(sess);
    setPending(p);
    setLoading(false);
  };

  useEffect(() => { load(date); }, [date]);

  const totalSecs = useMemo(() => summary.reduce((a, s) => a + s.total_secs, 0), [summary]);
  const maxSecs = useMemo(() => summary[0]?.total_secs || 1, [summary]);

  // Assign a stable color per app name
  const appColorMap = useMemo(() => {
    const map: Record<string, string> = {};
    const seen = [...new Set(sessions.map((s) => s.app_name))];
    seen.forEach((name, i) => { map[name] = APP_COLORS[i % APP_COLORS.length]; });
    return map;
  }, [sessions]);

  const confirmName = async (id: number) => {
    const name = naming[id]?.trim();
    if (!name) return;
    await nameSession(id, name).catch(console.error);
    setPending((prev) => prev.filter((s) => s.id !== id));
  };

  const offsetDate = (delta: number) => {
    const d = new Date(date + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + delta);
    setDate(toLocalDateStr(d));
  };

  const isToday = date === toLocalDateStr(new Date());

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      {/* Top bar */}
      <header
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "0 32px", height: 56, flexShrink: 0,
          borderBottom: "1px solid rgba(65,71,82,0.2)", background: "#10141a",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={() => offsetDate(-1)} style={btnStyle}>
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>chevron_left</span>
          </button>
          <span style={{ fontFamily: "Roboto Mono, monospace", fontSize: 13, color: "#a2c9ff", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>
            {isToday ? "Oggi" : date}
          </span>
          <button onClick={() => offsetDate(1)} disabled={isToday} style={{ ...btnStyle, opacity: isToday ? 0.3 : 1 }}>
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>chevron_right</span>
          </button>
          <input
            type="date" value={date} onChange={(e) => setDate(e.target.value)}
            style={{ background: "none", border: "none", color: "#8b919d", cursor: "pointer", fontSize: 12 }}
          />
        </div>
        <span style={{ fontFamily: "Roboto Mono, monospace", fontSize: 14, color: "#a2c9ff", fontWeight: 700 }}>
          {formatDuration(totalSecs)} totale
        </span>
      </header>

      <div className="flex-1 overflow-y-auto" style={{ padding: "24px 32px" }}>
        {loading ? (
          <div style={{ color: "#8b919d", textAlign: "center", paddingTop: 80 }}>Caricamento…</div>
        ) : (
          <>
            {/* App bar chart */}
            {summary.length > 0 && (
              <section style={{ marginBottom: 32 }}>
                <h2 style={sectionTitle}>Tempo per applicazione</h2>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {summary.map((app, i) => (
                    <div key={app.process_name} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <div style={{ width: 140, fontSize: 13, color: "#c0c7d4", textAlign: "right", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {app.app_name}
                      </div>
                      <div style={{ flex: 1, height: 10, background: "#1c2026", borderRadius: 3, overflow: "hidden" }}>
                        <div
                          style={{
                            height: "100%",
                            width: `${(app.total_secs / maxSecs) * 100}%`,
                            background: APP_COLORS[i % APP_COLORS.length],
                            borderRadius: 3,
                            transition: "width 0.4s ease",
                          }}
                        />
                      </div>
                      <div style={{ width: 60, fontSize: 12, fontFamily: "Roboto Mono, monospace", color: "#8b919d" }}>
                        {formatDuration(app.total_secs)}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Timeline */}
            <section style={{ marginBottom: 32 }}>
              <h2 style={sectionTitle}>Timeline</h2>
              <div style={{ position: "relative", marginTop: 8 }}>
                {/* Hour labels */}
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  {HOUR_LABELS.map((h) => (
                    <span key={h} style={{ fontFamily: "Roboto Mono, monospace", fontSize: 10, color: "#414752", width: 0, textAlign: "center" }}>
                      {h}
                    </span>
                  ))}
                </div>
                {/* Grid + blocks */}
                <div
                  style={{
                    position: "relative", height: 60,
                    background: "#181c22", borderRadius: 4,
                    backgroundSize: `${100 / (TIMELINE_END_H - TIMELINE_START_H)}% 100%`,
                    backgroundImage: "linear-gradient(to right, rgba(65,71,82,0.15) 1px, transparent 1px)",
                    overflow: "hidden",
                  }}
                >
                  {sessions
                    .filter((s) => s.end_time && s.duration)
                    .map((s) => (
                      <div
                        key={s.id}
                        title={`${s.app_name}${s.task_name ? ` — ${s.task_name}` : ""}\n${formatDuration(s.duration!)}`}
                        style={{
                          position: "absolute",
                          left: `${timeToPercent(s.start_time)}%`,
                          width: `${durationToPercent(s.duration!)}%`,
                          top: 8, bottom: 8,
                          background: appColorMap[s.app_name] ?? "#58a6ff",
                          borderRadius: 3,
                          opacity: 0.85,
                          display: "flex", alignItems: "center",
                          padding: "0 6px", overflow: "hidden",
                        }}
                      >
                        <span style={{ fontSize: 10, fontWeight: 600, color: "#001c38", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {s.app_name}
                        </span>
                      </div>
                    ))}
                  {sessions.length === 0 && (
                    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#414752", fontSize: 12 }}>
                      Nessuna sessione registrata per questo giorno
                    </div>
                  )}
                </div>
              </div>
            </section>

            {/* Pending naming */}
            {pending.length > 0 && (
              <section>
                <h2 style={sectionTitle}>
                  <span className="material-symbols-outlined" style={{ fontSize: 16, verticalAlign: "middle", color: "#58a6ff", marginRight: 6 }}>label</span>
                  Sessioni da nominare ({pending.length})
                </h2>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {pending.map((s) => (
                    <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 12, background: "#181c22", padding: "12px 16px", borderRadius: 6, border: "1px solid rgba(65,71,82,0.3)" }}>
                      <div
                        style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: appColorMap[s.app_name] ?? "#58a6ff" }}
                      />
                      <div style={{ minWidth: 120 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#f0f6fc" }}>{s.app_name}</div>
                        <div style={{ fontSize: 11, color: "#8b919d", fontFamily: "Roboto Mono, monospace" }}>
                          {s.duration ? formatDuration(s.duration) : "—"}
                        </div>
                      </div>
                      <input
                        type="text"
                        placeholder="Nome task…"
                        value={naming[s.id] ?? ""}
                        onChange={(e) => setNaming((prev) => ({ ...prev, [s.id]: e.target.value }))}
                        onKeyDown={(e) => e.key === "Enter" && confirmName(s.id)}
                        style={{
                          flex: 1, background: "#10141a", border: "1px solid #414752",
                          borderRadius: 4, padding: "6px 10px", color: "#dfe2eb",
                          fontSize: 12, outline: "none",
                        }}
                      />
                      <button onClick={() => confirmName(s.id)} style={confirmBtnStyle}>Conferma</button>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {summary.length === 0 && sessions.length === 0 && (
              <div style={{ textAlign: "center", paddingTop: 80, color: "#414752" }}>
                <span className="material-symbols-outlined" style={{ fontSize: 48, display: "block", marginBottom: 12 }}>timeline</span>
                Nessuna attività tracciata per {isToday ? "oggi" : date}.<br />
                <span style={{ fontSize: 13, color: "#414752" }}>Assicurati di avere app nella whitelist con tracking abilitato.</span>
              </div>
            )}
          </>
        )}
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

const btnStyle: React.CSSProperties = {
  background: "none", border: "none", color: "#c0c7d4",
  cursor: "pointer", padding: 4, borderRadius: 4,
  display: "flex", alignItems: "center",
};

const confirmBtnStyle: React.CSSProperties = {
  background: "#58a6ff", color: "#001c38", border: "none",
  borderRadius: 4, padding: "6px 14px", fontWeight: 700,
  fontSize: 11, cursor: "pointer", letterSpacing: "0.05em",
  textTransform: "uppercase", whiteSpace: "nowrap",
};
