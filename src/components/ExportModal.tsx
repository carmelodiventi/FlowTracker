import { useState } from "react";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { getSessionsForExport, Session } from "../api";

// ─── Design tokens (matching Stitch/dashboard palette) ────────────────────────
const C = {
  bg:            "#10141a",
  surface:       "#1c2026",
  surfaceLow:    "#181c22",
  surfaceLowest: "#0a0e14",
  surfaceHigh:   "#262a31",
  primary:       "#a2c9ff",
  primaryCont:   "#58a6ff",
  onSurface:     "#dfe2eb",
  onSurfaceVar:  "#c0c7d4",
  outline:       "#8b919d",
  outlineVar:    "#414752",
  onPrimaryFix:  "#001c38",
};

interface Props { onClose: () => void; }
type Preset = "week" | "month" | "custom";

function fmtSecs(s: number) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
function fmtLabel(iso: string) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" }).toUpperCase();
}
function isoDate(d: Date) { return d.toISOString().slice(0, 10); }
function weekRange(): [string, string] {
  const now = new Date();
  const mon = new Date(now); mon.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  return [isoDate(mon), isoDate(sun)];
}
function monthRange(): [string, string] {
  const now = new Date();
  return [
    isoDate(new Date(now.getFullYear(), now.getMonth(), 1)),
    isoDate(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
  ];
}

export default function ExportModal({ onClose }: Props) {
  const [preset,     setPreset]     = useState<Preset>("month");
  const [customFrom, setCustomFrom] = useState(isoDate(new Date()));
  const [customTo,   setCustomTo]   = useState(isoDate(new Date()));
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const [hovered,    setHovered]    = useState<Preset | null>(null);

  function getRange(): [string, string] {
    if (preset === "week")  return weekRange();
    if (preset === "month") return monthRange();
    return [customFrom, customTo];
  }
  const [from, to] = getRange();

  async function handleExport() {
    setLoading(true); setError(null);
    try {
      const sessions = await getSessionsForExport(from, to);
      const bytes = buildPDF(sessions, from, to);

      // Show native Save As dialog
      const path = await save({
        defaultPath: `flow-tracker-${from}-to-${to}.pdf`,
        filters: [{ name: "PDF Document", extensions: ["pdf"] }],
      });
      if (!path) { setLoading(false); return; } // user cancelled

      await writeFile(path, bytes);
      onClose();
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }

  function buildPDF(sessions: Session[], from: string, to: string): Uint8Array {
    const groups = new Map<string, Session[]>();
    for (const s of sessions) {
      const key = s.task_name ?? "Unlabelled";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(s);
    }
    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const W = doc.internal.pageSize.getWidth();
    let y = 20;
    doc.setFont("helvetica", "bold"); doc.setFontSize(18);
    doc.text("Flow Tracker — Time Report", W / 2, y, { align: "center" });
    y += 8;
    doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(100);
    doc.text(`Period: ${fmtDate(from + "T00:00:00")} – ${fmtDate(to + "T00:00:00")}`, W / 2, y, { align: "center" });
    y += 12; doc.setTextColor(0);
    let grand = 0;
    for (const [name, rows] of groups.entries()) {
      const total = rows.reduce((a, s) => a + (s.duration ?? 0), 0);
      grand += total;
      doc.setFont("helvetica", "bold"); doc.setFontSize(11);
      doc.setFillColor(245, 247, 250);
      doc.rect(14, y - 4, W - 28, 7, "F");
      doc.text(name, 16, y);
      doc.text(fmtSecs(total), W - 14, y, { align: "right" });
      y += 6;
      autoTable(doc, {
        startY: y,
        head: [["Application", "Date", "Duration"]],
        body: rows.map(s => [s.app_name, fmtDate(s.start_time), fmtSecs(s.duration ?? 0)]),
        theme: "plain",
        styles: { fontSize: 9, cellPadding: 2 },
        headStyles: { textColor: [120, 120, 120], fontStyle: "normal" },
        columnStyles: { 1: { cellWidth: 35 }, 2: { cellWidth: 25, halign: "right" } },
        margin: { left: 14, right: 14 },
      });
      y = (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8;
      if (y > 260) { doc.addPage(); y = 20; }
    }
    doc.setDrawColor(200); doc.line(14, y, W - 14, y); y += 5;
    doc.setFont("helvetica", "bold"); doc.setFontSize(11);
    doc.text("Total tracked time", 14, y);
    doc.text(fmtSecs(grand), W - 14, y, { align: "right" });
    return doc.output("arraybuffer") as unknown as Uint8Array;
  }

  function Card({
    id, label, sublabel, icon, children,
  }: {
    id: Preset; label: string; sublabel: string; icon: string; children?: React.ReactNode;
  }) {
    const active = preset === id;
    const hot    = hovered === id;
    return (
      <div
        onClick={() => setPreset(id)}
        onMouseEnter={() => setHovered(id)}
        onMouseLeave={() => setHovered(null)}
        style={{
          display: "flex", flexDirection: "column",
          padding: 16,
          background: active ? C.surfaceHigh : hot ? C.surfaceHigh : C.surface,
          borderRadius: 8, cursor: "pointer",
          borderLeft: `4px solid ${active || hot ? C.primaryCont : "transparent"}`,
          transition: "background 0.15s, border-color 0.15s",
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, color: active ? C.primary : hot ? C.primary : C.onSurface }}>
              {label}
            </div>
            <div style={{ fontFamily: "Roboto Mono, monospace", fontSize: 10, color: C.onSurfaceVar, marginTop: 3, textTransform: "uppercase" }}>
              {sublabel}
            </div>
          </div>
          <span className="material-symbols-outlined" style={{ fontSize: 20, color: active ? C.primary : hot ? C.primaryCont : C.outline }}>
            {icon}
          </span>
        </div>
        {active && children}
      </div>
    );
  }

  const filename = `flow-tracker-${from}-to-${to}.pdf`;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0,
        background: "rgba(0,0,0,0.8)", backdropFilter: "blur(4px)",
        zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 520,
          background: C.surfaceLowest,
          borderRadius: 12, overflow: "hidden",
          boxShadow: "0 25px 60px rgba(0,0,0,0.6)",
          border: `1px solid ${C.outlineVar}1a`,
          display: "flex", flexDirection: "column",
        }}
      >
        {/* Header */}
        <div style={{ padding: "32px 32px 16px" }}>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 900, letterSpacing: "-0.02em", color: C.onSurface }}>
            Export Session Data
          </h2>
          <p style={{ margin: "8px 0 0", fontSize: 13, color: C.onSurfaceVar }}>
            Configure your session report parameters and file format.
          </p>
        </div>

        {/* Body */}
        <div style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: 24 }}>
          <div>
            <div style={{ fontFamily: "Roboto Mono, monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: C.outline, marginBottom: 12 }}>
              Time Interval
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <Card id="week" label="This Week"
                sublabel={`${fmtLabel(weekRange()[0])} – ${fmtLabel(weekRange()[1])}`}
                icon="calendar_view_week" />
              <Card id="month" label="This Month"
                sublabel={`${fmtLabel(monthRange()[0])} – ${fmtLabel(monthRange()[1])}`}
                icon="calendar_month" />
              <Card id="custom" label="Custom Date Range" sublabel="Specify parameters" icon="date_range">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 20 }}>
                  {[
                    { label: "Start Date", value: customFrom, max: customTo,   onChange: (v: string) => setCustomFrom(v) },
                    { label: "End Date",   value: customTo,   min: customFrom, onChange: (v: string) => setCustomTo(v)   },
                  ].map(f => (
                    <div key={f.label}>
                      <label style={{ display: "block", fontFamily: "Roboto Mono, monospace", fontSize: 10, color: C.outline, marginBottom: 4, textTransform: "uppercase" }}>
                        {f.label}
                      </label>
                      <div style={{ background: C.surfaceLowest, borderRadius: 4, borderBottom: `2px solid ${C.outlineVar}55`, padding: "6px 8px" }}>
                        <input
                          type="date"
                          value={f.value}
                          max={"max" in f ? f.max : undefined}
                          min={"min" in f ? f.min : undefined}
                          onChange={e => { e.stopPropagation(); f.onChange(e.target.value); }}
                          onClick={e => e.stopPropagation()}
                          style={{ background: "transparent", border: "none", outline: "none", width: "100%", fontFamily: "Roboto Mono, monospace", fontSize: 13, color: C.onSurface, colorScheme: "dark" }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          </div>

          {/* Filename hint */}
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 14px", background: C.surfaceLowest, borderRadius: 6, border: `1px solid ${C.outlineVar}0d` }}>
            <span className="material-symbols-outlined" style={{ fontSize: 18, color: C.primary, marginTop: 1 }}>info</span>
            <span style={{ fontFamily: "Roboto Mono, monospace", fontSize: 11, color: C.onSurfaceVar, lineHeight: 1.6 }}>
              File will be saved as <span style={{ color: C.primary }}>{filename}</span>
            </span>
          </div>

          {error && <p style={{ margin: 0, fontSize: 12, color: "#ff6b6b" }}>{error}</p>}
        </div>

        {/* Footer */}
        <div style={{ padding: "20px 32px", background: C.surfaceLow, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 16 }}>
          <button
            onClick={onClose} disabled={loading}
            style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "Roboto Mono, monospace", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: C.onSurfaceVar, padding: "8px 16px" }}
          >
            Cancel
          </button>
          <button
            onClick={handleExport} disabled={loading}
            style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.primaryCont})`, border: "none", cursor: loading ? "not-allowed" : "pointer", color: C.onPrimaryFix, padding: "10px 28px", borderRadius: 6, fontWeight: 700, fontSize: 13, display: "flex", alignItems: "center", gap: 8, boxShadow: `0 4px 16px ${C.primary}1a`, opacity: loading ? 0.7 : 1 }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>download</span>
            {loading ? "Generating…" : "Download PDF"}
          </button>
        </div>
      </div>
    </div>
  );
}
