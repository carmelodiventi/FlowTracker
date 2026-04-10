import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { getSessionsForExport, listAllWorkSessions, listProjectsDetail, getSetting, Session, WorkSession, ProjectDetail } from "../api";

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

function parseLooseNumber(input: string): number {
  const normalized = input.replace(/,/g, ".");
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) return 0;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : 0;
}

function fmtMoney(n: number): string {
  return n.toFixed(2);
}

export default function ExportModal({ onClose }: Props) {
  const { t } = useTranslation();
  const [preset,     setPreset]     = useState<Preset>("month");
  const [customFrom, setCustomFrom] = useState(isoDate(new Date()));
  const [customTo,   setCustomTo]   = useState(isoDate(new Date()));
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const [hovered,    setHovered]    = useState<Preset | null>(null);

  // Filter state
  const [allWorkSessions, setAllWorkSessions] = useState<WorkSession[]>([]);
  const [projects,        setProjects]        = useState<ProjectDetail[]>([]);
  const [filterProject,   setFilterProject]   = useState<string>(""); // project id or ""
  const [filterClient,    setFilterClient]    = useState<string>(""); // client id or ""
  const [includeInvoiceMeta, setIncludeInvoiceMeta] = useState(false);
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [bankDetails, setBankDetails] = useState("");
  const [defaultHourlyRate, setDefaultHourlyRate] = useState("");
  const [defaultVatRate, setDefaultVatRate] = useState("");

  useEffect(() => {
    listAllWorkSessions().then(setAllWorkSessions).catch(console.error);
    listProjectsDetail().then(setProjects).catch(console.error);

    Promise.all([
      getSetting("invoice_meta_enabled").catch(() => "false"),
      getSetting("bank_details_default").catch(() => ""),
      getSetting("hourly_rate_default").catch(() => ""),
      getSetting("vat_rate_default").catch(() => ""),
    ]).then(([enabled, bank, rate, vat]) => {
      setIncludeInvoiceMeta(enabled === "true" || enabled === "1");
      setInvoiceNumber("");
      setBankDetails(bank || "");
      setDefaultHourlyRate(rate || "");
      setDefaultVatRate(vat || "");
    });
  }, []);

  // Derive unique clients from projects
  const clients = Array.from(
    new Map(
      projects
        .filter(p => p.client_id && p.client_name)
        .map(p => [p.client_id!, { id: p.client_id!, name: p.client_name! }])
    ).values()
  );

  // Projects filtered by selected client
  const visibleProjects = filterClient
    ? projects.filter(p => p.client_id === filterClient)
    : projects;

  // Build wsId → project mapping
  const wsProjectMap = new Map<string, { project_id: string | null; project_name: string | null; client_id: string | null; client_name: string | null }>();
  for (const ws of allWorkSessions) {
    wsProjectMap.set(ws.id, {
      project_id: ws.project_id,
      project_name: ws.project_name,
      client_id: ws.project_id
        ? (projects.find(p => p.id === ws.project_id)?.client_id ?? null)
        : null,
      client_name: ws.project_id
        ? (projects.find(p => p.id === ws.project_id)?.client_name ?? null)
        : null,
    });
  }

  // Build wsId -> task/work-session display name for export grouping
  const wsNameMap = new Map<string, string>();
  for (const ws of allWorkSessions) {
    const name = ws.name?.trim();
    if (name) wsNameMap.set(ws.id, name);
  }

  function getRange(): [string, string] {
    if (preset === "week")  return weekRange();
    if (preset === "month") return monthRange();
    return [customFrom, customTo];
  }
  const [from, to] = getRange();

  // Active filter labels for filename
  const projectLabel = filterProject ? (projects.find(p => p.id === filterProject)?.name ?? "") : "";
  const clientLabel  = filterClient  ? (clients.find(c => c.id === filterClient)?.name ?? "") : "";
  const filterSuffix = [clientLabel, projectLabel].filter(Boolean).join("-").replace(/\s+/g, "_");
  const filename = filterSuffix
    ? `flow-tracker-${filterSuffix}-${from}-to-${to}.pdf`
    : `flow-tracker-${from}-to-${to}.pdf`;

  async function handleExport() {
    setLoading(true); setError(null);
    try {
      const sessions = await getSessionsForExport(from, to);

      // Apply filters
      const filtered = sessions.filter(s => {
        if (!filterProject && !filterClient) return true;
        if (!s.work_session_id) return false;
        const meta = wsProjectMap.get(s.work_session_id);
        if (!meta) return false;
        if (filterProject && meta.project_id !== filterProject) return false;
        if (filterClient  && meta.client_id  !== filterClient)  return false;
        return true;
      });

      const totalSeconds = filtered.reduce((acc, s) => acc + (s.duration ?? 0), 0);
      const totalHours = totalSeconds / 3600;
      const hourlyRate = parseLooseNumber(defaultHourlyRate);
      const vatRate = parseLooseNumber(defaultVatRate);
      const subtotal = hourlyRate > 0 ? totalHours * hourlyRate : 0;
      const vatAmount = subtotal > 0 && vatRate > 0 ? subtotal * (vatRate / 100) : 0;
      const totalAmount = subtotal + vatAmount;

      const bytes = buildPDF(filtered, from, to, projectLabel, clientLabel, {
        includeInvoiceMeta,
        invoiceNumber: invoiceNumber.trim(),
        bankDetails: bankDetails.trim(),
        hourlyRate,
        vatRate,
        subtotal,
        vatAmount,
        totalAmount,
        totalHours,
      });
      const path = await save({
        defaultPath: filename,
        filters: [{ name: "PDF Document", extensions: ["pdf"] }],
      });
      if (!path) { setLoading(false); return; }
      await writeFile(path, bytes);
      onClose();
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }

  function buildPDF(
    sessions: Session[],
    from: string,
    to: string,
    projectLabel: string,
    clientLabel: string,
    invoiceMeta: {
      includeInvoiceMeta: boolean;
      invoiceNumber: string;
      bankDetails: string;
      hourlyRate: number;
      vatRate: number;
      subtotal: number;
      vatAmount: number;
      totalAmount: number;
      totalHours: number;
    }
  ): Uint8Array {
    const groups = new Map<string, Session[]>();
    for (const s of sessions) {
      const workSessionName = s.work_session_id ? wsNameMap.get(s.work_session_id) : undefined;
      const taskName = s.task_name?.trim();
      const key = workSessionName ?? (taskName ? taskName : "Unlabelled");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(s);
    }

    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();
    let y = 16;

    // HEADER: FlowTracker Logo + Status Badge
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.setTextColor(33, 150, 243);
    doc.text("FLOW TRACKER", 14, y);
    
    doc.setTextColor(0);
    y += 10;

    if (invoiceMeta.includeInvoiceMeta) {
      doc.setFontSize(7.5);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(139, 145, 157);
      doc.text("INVOICE DETAILS", 14, y);
      y += 5;

      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(0);
      const col1 = 14, col2 = 65, col3 = 116;
      
      doc.setFontSize(7);
      doc.setTextColor(100);
      doc.text("Invoice #", col1, y);
      doc.text("Date", col2, y);
      doc.text("Period", col3, y);
      y += 4;
      
      doc.setFontSize(9);
      doc.setTextColor(0);
      doc.setFont("helvetica", "bold");
      doc.text(invoiceMeta.invoiceNumber || "—", col1, y);
      doc.text(fmtDate(from + "T00:00:00"), col2, y);
      doc.text(`${fmtDate(from + "T00:00:00")} – ${fmtDate(to + "T00:00:00")}`, col3, y);
      y += 7;
    }

    if (clientLabel || projectLabel) {
      doc.setFontSize(7.5);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(139, 145, 157);
      doc.text("CLIENT & PROVIDER", 14, y);
      y += 5;

      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(0);
      
      if (projectLabel) {
        doc.setFontSize(7);
        doc.setTextColor(100);
        doc.text("Project", 14, y);
        doc.setFontSize(9);
        doc.setTextColor(0);
        doc.setFont("helvetica", "bold");
        doc.text(projectLabel, 14, y + 4);
        y += 9;
      }
      
      if (clientLabel) {
        doc.setFontSize(7);
        doc.setTextColor(100);
        doc.setFont("helvetica", "normal");
        doc.text("Client", 14, y);
        doc.setFontSize(9);
        doc.setTextColor(0);
        doc.setFont("helvetica", "bold");
        doc.text(clientLabel, 14, y + 4);
        y += 9;
      }

      y += 2;
    }

    let grand = 0;
    for (const [name, rows] of groups.entries()) {
      const total = rows.reduce((a, s) => a + (s.duration ?? 0), 0);
      grand += total;

      doc.setFillColor(240, 242, 245);
      doc.rect(14, y - 2.5, W - 28, 6, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      doc.setTextColor(0);
      doc.text(name.toUpperCase(), 16, y + 1);
      doc.text(`Subtotal: ${fmtSecs(total)}`, W - 14, y + 1, { align: "right" });
      y += 7;

      autoTable(doc, {
        startY: y,
        head: [["APPLICATION", "DATE", "DURATION"]],
        body: rows.map(s => [s.app_name, fmtDate(s.start_time), fmtSecs(s.duration ?? 0)]),
        theme: "plain",
        styles: {
          fontSize: 8,
          cellPadding: 2.5,
          valign: "middle",
          textColor: [0, 0, 0],
          lineColor: [230, 230, 230],
        },
        headStyles: {
          textColor: [100, 100, 100],
          fontStyle: "bold",
          fillColor: [255, 255, 255],
          lineColor: [200, 200, 200],
          valign: "middle",
          fontSize: 7,
        },
        columnStyles: {
          0: { cellWidth: W - 90 },
          1: { cellWidth: 28, halign: "left", valign: "middle" },
          2: { cellWidth: 20, halign: "left", valign: "middle" },
        },
        margin: { left: 14, right: 14 },
        didDrawPage: () => {},
      });
      y = (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8;

      if (y > H - 50) {
        doc.addPage();
        y = 16;
      }
    }

    if (invoiceMeta.includeInvoiceMeta) {
      y += 2;
      doc.setDrawColor(200);
      doc.line(14, y, W - 14, y);
      y += 6;

      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(0);

      if (invoiceMeta.hourlyRate > 0) {
        doc.setFont("helvetica", "normal");
        doc.text("Hourly Rate:", 14, y);
        doc.text(fmtMoney(invoiceMeta.hourlyRate), W - 14, y, { align: "right" });
        y += 6;

        doc.text("Worked Hours:", 14, y);
        doc.text(invoiceMeta.totalHours.toFixed(2), W - 14, y, { align: "right" });
        y += 6;

        doc.setFont("helvetica", "bold");
        doc.text("Subtotal:", 14, y);
        doc.text(fmtMoney(invoiceMeta.subtotal), W - 14, y, { align: "right" });
        y += 6;
      }

      if (invoiceMeta.vatRate > 0 && invoiceMeta.subtotal > 0) {
        doc.setFont("helvetica", "normal");
        doc.text(`VAT (${invoiceMeta.vatRate.toFixed(2)}%):`, 14, y);
        doc.text(fmtMoney(invoiceMeta.vatAmount), W - 14, y, { align: "right" });
        y += 6;
      }

      if (invoiceMeta.hourlyRate > 0) {
        doc.setFont("helvetica", "bold");
        doc.text("Total Amount:", 14, y);
        doc.text(fmtMoney(invoiceMeta.totalAmount), W - 14, y, { align: "right" });
        y += 6;
      }

      if (invoiceMeta.bankDetails) {
        y += 2;
        doc.setFillColor(245, 247, 250);
        doc.setTextColor(80);
        doc.setFontSize(8);
        const bankLines = doc.splitTextToSize(`Bank Details: ${invoiceMeta.bankDetails}`, W - 34);
        const boxH = Math.max(10, (bankLines.length * 4.2) + 4);
        doc.roundedRect(14, y - 2, W - 28, boxH, 1.5, 1.5, "F");
        doc.text(bankLines, 17, y + 2);
        doc.setTextColor(0);
        y += boxH + 2;
      }
    }

    y += 4;
    doc.setDrawColor(0);
    doc.setLineWidth(0.5);
    doc.line(14, y, W - 14, y);
    y += 8;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text("TOTAL TRACKED TIME", 14, y);
    y += 7;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(24);
    doc.setTextColor(33, 150, 243);
    doc.text(fmtSecs(grand), 14, y);
    y += 12;

    // ── Promo footer on every page ──────────────────────────────────────────
    const totalPages = (doc as jsPDF & { internal: { getNumberOfPages: () => number } }).internal.getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
      doc.setPage(i);
      const pageH = doc.internal.pageSize.getHeight();
      
      doc.setDrawColor(220);
      doc.line(14, pageH - 18, W - 14, pageH - 18);
      
      doc.setFont("helvetica", "italic");
      doc.setFontSize(7.5);
      doc.setTextColor(150);
      doc.text(
        "Generated with Flow Tracker  ·  Available on the Mac App Store & Microsoft Store",
        W / 2, pageH - 12,
        { align: "center" }
      );
    }

    return doc.output("arraybuffer") as unknown as Uint8Array;
  }

  const selectStyle = {
    background: "#10141a",
    border: `1px solid ${C.outlineVar}`,
    borderRadius: 4,
    color: C.onSurface,
    fontSize: 12,
    padding: "6px 10px",
    outline: "none",
    width: "100%",
    fontFamily: "Inter, sans-serif",
    cursor: "pointer",
  };

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
            {t("export.title")}
          </h2>
          <p style={{ margin: "8px 0 0", fontSize: 13, color: C.onSurfaceVar }}>
            {t("export.subtitle")}
          </p>
        </div>

        {/* Body */}
        <div style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: 24, maxHeight: "70vh", overflowY: "auto" }}>
          {/* Date range */}
          <div>
            <div style={{ fontFamily: "Roboto Mono, monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: C.outline, marginBottom: 12 }}>
              {t("export.timeInterval")}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <Card id="week" label={t("export.thisWeek")}
                sublabel={`${fmtLabel(weekRange()[0])} – ${fmtLabel(weekRange()[1])}`}
                icon="calendar_view_week" />
              <Card id="month" label={t("export.thisMonth")}
                sublabel={`${fmtLabel(monthRange()[0])} – ${fmtLabel(monthRange()[1])}`}
                icon="calendar_month" />
              <Card id="custom" label={t("export.customDateRange")} sublabel={t("export.specifyParams")} icon="date_range">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 20 }}>
                  {[
                    { labelKey: "export.startDate", value: customFrom, max: customTo,   onChange: (v: string) => setCustomFrom(v) },
                    { labelKey: "export.endDate",   value: customTo,   min: customFrom, onChange: (v: string) => setCustomTo(v)   },
                  ].map(f => (
                    <div key={f.labelKey}>
                      <label style={{ display: "block", fontFamily: "Roboto Mono, monospace", fontSize: 10, color: C.outline, marginBottom: 4, textTransform: "uppercase" }}>
                        {t(f.labelKey)}
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

          {/* Filters */}
          <div>
            <div style={{ fontFamily: "Roboto Mono, monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: C.outline, marginBottom: 12 }}>
              {t("export.filters")} <span style={{ color: C.outlineVar }}>({t("export.optional")})</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {/* Client filter */}
              <div>
                <label style={{ display: "block", fontSize: 11, color: C.onSurfaceVar, marginBottom: 4 }}>{t("export.client")}</label>
                <select
                  value={filterClient}
                  onChange={e => { setFilterClient(e.target.value); setFilterProject(""); }}
                  style={selectStyle}
                >
                  <option value="">{t("export.allClients")}</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              {/* Project filter */}
              <div>
                <label style={{ display: "block", fontSize: 11, color: C.onSurfaceVar, marginBottom: 4 }}>{t("export.project")}</label>
                <select
                  value={filterProject}
                  onChange={e => setFilterProject(e.target.value)}
                  style={selectStyle}
                >
                  <option value="">{t("export.allProjects")}</option>
                  {visibleProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            </div>
          </div>

          {/* Optional invoice metadata */}
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ fontFamily: "Roboto Mono, monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: C.outline }}>
                Invoice Meta <span style={{ color: C.outlineVar }}>(Optional)</span>
              </div>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 11, color: C.onSurfaceVar }}>
                <input
                  type="checkbox"
                  checked={includeInvoiceMeta}
                  onChange={(e) => setIncludeInvoiceMeta(e.target.checked)}
                  style={{ accentColor: C.primaryCont }}
                />
                Include in PDF
              </label>
            </div>

            {includeInvoiceMeta && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
                <div>
                  <label style={{ display: "block", fontSize: 11, color: C.onSurfaceVar, marginBottom: 4 }}>Invoice Number</label>
                  <input
                    type="text"
                    value={invoiceNumber}
                    onChange={(e) => setInvoiceNumber(e.target.value)}
                    placeholder="e.g. INV-2026-0042"
                    style={{ ...selectStyle, fontFamily: "Roboto Mono, monospace" }}
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 11, color: C.onSurfaceVar, marginBottom: 4 }}>Bank Details</label>
                  <textarea
                    value={bankDetails}
                    onChange={(e) => setBankDetails(e.target.value)}
                    placeholder="e.g. Beneficiary, IBAN, SWIFT/BIC, bank name"
                    rows={3}
                    style={{ ...selectStyle, resize: "vertical", fontFamily: "Roboto Mono, monospace" }}
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 11, color: C.onSurfaceVar, marginBottom: 4 }}>Auto Calculation</label>
                  <div style={{ ...selectStyle, fontFamily: "Roboto Mono, monospace", cursor: "default", lineHeight: 1.7 }}>
                    Hourly: {defaultHourlyRate || "not set"}<br />
                    VAT: {defaultVatRate || "0"}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Filename hint */}
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 14px", background: C.surfaceLowest, borderRadius: 6, border: `1px solid ${C.outlineVar}0d` }}>
            <span className="material-symbols-outlined" style={{ fontSize: 18, color: C.primary, marginTop: 1 }}>info</span>
            <span style={{ fontFamily: "Roboto Mono, monospace", fontSize: 11, color: C.onSurfaceVar, lineHeight: 1.6, wordBreak: "break-all" }}>
              {t("export.fileSavedAs")} <span style={{ color: C.primary }}>{filename}</span>
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
            {t("export.cancel")}
          </button>
          <button
            onClick={handleExport} disabled={loading}
            style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.primaryCont})`, border: "none", cursor: loading ? "not-allowed" : "pointer", color: C.onPrimaryFix, padding: "10px 28px", borderRadius: 6, fontWeight: 700, fontSize: 13, display: "flex", alignItems: "center", gap: 8, boxShadow: `0 4px 16px ${C.primary}1a`, opacity: loading ? 0.7 : 1 }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>download</span>
            {loading ? t("export.generating") : t("export.downloadPdf")}
          </button>
        </div>
      </div>
    </div>
  );
}
