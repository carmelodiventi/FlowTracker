import { useEffect, useState, useCallback } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  listProjectsDetail,
  listClients,
  createProject,
  updateProject,
  deleteProject,
  createClient,
  deleteClient,
} from "../api";
import type { ProjectDetail, Client } from "../api";

// ─── Style constants ──────────────────────────────────────────────────────────

const BG        = "#0d1117";
const CARD      = "#161b22";
const BORDER    = "#30363d";
const TEXT      = "#e6edf3";
const MUTED     = "#8b949e";
const ACCENT    = "#58a6ff";

const inputStyle: CSSProperties = {
  background: BG,
  border: `1px solid ${BORDER}`,
  borderRadius: 6,
  color: TEXT,
  padding: "8px 10px",
  fontSize: 13,
  width: "100%",
  outline: "none",
  boxSizing: "border-box",
  fontFamily: "Inter, sans-serif",
};

const textareaStyle: CSSProperties = {
  background: BG,
  border: `1px solid ${BORDER}`,
  borderRadius: 6,
  color: TEXT,
  padding: "8px 10px",
  fontSize: 13,
  width: "100%",
  outline: "none",
  resize: "vertical",
  fontFamily: "Inter, sans-serif",
  boxSizing: "border-box",
};

const selectStyle: CSSProperties = {
  background: BG,
  border: `1px solid ${BORDER}`,
  borderRadius: 6,
  color: TEXT,
  padding: "6px 10px",
  fontSize: 13,
  width: "100%",
  outline: "none",
};

