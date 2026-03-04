import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  buildRaptorTree,
  createKB,
  deleteKB,
  getAllActiveUploads,
  ingestKBFilesAsync,
  type KBScope,
  type KnowledgeBase,
  listKBs,
  type RaptorStatus,
  type UploadJob,
  updateKB,
} from "../../api.js";
import { css } from "../../styles/theme.js";
import { PageHeader } from "../shared/PageHeader.js";
import { KBPlayground } from "./KBPlayground.js";
import {
  formatBytes,
  ScopeBadge,
  ScopeToggleButtons,
  UploadDropdown,
  UploadProgressBadge,
} from "./kbShared.js";

const raptorActionBtnStyle: React.CSSProperties = {
  background: "none",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  cursor: "pointer",
  fontSize: 10,
  padding: "1px 6px",
  marginLeft: 2,
};

/** Convert an array of upload jobs to a kb_id → job map (most recent per KB). */
function uploadsToMap(uploads: UploadJob[]): Record<string, UploadJob> {
  const map: Record<string, UploadJob> = {};
  for (const u of uploads) map[u.kb_id] = u;
  return map;
}

function RaptorBadge({
  status,
  onBuild,
  building,
}: {
  status?: RaptorStatus;
  onBuild: () => void;
  building?: boolean;
}) {
  const isBuilding = building || !!status?.building;

  if (isBuilding) {
    const phase = status?.phase || "Starting";
    const pct =
      status?.clusters_total && status.clusters_total > 0
        ? Math.round(((status.clusters_completed ?? 0) / status.clusters_total) * 100)
        : null;
    return (
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          marginTop: 6,
          fontSize: 11,
          color: "var(--accent)",
        }}
      >
        <span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>⟳</span>
        <span>
          🌲 {phase}
          {status?.current_level != null && ` L${status.current_level}`}
          {pct != null && ` — ${pct}%`}
        </span>
        {pct != null && (
          <div
            style={{
              width: 60,
              height: 4,
              borderRadius: 2,
              background: "var(--border)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${pct}%`,
                background: "var(--accent)",
                borderRadius: 2,
                transition: "width 0.3s ease",
              }}
            />
          </div>
        )}
      </div>
    );
  }

  if (status?.built) {
    return (
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          marginTop: 6,
          fontSize: 11,
          color: "var(--fg2)",
        }}
      >
        <span>🌲</span>
        <span>
          RAPTOR: {status.levels} levels, {status.total_nodes} nodes
        </span>
        {status.last_built && (
          <span style={{ color: "var(--fg2)", opacity: 0.7 }}>
            · {new Date(status.last_built).toLocaleDateString()}
          </span>
        )}
        <button
          type="button"
          onClick={onBuild}
          style={{ ...raptorActionBtnStyle, color: "var(--fg2)" }}
          title="Rebuild RAPTOR index"
        >
          Rebuild
        </button>
      </div>
    );
  }

  if (status?.error_message) {
    return (
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          marginTop: 6,
          fontSize: 11,
          color: "var(--red)",
        }}
      >
        <span>🌲</span>
        <span>RAPTOR build failed</span>
        <button
          type="button"
          onClick={onBuild}
          style={{ ...raptorActionBtnStyle, color: "var(--fg2)" }}
          title="Retry RAPTOR build"
        >
          Retry
        </button>
      </div>
    );
  }

  // No status yet — show a Build button if KB has documents
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        marginTop: 6,
        fontSize: 11,
        color: "var(--fg2)",
      }}
    >
      <span>🌲</span>
      <span>No RAPTOR index</span>
      <button
        type="button"
        onClick={onBuild}
        style={{ ...raptorActionBtnStyle, color: "var(--accent)" }}
        title="Build RAPTOR index"
      >
        Build
      </button>
    </div>
  );
}

