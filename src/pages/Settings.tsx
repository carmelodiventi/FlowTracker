import { useEffect, useState } from "react";
import { getSetting, setSetting } from "../api";

interface SettingField {
  key: string;
  label: string;
  description: string;
  type: "number" | "select";
  options?: { value: string; label: string }[];
  unit?: string;
  min?: number;
  max?: number;
  default?: string;
}

const FIELDS: SettingField[] = [
  {
    key: "idle_timeout",
    label: "Timeout inattività",
    description: "Pausa automatica dopo N secondi senza input da tastiera o mouse.",
    type: "number",
    unit: "secondi",
    min: 30,
    max: 1800,
    default: "300",
  },
  {
    key: "auto_merge_threshold",
    label: "Soglia auto-merge",
    description: "Unifica sessioni della stessa app separate da meno di N secondi.",
    type: "number",
    unit: "secondi",
    min: 0,
    max: 600,
    default: "120",
  },
  {
    key: "focus_grace_period",
    label: "Grace period focus",
    description: "If you switch away from an app and return within N seconds, the active session is kept — no new session is created. Set to 0 to disable.",
    type: "number",
    unit: "seconds",
    min: 0,
    max: 600,
    default: "120",
  },
  {
    key: "theme",
    label: "Tema",
    description: "Aspetto dell'interfaccia.",
    type: "select",
    options: [
      { value: "dark", label: "Scuro" },
      { value: "light", label: "Chiaro" },
    ],
  },
];

export default function Settings() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all(FIELDS.map((f) => getSetting(f.key).then((v) => [f.key, v || f.default || ""] as [string, string]).catch(() => [f.key, f.default ?? ""] as [string, string])))
      .then((entries) => {
        setValues(Object.fromEntries(entries));
        setLoading(false);
      });
  }, []);

  const handleSave = async (key: string) => {
    await setSetting(key, values[key] ?? "").catch(console.error);
    setSaved((prev) => ({ ...prev, [key]: true }));
    setTimeout(() => setSaved((prev) => ({ ...prev, [key]: false })), 1500);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      {/* Top bar */}
      <header
        style={{
          display: "flex", alignItems: "center",
          padding: "0 32px", height: 56, flexShrink: 0,
          borderBottom: "1px solid rgba(65,71,82,0.2)", background: "#10141a",
        }}
      >
        <span style={{ fontFamily: "Roboto Mono, monospace", fontSize: 13, color: "#a2c9ff", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>
          Impostazioni
        </span>
      </header>

      <div className="flex-1 overflow-y-auto" style={{ padding: "32px" }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, color: "#f0f6fc", letterSpacing: "-0.04em", margin: "0 0 6px" }}>
          Impostazioni
        </h1>
        <p style={{ fontSize: 14, color: "#8b919d", marginBottom: 32 }}>
          Personalizza il comportamento del tracker. Tutte le impostazioni sono salvate localmente.
        </p>

        {loading ? (
          <div style={{ color: "#8b919d" }}>Caricamento…</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 560 }}>
            {FIELDS.map((field) => (
              <div
                key={field.key}
                style={{
                  background: "#181c22", border: "1px solid rgba(65,71,82,0.3)",
                  borderRadius: 6, padding: "20px 24px",
                }}
              >
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: "#f0f6fc", marginBottom: 4 }}>{field.label}</div>
                  <div style={{ fontSize: 12, color: "#8b919d" }}>{field.description}</div>
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  {field.type === "select" ? (
                    <select
                      value={values[field.key] ?? ""}
                      onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                      style={{
                        flex: 1, background: "#10141a", border: "1px solid #414752",
                        borderRadius: 4, padding: "8px 12px", color: "#dfe2eb",
                        fontSize: 13, outline: "none",
                      }}
                    >
                      {field.options?.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  ) : (
                    <>
                      <input
                        type="number"
                        min={field.min}
                        max={field.max}
                        value={values[field.key] ?? ""}
                        onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                        style={{
                          width: 100, background: "#10141a", border: "1px solid #414752",
                          borderRadius: 4, padding: "8px 12px", color: "#dfe2eb",
                          fontSize: 13, outline: "none", fontFamily: "Roboto Mono, monospace",
                        }}
                      />
                      {field.unit && (
                        <span style={{ fontSize: 12, color: "#8b919d" }}>{field.unit}</span>
                      )}
                    </>
                  )}
                  <button
                    onClick={() => handleSave(field.key)}
                    style={{
                      background: saved[field.key] ? "#27a640" : "#58a6ff",
                      color: "#001c38", border: "none",
                      borderRadius: 4, padding: "8px 16px", fontWeight: 700,
                      fontSize: 11, cursor: "pointer", letterSpacing: "0.05em",
                      textTransform: "uppercase", transition: "background 0.2s",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {saved[field.key] ? "✓ Salvato" : "Salva"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