function pillBtn(bg: string, color: string): CSSProperties {
  return {
    background: bg,
    color,
    border: "none",
    borderRadius: 6,
    padding: "7px 16px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    letterSpacing: "0.02em",
    whiteSpace: "nowrap" as const,
  };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface ProjectFormState {
  name: string;
  description: string;
  clientId: string | null;
}

function emptyForm(): ProjectFormState {
  return { name: "", description: "", clientId: null };
}

interface ProjectFormProps {
  form: ProjectFormState;
  clients: Client[];
  onChange: (f: ProjectFormState) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel: string;
}

function ProjectForm({ form, clients, onChange, onSubmit, onCancel, submitLabel }: ProjectFormProps) {
  const { t } = useTranslation();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <input
        autoFocus
        value={form.name}
        onChange={(e) => onChange({ ...form, name: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter" && form.name.trim()) onSubmit();
          if (e.key === "Escape") onCancel();
        }}
        placeholder={t("projects.projectNamePlaceholder")}
        style={inputStyle}
      />
      <textarea
        rows={2}
        value={form.description}
        onChange={(e) => onChange({ ...form, description: e.target.value })}
        placeholder={t("projects.descriptionPlaceholder")}
        style={textareaStyle}
      />
      <select
        value={form.clientId ?? ""}
        onChange={(e) =>
          onChange({ ...form, clientId: e.target.value ? e.target.value : null })
        }
        style={selectStyle}
      >
        <option value="">{t("projects.noClient")}</option>
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={onCancel} style={pillBtn("rgba(255,255,255,0.07)", MUTED)}>
          {t("projects.cancel")}
        </button>
        <button
          onClick={onSubmit}
          disabled={!form.name.trim()}
          style={{ ...pillBtn(ACCENT, "#0d1117"), opacity: form.name.trim() ? 1 : 0.4 }}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Projects() {
  const { t } = useTranslation();
  const [projects, setProjects]       = useState<ProjectDetail[]>([]);
  const [clients, setClients]         = useState<Client[]>([]);
  const [loading, setLoading]         = useState(true);

  // Create project form
  const [showCreate, setShowCreate]   = useState(false);
  const [createForm, setCreateForm]   = useState<ProjectFormState>(emptyForm());

  // Edit project
  const [editingId, setEditingId]     = useState<string | null>(null);
  const [editForm, setEditForm]       = useState<ProjectFormState>(emptyForm());

  // New client
  const [newClientName, setNewClientName] = useState("");
  const [clientError, setClientError]     = useState<string | null>(null);

  // ── Data loading ─────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [projs, clts] = await Promise.all([
        listProjectsDetail().catch(() => [] as ProjectDetail[]),
        listClients().catch(() => [] as Client[]),
      ]);
      setProjects(projs);
      setClients(clts);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Handlers ─────────────────────────────────────────────────────────────────

  const handleCreate = async () => {
    if (!createForm.name.trim()) return;
    await createProject(
      createForm.name.trim(),
      createForm.description.trim() || null,
      createForm.clientId
    ).catch(console.error);
    setShowCreate(false);
    setCreateForm(emptyForm());
    await load();
  };

  const handleEdit = (p: ProjectDetail) => {
    setEditingId(p.id);
    setEditForm({
      name:        p.name,
      description: p.description ?? "",
      clientId:    p.client_id,
    });
    setShowCreate(false);
  };

  const handleSaveEdit = async () => {
    if (editingId === null || !editForm.name.trim()) return;
    await updateProject(
      editingId,
      editForm.name.trim(),
      editForm.description.trim() || null,
      editForm.clientId
    ).catch(console.error);
    setEditingId(null);
    setEditForm(emptyForm());
    await load();
  };

  const handleDelete = async (id: string) => {
    await deleteProject(id).catch(console.error);
    await load();
  };

  const handleAddClient = async () => {
    const name = newClientName.trim();
    if (!name) return;
    setClientError(null);
    try {
      await createClient(name);
      setNewClientName("");
      await load();
    } catch (e) {
      setClientError(String(e));
    }
  };

  const handleDeleteClient = async (id: string) => {
    await deleteClient(id).catch(console.error);
    await load();
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        minHeight: "100vh",
        background: BG,
        color: TEXT,
        fontFamily: "Inter, sans-serif",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
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
        }}
      >
        <h1
          style={{
            margin: 0,
            fontSize: 18,
            fontWeight: 800,
            letterSpacing: "-0.03em",
            color: "#f6f6fc",
          }}
        >
          {t("projects.title")}
        </h1>
      </header>

      {/* Body */}
      <div
        style={{
          flex: 1,
          padding: "32px 44px",
          maxWidth: 1100,
          width: "100%",
          margin: "0 auto",
          boxSizing: "border-box",
        }}
      >
        {loading ? (
          <div style={{ color: MUTED, textAlign: "center", paddingTop: 80, fontSize: 14 }}>
            {t("projects.loading")}
          </div>
        ) : (
          <div style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap" }}>

            {/* ── LEFT: Projects ── */}
            <div style={{ flex: "3 1 420px", minWidth: 320 }}>
              {/* Section header */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 16,
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    color: MUTED,
                  }}
                >
                  {t("projects.title")}
                </span>
                <button
                  onClick={() => { setShowCreate((v) => !v); setEditingId(null); setCreateForm(emptyForm()); }}
                  title="Add project"
                  style={{
                    background: "none",
                    border: `1px solid ${BORDER}`,
                    borderRadius: 6,
                    color: TEXT,
                    cursor: "pointer",
                    padding: "4px 10px",
                    fontSize: 12,
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
                  {t("projects.new")}
                </button>
              </div>

              {/* Create form */}
              {showCreate && (
                <div
                  style={{
                    background: CARD,
                    border: `1px solid ${ACCENT}44`,
                    borderRadius: 10,
                    padding: "16px 18px",
                    marginBottom: 16,
                  }}
                >
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: ACCENT,
                      marginBottom: 12,
                      letterSpacing: "0.04em",
                    }}
                  >
                    {t("projects.newProjectBadge")}
                  </div>
                  <ProjectForm
                    form={createForm}
                    clients={clients}
                    onChange={setCreateForm}
                    onSubmit={handleCreate}
                    onCancel={() => { setShowCreate(false); setCreateForm(emptyForm()); }}
                    submitLabel={t("projects.create")}
                  />
                </div>
              )}

              {/* Projects list */}
              {projects.length === 0 && !showCreate ? (
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
                    folder_open
                  </span>
                  <span style={{ fontSize: 13 }}>{t("projects.noProjects")}</span>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {projects.map((p) => (
                    <div
                      key={p.id}
                      style={{
                        background: CARD,
                        border: `1px solid ${BORDER}`,
                        borderLeft: `4px solid ${p.color}`,
                        borderRadius: 8,
                        overflow: "hidden",
                      }}
                    >
                      {editingId === p.id ? (
                        /* ── Inline edit mode ── */
                        <div style={{ padding: "14px 16px" }}>
                          <div
                            style={{
                              fontSize: 12,
                              fontWeight: 600,
                              color: p.color,
                              marginBottom: 12,
                              letterSpacing: "0.04em",
                            }}
                          >
                            {t("projects.editingBadge")}
                          </div>
                          <ProjectForm
                            form={editForm}
                            clients={clients}
                            onChange={setEditForm}
                            onSubmit={handleSaveEdit}
                            onCancel={() => { setEditingId(null); setEditForm(emptyForm()); }}
                            submitLabel={t("projects.save")}
                          />
                        </div>
                      ) : (
                        /* ── Display mode ── */
                        <div
                          style={{
                            padding: "14px 16px",
                            display: "flex",
                            alignItems: "flex-start",
                            gap: 12,
                          }}
                        >
                          {/* Color dot */}
                          <div
                            style={{
                              width: 10,
                              height: 10,
                              borderRadius: "50%",
                              background: p.color,
                              flexShrink: 0,
                              marginTop: 4,
                            }}
                          />

                          {/* Info */}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                                flexWrap: "wrap",
                                marginBottom: p.description ? 4 : 0,
                              }}
                            >
                              <span
                                style={{
                                  fontSize: 14,
                                  fontWeight: 700,
                                  color: TEXT,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {p.name}
                              </span>
                              {p.client_name && (
                                <span
                                  style={{
                                    fontSize: 11,
                                    padding: "2px 8px",
                                    borderRadius: 10,
                                    background: "rgba(88,166,255,0.12)",
                                    border: "1px solid rgba(88,166,255,0.25)",
                                    color: ACCENT,
                                    fontWeight: 500,
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {p.client_name}
                                </span>
                              )}
                            </div>
                            {p.description && (
                              <p
                                style={{
                                  margin: 0,
                                  fontSize: 12,
                                  color: MUTED,
                                  lineHeight: 1.45,
                                  display: "-webkit-box" as CSSProperties["display"],
                                  WebkitLineClamp: 2,
                                  WebkitBoxOrient: "vertical" as const,
                                  overflow: "hidden",
                                }}
                              >
                                {p.description}
                              </p>
                            )}
                          </div>

                          {/* Actions */}
                          <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                            <button
                              onClick={() => handleEdit(p)}
                              title="Edit project"
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
                              onMouseEnter={(e) => (e.currentTarget.style.color = MUTED)}
                              onMouseLeave={(e) => (e.currentTarget.style.color = "#484f58")}
                            >
                              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                                edit
                              </span>
                            </button>
                            <button
                              onClick={() => handleDelete(p.id)}
                              title="Delete project"
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
                              onMouseEnter={(e) => (e.currentTarget.style.color = "#f85149")}
                              onMouseLeave={(e) => (e.currentTarget.style.color = "#484f58")}
                            >
                              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                                delete
                              </span>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── RIGHT: Clients ── */}
            <div style={{ flex: "2 1 260px", minWidth: 220 }}>
              {/* Section header */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 16,
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    color: MUTED,
                  }}
                >
                  {t("projects.clients")}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    color: "#484f58",
                    fontFamily: "Roboto Mono, monospace",
                  }}
                >
                  {t("projects.clientsTotal", { count: clients.length })}
                </span>
              </div>

              {/* Clients list */}
              <div
                style={{
                  background: CARD,
                  border: `1px solid ${BORDER}`,
                  borderRadius: 8,
                  overflow: "hidden",
                }}
              >
                {clients.length === 0 ? (
                  <div
                    style={{
                      padding: "24px 16px",
                      textAlign: "center",
                      color: "#484f58",
                      fontSize: 12,
                    }}
                  >
                    {t("projects.noClients")}
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    {clients.map((c, i) => (
                      <div
                        key={c.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "10px 14px",
                          borderBottom:
                            i < clients.length - 1
                              ? `1px solid rgba(255,255,255,0.04)`
                              : "none",
                          gap: 8,
                        }}
                      >
                        <span style={{ fontSize: 13, color: TEXT, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {c.name}
                        </span>
                        <button
                          onClick={() => handleDeleteClient(c.id)}
                          title="Remove client"
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
                          onMouseEnter={(e) => (e.currentTarget.style.color = "#f85149")}
                          onMouseLeave={(e) => (e.currentTarget.style.color = "#484f58")}
                        >
                          <span className="material-symbols-outlined" style={{ fontSize: 15 }}>
                            delete
                          </span>
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Add client row */}
                <div
                  style={{
                    padding: "10px 14px",
                    borderTop: `1px solid ${BORDER}`,
                    display: "flex",
                    gap: 8,
                  }}
                >
                  <input
                    value={newClientName}
                    onChange={(e) => { setNewClientName(e.target.value); setClientError(null); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAddClient();
                      if (e.key === "Escape") setNewClientName("");
                    }}
                    placeholder={t("projects.newClientPlaceholder")}
                    style={{ ...inputStyle, flex: 1, padding: "6px 10px" }}
                  />
                  <button
                    onClick={handleAddClient}
                    disabled={!newClientName.trim()}
                    style={{
                      ...pillBtn(ACCENT, "#0d1117"),
                      opacity: newClientName.trim() ? 1 : 0.4,
                      padding: "6px 14px",
                    }}
                  >
                    {t("projects.add")}
                  </button>
                </div>

                {clientError && (
                  <div
                    style={{
                      padding: "6px 14px 10px",
                      fontSize: 11,
                      color: "#f85149",
                    }}
                  >
                    {clientError}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