export function KBList() {
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [raptorStatuses, setRaptorStatuses] = useState<Record<string, RaptorStatus>>({});
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newScopes, setNewScopes] = useState<KBScope[]>(["chat"]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  // File upload in create form
  const [createFiles, setCreateFiles] = useState<File[]>([]);
  const createFileRef = useRef<HTMLInputElement>(null);
  const createFolderRef = useRef<HTMLInputElement>(null);
  const [createUploadMenuOpen, setCreateUploadMenuOpen] = useState(false);
  const createUploadMenuRef = useRef<HTMLDivElement>(null);

  // Active upload jobs across all KBs
  const [activeUploads, setActiveUploads] = useState<Record<string, UploadJob>>({});

  // Track KBs with a RAPTOR build being submitted (before polling picks it up)
  const [raptorSubmitting, setRaptorSubmitting] = useState<Record<string, boolean>>({});

  const anyBuilding =
    Object.values(raptorStatuses).some((s) => s.building) ||
    Object.values(raptorSubmitting).some(Boolean);
  const anyUploading = Object.values(activeUploads).some((u) => u.status === "processing");

  const refresh = useCallback(async () => {
    try {
      const { kbs: data, raptor_status } = await listKBs();
      setKbs(data);
      setRaptorStatuses(raptor_status || {});
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Poll every 3s while any KB has an in-progress RAPTOR build or active upload
  useEffect(() => {
    if (!anyBuilding && !anyUploading) return;
    const interval = setInterval(async () => {
      await refresh();
      // Also refresh upload statuses
      try {
        const { uploads } = await getAllActiveUploads();
        setActiveUploads(uploadsToMap(uploads));
      } catch {
        // non-critical
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [anyBuilding, anyUploading, refresh]);

  // Fetch active uploads on mount
  useEffect(() => {
    getAllActiveUploads()
      .then(({ uploads }) => setActiveUploads(uploadsToMap(uploads)))
      .catch(() => {});
  }, []);

  // Close create upload menu on outside click
  useEffect(() => {
    if (!createUploadMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (createUploadMenuRef.current && !createUploadMenuRef.current.contains(e.target as Node)) {
        setCreateUploadMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [createUploadMenuOpen]);

  const handleCreateFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    setCreateUploadMenuOpen(false);
    setCreateFiles(Array.from(files));
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setError("");
    try {
      const { kb } = await createKB({
        name: newName.trim(),
        description: newDesc.trim(),
        scopes: newScopes,
      });

      // If files were selected, start async upload
      if (createFiles.length > 0) {
        try {
          const { job_id } = await ingestKBFilesAsync(kb.kb_id, createFiles);
          // Add to active uploads immediately so badge shows
          setActiveUploads((prev) => ({
            ...prev,
            [kb.kb_id]: {
              job_id,
              kb_id: kb.kb_id,
              status: "processing",
              files: createFiles.map((f) => ({
                name: f.webkitRelativePath || f.name,
                status: "pending" as const,
              })),
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          }));
        } catch (uploadErr: any) {
          // KB created but upload failed — show error but don't block
          setError(`KB created but upload failed: ${uploadErr.message}`);
        }
      }

      setNewName("");
      setNewDesc("");
      setNewScopes(["chat"]);
      setCreateFiles([]);
      setShowCreate(false);
      if (createFileRef.current) createFileRef.current.value = "";
      if (createFolderRef.current) createFolderRef.current.value = "";
      await refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleToggle = async (kb: KnowledgeBase) => {
    try {
      await updateKB(kb.kb_id, { enabled: !kb.enabled });
      await refresh();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDelete = async (kb: KnowledgeBase) => {
    if (!confirm(`Delete "${kb.name}" and all its data?`)) return;
    try {
      await deleteKB(kb.kb_id);
      await refresh();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleBuildRaptor = async (kbId: string) => {
    setRaptorSubmitting((prev) => ({ ...prev, [kbId]: true }));
    setError("");
    try {
      await buildRaptorTree(kbId);
      // Trigger an immediate refresh so polling picks up the building state
      await refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRaptorSubmitting((prev) => ({ ...prev, [kbId]: false }));
    }
  };

  const toggleScope = (scope: KBScope) => {
    setNewScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  };

  return (
    <div>
      <PageHeader
        title="Knowledge Bases"
        count={kbs.length}
        actions={
          <button type="button" style={css.btnPrimary} onClick={() => setShowCreate(!showCreate)}>
            {showCreate ? "Cancel" : "+ New KB"}
          </button>
        }
      />

      {error && <div style={css.error}>{error}</div>}

      {showCreate && (
        <div style={{ ...css.card, marginBottom: 20 }}>
          <div style={css.field}>
            <label style={css.label}>Name</label>
            <input
              style={css.input}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Design Docs, Steve Lore, Slack History"
            />
          </div>
          <div style={css.field}>
            <label style={css.label}>Description</label>
            <input
              style={css.input}
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder="What kind of data does this KB contain?"
            />
          </div>
          <div style={css.field}>
            <label style={css.label}>Scopes (which actions can use this KB)</label>
            <ScopeToggleButtons scopes={newScopes} onToggle={toggleScope} />
          </div>
          <div style={css.field}>
            <label style={css.label}>Upload Files (optional)</label>
            <p style={{ fontSize: 12, color: "var(--fg2)", margin: "0 0 8px" }}>
              Select files or a folder to upload immediately after creation.
            </p>
            {/* Hidden file inputs */}
            <input
              ref={createFileRef}
              type="file"
              multiple
              onChange={handleCreateFileSelect}
              style={{ display: "none" }}
            />
            <input
              ref={createFolderRef}
              type="file"
              /* @ts-expect-error webkitdirectory is non-standard but widely supported */
              webkitdirectory=""
              onChange={handleCreateFileSelect}
              style={{ display: "none" }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <UploadDropdown
                menuRef={createUploadMenuRef}
                open={createUploadMenuOpen}
                onToggle={() => setCreateUploadMenuOpen((v) => !v)}
                disabled={false}
                onSelectFiles={() => createFileRef.current?.click()}
                onSelectFolder={() => createFolderRef.current?.click()}
              />
              {createFiles.length > 0 && (
                <span style={{ fontSize: 12, color: "var(--fg2)" }}>
                  {createFiles.length} file{createFiles.length !== 1 ? "s" : ""} selected
                  <button
                    type="button"
                    onClick={() => {
                      setCreateFiles([]);
                      if (createFileRef.current) createFileRef.current.value = "";
                      if (createFolderRef.current) createFolderRef.current.value = "";
                    }}
                    style={{
                      background: "none",
                      border: "none",
                      color: "var(--red)",
                      cursor: "pointer",
                      fontSize: 11,
                      marginLeft: 6,
                    }}
                  >
                    Clear
                  </button>
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            style={css.btnPrimary}
            disabled={creating || !newName.trim()}
            onClick={handleCreate}
          >
            {creating
              ? "Creating..."
              : createFiles.length > 0
                ? `Create & Upload ${createFiles.length} file${createFiles.length !== 1 ? "s" : ""}`
                : "Create Knowledge Base"}
          </button>
        </div>
      )}

      <KBPlayground />

      {loading ? (
        <div style={{ color: "var(--fg2)", padding: 20 }}>Loading...</div>
      ) : kbs.length === 0 ? (
        <div style={{ ...css.card, textAlign: "center", color: "var(--fg2)" }}>
          No knowledge bases yet. Create one to get started.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {kbs.map((kb) => (
            <div key={kb.kb_id} style={css.card}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                    <Link
                      to={`/knowledge/${kb.kb_id}`}
                      style={{
                        fontSize: 16,
                        fontWeight: 600,
                        color: "var(--accent2)",
                        textDecoration: "none",
                      }}
                    >
                      {kb.name}
                    </Link>
                    <span
                      style={{
                        ...css.badge(kb.enabled ? "#22c55e" : "#6b7280"),
                        cursor: "pointer",
                      }}
                      onClick={() => handleToggle(kb)}
                      title={`Click to ${kb.enabled ? "disable" : "enable"}`}
                    >
                      {kb.enabled ? "enabled" : "disabled"}
                    </span>
                  </div>
                  {kb.description && (
                    <div style={{ fontSize: 13, color: "var(--fg2)", marginBottom: 8 }}>
                      {kb.description}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                    {kb.scopes.map((s) => (
                      <ScopeBadge key={s} scope={s} />
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--fg2)" }}>
                    <span>{kb.document_count} docs</span>
                    <span>{kb.chunk_count} chunks</span>
                    <span>{formatBytes(kb.total_size_bytes)}</span>
                    <span>model: {kb.embedding_model}</span>
                  </div>
                  <RaptorBadge
                    status={raptorStatuses[kb.kb_id]}
                    onBuild={() => handleBuildRaptor(kb.kb_id)}
                    building={raptorSubmitting[kb.kb_id]}
                  />
                  {activeUploads[kb.kb_id] && (
                    <div style={{ marginTop: 6 }}>
                      <UploadProgressBadge job={activeUploads[kb.kb_id]} />
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <Link to={`/knowledge/${kb.kb_id}`}>
                    <button type="button" style={css.btnSmall}>
                      View
                    </button>
                  </Link>
                  <button type="button" style={css.btnDanger} onClick={() => handleDelete(kb)}>
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
