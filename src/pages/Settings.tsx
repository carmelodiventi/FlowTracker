import { useEffect, useState } from "react";
import { getSetting, setSetting } from "../api";
import {
  type AIProvider,
  isOllamaAvailable,
  listOllamaModels,
} from "../lib/ai";

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

  // AI settings state
  const [aiProvider, setAiProvider] = useState<AIProvider>("none");
  const [aiApiKey, setAiApiKey] = useState("");
  const [aiOllamaModel, setAiOllamaModel] = useState("llama3.2");
  const [ollamaAvailable, setOllamaAvailable] = useState<boolean | null>(null);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [aiSaved, setAiSaved] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);

  useEffect(() => {
    Promise.all(FIELDS.map((f) => getSetting(f.key).then((v) => [f.key, v || f.default || ""] as [string, string]).catch(() => [f.key, f.default ?? ""] as [string, string])))
      .then((entries) => {
        setValues(Object.fromEntries(entries));
        setLoading(false);
      });

      

    // Load AI settings
    Promise.all([
      getSetting("ai_provider").catch(() => "none"),
      getSetting("ai_api_key").catch(() => ""),
      getSetting("ai_ollama_model").catch(() => "llama3.2"),
    ]).then(([prov, key, model]) => {
      setAiProvider((prov as AIProvider) || "none");
      setAiApiKey(key || "");
      setAiOllamaModel(model || "llama3.2");
    });
  }, []);

  // Check Ollama when provider switches to ollama
  useEffect(() => {
    if (aiProvider === "ollama") {
      isOllamaAvailable().then((ok) => {
        setOllamaAvailable(ok);
        if (ok) listOllamaModels().then(setOllamaModels);
      });
    } else {
      setOllamaAvailable(null);
    }
  }, [aiProvider]);

  const handleSaveAI = async () => {
    await Promise.all([
      setSetting("ai_provider", aiProvider),
      setSetting("ai_api_key", aiApiKey),
      setSetting("ai_ollama_model", aiOllamaModel),
    ]).catch(console.error);
    setAiSaved(true);
    setTimeout(() => setAiSaved(false), 1500);
  };

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

        {/* ── AI Integration ─────────────────────────────────────────────── */}
        <div style={{ marginTop: 40, maxWidth: 560 }}>
          <div style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: "#f0f6fc", margin: "0 0 4px" }}>
              ✨ AI Integration
            </h2>
            <p style={{ fontSize: 13, color: "#8b919d", margin: 0 }}>
              Suggest task names and generate invoice descriptions automatically.
              Your API key is stored locally and never leaves your device.
            </p>
          </div>

          <div style={{ background: "#181c22", border: "1px solid rgba(65,71,82,0.3)", borderRadius: 6, padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}>

            {/* Provider selector */}
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#c9d1d9", marginBottom: 8 }}>Provider</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {(["none", "openai", "mistral", "google", "ollama"] as AIProvider[]).map((p) => {
                  const labels: Record<AIProvider, string> = {
                    none: "Disabled",
                    openai: "OpenAI",
                    mistral: "Mistral",
                    google: "Gemini",
                    ollama: "Ollama (local)",
                  };
                  return (
                    <button
                      key={p}
                      onClick={() => setAiProvider(p)}
                      style={{
                        padding: "6px 14px", borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: "pointer",
                        background: aiProvider === p ? (p === "none" ? "rgba(139,148,158,0.15)" : "rgba(88,166,255,0.15)") : "transparent",
                        border: aiProvider === p ? (p === "none" ? "1px solid #8b949e" : "1px solid #58a6ff") : "1px solid rgba(255,255,255,0.08)",
                        color: aiProvider === p ? (p === "none" ? "#8b949e" : "#58a6ff") : "#8b949e",
                        transition: "all 0.15s",
                      }}
                    >
                      {labels[p]}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* API key (not needed for Ollama or none) */}
            {aiProvider !== "none" && aiProvider !== "ollama" && (
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#c9d1d9", marginBottom: 8 }}>
                  API Key
                  {aiProvider === "openai" && <span style={{ color: "#8b949e", fontWeight: 400 }}> — openai.com</span>}
                  {aiProvider === "mistral" && <span style={{ color: "#8b949e", fontWeight: 400 }}> — console.mistral.ai</span>}
                  {aiProvider === "google" && <span style={{ color: "#8b949e", fontWeight: 400 }}> — aistudio.google.com</span>}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    type={showApiKey ? "text" : "password"}
                    value={aiApiKey}
                    onChange={(e) => setAiApiKey(e.target.value)}
                    placeholder="Paste your API key…"
                    style={{
                      flex: 1, background: "#10141a", border: "1px solid #414752", borderRadius: 4,
                      padding: "8px 12px", color: "#dfe2eb", fontSize: 13, outline: "none",
                      fontFamily: "Roboto Mono, monospace",
                    }}
                  />
                  <button
                    onClick={() => setShowApiKey(!showApiKey)}
                    style={{ background: "transparent", border: "1px solid #414752", borderRadius: 4, padding: "8px 10px", color: "#8b949e", cursor: "pointer", fontSize: 13 }}
                    title={showApiKey ? "Hide key" : "Show key"}
                  >
                    <span className="material-icons" style={{ fontSize: 16, verticalAlign: "middle" }}>
                      {showApiKey ? "visibility_off" : "visibility"}
                    </span>
                  </button>
                </div>
              </div>
            )}

            {/* Ollama model selector */}
            {aiProvider === "ollama" && (
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#c9d1d9", marginBottom: 8 }}>
                  Ollama Model
                  {ollamaAvailable === true && (
                    <span style={{ marginLeft: 8, fontSize: 11, color: "#3fb950" }}>● Running</span>
                  )}
                  {ollamaAvailable === false && (
                    <span style={{ marginLeft: 8, fontSize: 11, color: "#f85149" }}>● Not running — start Ollama first</span>
                  )}
                </div>
                {ollamaModels.length > 0 ? (
                  <select
                    value={aiOllamaModel}
                    onChange={(e) => setAiOllamaModel(e.target.value)}
                    style={{
                      background: "#10141a", border: "1px solid #414752", borderRadius: 4,
                      padding: "8px 12px", color: "#dfe2eb", fontSize: 13, outline: "none", width: "100%",
                    }}
                  >
                    {ollamaModels.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={aiOllamaModel}
                    onChange={(e) => setAiOllamaModel(e.target.value)}
                    placeholder="e.g. llama3.2, mistral, phi3"
                    style={{
                      width: "100%", boxSizing: "border-box", background: "#10141a", border: "1px solid #414752",
                      borderRadius: 4, padding: "8px 12px", color: "#dfe2eb", fontSize: 13, outline: "none",
                    }}
                  />
                )}
              </div>
            )}

            <div>
              <button
                onClick={handleSaveAI}
                style={{
                  background: aiSaved ? "#27a640" : "#58a6ff", color: "#001c38", border: "none",
                  borderRadius: 4, padding: "9px 20px", fontWeight: 700, fontSize: 12, cursor: "pointer",
                  letterSpacing: "0.05em", textTransform: "uppercase", transition: "background 0.2s",
                }}
              >
                {aiSaved ? "✓ Saved" : "Save AI Settings"}
              </button>
              {aiProvider !== "none" && (
                <span style={{ marginLeft: 12, fontSize: 11, color: "#8b949e" }}>
                  Used for: ✨ Suggest task name · 📄 Invoice descriptions
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
