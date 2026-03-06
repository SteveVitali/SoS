import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  type ChunkRecord,
  deleteKBDocument,
  getActiveUploadsForKB,
  getKB,
  getUploadJob,
  ingestKBFiles,
  type KBDocument,
  type KBScope,
  type KBSearchResult,
  type KnowledgeBase,
  listDocumentChunks,
  searchKB,
  type UploadJob,
  updateKB,
} from "../../api.js";
import { css } from "../../styles/theme.js";
import { FtsStatus } from "./FtsStatus.js";
import {
  DropOverlay,
  formatBytes,
  ScopeBadge,
  ScopeToggleButtons,
  SearchResultCard,
  UploadDropdown,
  UploadProgressBadge,
  useDropZone,
} from "./kbShared.js";
import { RaptorStatus } from "./RaptorStatus.js";
import { RaptorTree } from "./RaptorTree.js";

// ---------------------------------------------------------------------------
// Types & small sub-components used by KBDetail
// ---------------------------------------------------------------------------

type FileStatus =
  | { state: "pending" }
  | { state: "processing" }
  | { state: "done"; chunks: number }
  | { state: "skipped"; reason: string }
  | { state: "error"; error: string };

/** Convert a server-side UploadFileStatus to the local FileStatus union. */
function toFileStatus(f: import("../../api.js").UploadFileStatus): FileStatus {
  switch (f.status) {
    case "pending":
      return { state: "pending" };
    case "processing":
      return { state: "processing" };
    case "done":
      return { state: "done", chunks: f.chunks ?? 0 };
    case "skipped":
      return { state: "skipped", reason: f.skip_reason ?? "skipped" };
    case "error":
      return { state: "error", error: f.error ?? "unknown error" };
  }
}

function FileStatusRow({ name, status }: { name: string; status: FileStatus }) {
  let icon: string;
  let color: string;
  let badge = "";
  switch (status.state) {
    case "pending":
      icon = "◦";
      color = "var(--fg2)";
      break;
    case "processing":
      icon = "⟳";
      color = "var(--accent)";
      break;
    case "done":
      icon = "✓";
      color = "var(--green)";
      badge = `${status.chunks} chunk${status.chunks !== 1 ? "s" : ""}`;
      break;
    case "skipped":
      icon = "–";
      color = "var(--fg2)";
      badge = status.reason;
      break;
    case "error":
      icon = "✗";
      color = "var(--red)";
      badge = status.error;
      break;
  }
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 10px",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <span style={{ color, flexShrink: 0 }}>{icon}</span>
      <span
        style={{
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: status.state === "pending" ? "var(--fg2)" : "var(--fg)",
        }}
        title={name}
      >
        {name}
      </span>
      {badge && (
        <span
          style={{
            flexShrink: 0,
            fontSize: 11,
            color: status.state === "error" ? "var(--red)" : "var(--fg2)",
            maxWidth: 180,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={badge}
        >
          {badge}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function KBDetail() {
  const { id } = useParams<{ id: string }>();
  const [kb, setKb] = useState<KnowledgeBase | null>(null);
  const [documents, setDocuments] = useState<KBDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [ingesting, setIngesting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);
  const uploadMenuRef = useRef<HTMLDivElement>(null);

  const [fileStatuses, setFileStatuses] = useState<Record<string, FileStatus>>({});
  const [ingestSummary, setIngestSummary] = useState<string>("");
  const [activeUploadJob, setActiveUploadJob] = useState<UploadJob | null>(null);

  // Drag-and-drop
  const onDropFiles = useCallback((files: File[]) => {
    ingestFileListRef.current?.(files);
  }, []);
  const { isDragging, dropZoneProps } = useDropZone({ onDrop: onDropFiles, disabled: ingesting });
  // Ref to break circular dependency: useDropZone needs onDrop, ingestFileList needs kb
  const ingestFileListRef = useRef<((files: File[]) => Promise<void>) | null>(null);

  // Chunk exploration state
  const [expandedDoc, setExpandedDoc] = useState<string | null>(null);
  const [chunkCache, setChunkCache] = useState<
    Record<string, { chunks: ChunkRecord[]; total: number }>
  >({});
  const [chunkLoading, setChunkLoading] = useState(false);
  const [chunkPage, setChunkPage] = useState(0);
  const [expandedChunkId, setExpandedChunkId] = useState<string | null>(null);
  const CHUNKS_PER_PAGE = 20;

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<KBSearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  // Settings editing
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editScopes, setEditScopes] = useState<KBScope[]>([]);
  const [editChunkSize, setEditChunkSize] = useState(512);
  const [editChunkOverlap, setEditChunkOverlap] = useState(50);
  const [editMaxChunks, setEditMaxChunks] = useState(5);
  const [editMinScore, setEditMinScore] = useState(0.3);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const data = await getKB(id);
      setKb(data.kb);
      setDocuments(data.documents);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Hydrate upload state from server on mount
  const hydrateUploads = useCallback(async () => {
    if (!id) return;
    try {
      const { uploads } = await getActiveUploadsForKB(id);
      if (uploads.length > 0) {
        const job = uploads[0]; // most recent active job
        setActiveUploadJob(job);
        setIngesting(true);
        const restored: Record<string, FileStatus> = {};
        for (const f of job.files) restored[f.name] = toFileStatus(f);
        setFileStatuses(restored);
      }
    } catch {
      // Non-critical — upload status just won't be restored
    }
  }, [id]);

  useEffect(() => {
    hydrateUploads();
  }, [hydrateUploads]);

  // Poll active upload job until complete
  useEffect(() => {
    if (!activeUploadJob || activeUploadJob.status !== "processing" || !id) return;
    const interval = setInterval(async () => {
      try {
        const { job } = await getUploadJob(id, activeUploadJob.job_id);
        setActiveUploadJob(job);
        const updated: Record<string, FileStatus> = {};
        for (const f of job.files) updated[f.name] = toFileStatus(f);
        setFileStatuses(updated);
        if (job.status !== "processing") {
          setIngesting(false);
          if (job.summary) {
            setIngestSummary(
              `Done — ${job.summary.documents_added} doc${job.summary.documents_added !== 1 ? "s" : ""}, ` +
                `${job.summary.chunks_added} chunk${job.summary.chunks_added !== 1 ? "s" : ""}` +
                (job.summary.skipped ? `, ${job.summary.skipped} skipped` : "") +
                (job.summary.errors
                  ? `, ${job.summary.errors} error${job.summary.errors !== 1 ? "s" : ""}`
                  : ""),
            );
          }
          refresh();
        }
      } catch {
        // Poll failure is non-critical
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [activeUploadJob, id, refresh]);

  const startEdit = () => {
    if (!kb) return;
    setEditName(kb.name);
    setEditDesc(kb.description);
    setEditScopes([...kb.scopes]);
    setEditChunkSize(kb.chunk_size);
    setEditChunkOverlap(kb.chunk_overlap);
    setEditMaxChunks(kb.max_chunks_per_query);
    setEditMinScore(kb.min_similarity_score);
    setEditing(true);
  };

  const handleSave = async () => {
    if (!kb) return;
    setSaving(true);
    setError("");
    try {
      await updateKB(kb.kb_id, {
        name: editName,
        description: editDesc,
        scopes: editScopes,
        chunk_size: editChunkSize,
        chunk_overlap: editChunkOverlap,
        max_chunks_per_query: editMaxChunks,
        min_similarity_score: editMinScore,
      });
      setEditing(false);
      await refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async () => {
    if (!kb) return;
    try {
      await updateKB(kb.kb_id, { enabled: !kb.enabled });
      await refresh();
    } catch (err: any) {
      setError(err.message);
    }
  };

  // Close upload menu on outside click
  useEffect(() => {
    if (!uploadMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (uploadMenuRef.current && !uploadMenuRef.current.contains(e.target as Node)) {
        setUploadMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [uploadMenuOpen]);

  const ingestFileList = async (files: File[]) => {
    if (files.length === 0 || !kb) return;
    setUploadMenuOpen(false);
    setIngesting(true);
    setIngestSummary("");
    setError("");

    // Populate all files upfront as "pending"
    const initial: Record<string, FileStatus> = {};
    for (const f of files) {
      const name = f.webkitRelativePath || f.name;
      initial[name] = { state: "pending" };
    }
    setFileStatuses(initial);

    try {
      const { job_id, complete } = await ingestKBFiles(kb.kb_id, files, (event) => {
        switch (event.type) {
          case "job_created":
            // Store the job so polling can take over if stream drops
            setActiveUploadJob({
              job_id: event.job_id,
              kb_id: kb.kb_id,
              status: "processing",
              files: Object.keys(initial).map((name) => ({ name, status: "pending" })),
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
            break;
          case "file_start":
            setFileStatuses((prev) => ({ ...prev, [event.file]: { state: "processing" } }));
            break;
          case "file_done":
            setFileStatuses((prev) => ({
              ...prev,
              [event.file]: { state: "done", chunks: event.chunks },
            }));
            break;
          case "file_skip":
            setFileStatuses((prev) => ({
              ...prev,
              [event.file]: { state: "skipped", reason: event.reason },
            }));
            break;
          case "file_error":
            setFileStatuses((prev) => ({
              ...prev,
              [event.file]: { state: "error", error: event.error },
            }));
            break;
          case "complete":
            setIngestSummary(
              `Done \u2014 ${event.documents_added} doc${event.documents_added !== 1 ? "s" : ""}, ` +
                `${event.chunks_added} chunk${event.chunks_added !== 1 ? "s" : ""}` +
                (event.skipped.length ? `, ${event.skipped.length} skipped` : "") +
                (event.errors.length
                  ? `, ${event.errors.length} error${event.errors.length !== 1 ? "s" : ""}`
                  : ""),
            );
            break;
        }
      });
      // Stream completed normally — clear active job
      if (complete) {
        setActiveUploadJob((prev) => (prev ? { ...prev, status: "completed" } : null));
      } else if (job_id) {
        // Stream ended without complete event (navigated away briefly?)
        // The polling effect will pick this up automatically
      }
      await refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIngesting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (folderInputRef.current) folderInputRef.current.value = "";
    }
  };

  // Keep the ref in sync so useDropZone's onDrop can call ingestFileList
  ingestFileListRef.current = ingestFileList;

  const handleIngest = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    setUploadMenuOpen(false);
    await ingestFileList(Array.from(files));
  };

  const handleSearch = async () => {
    if (!searchQuery.trim() || !kb) return;
    setSearching(true);
    try {
      const { results } = await searchKB(kb.kb_id, searchQuery.trim());
      setSearchResults(results);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSearching(false);
    }
  };

  const handleDeleteDoc = async (docName: string) => {
    if (!kb || !confirm(`Remove "${docName}" from this KB?`)) return;
    try {
      await deleteKBDocument(kb.kb_id, docName);
      setExpandedDoc(null);
      setChunkCache((prev) => {
        const next = { ...prev };
        delete next[docName];
        return next;
      });
      await refresh();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const toggleDocExpand = async (docName: string) => {
    if (expandedDoc === docName) {
      setExpandedDoc(null);
      return;
    }
    setExpandedDoc(docName);
    setChunkPage(0);
    setExpandedChunkId(null);
    if (!chunkCache[docName]) {
      await fetchChunks(docName, 0);
    }
  };

  const fetchChunks = async (docName: string, page: number) => {
    if (!kb) return;
    setChunkLoading(true);
    try {
      const data = await listDocumentChunks(
        kb.kb_id,
        docName,
        page * CHUNKS_PER_PAGE,
        CHUNKS_PER_PAGE,
      );
      setChunkCache((prev) => ({ ...prev, [docName]: data }));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setChunkLoading(false);
    }
  };

  const handleChunkPage = async (docName: string, page: number) => {
    setChunkPage(page);
    setExpandedChunkId(null);
    await fetchChunks(docName, page);
  };

  const toggleScope = (scope: KBScope) => {
    setEditScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  };

  if (loading) return <div style={{ color: "var(--fg2)", padding: 20 }}>Loading...</div>;
  if (!kb) return <div style={{ color: "var(--red)", padding: 20 }}>Knowledge base not found</div>;

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Link to="/knowledge" style={{ color: "var(--fg2)", fontSize: 13, textDecoration: "none" }}>
          &larr; Knowledge Bases
        </Link>
      </div>

      {error && <div style={{ ...css.error, marginBottom: 12 }}>{error}</div>}

      {/* Header */}
      <div
        style={{
          ...css.card,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>{kb.name}</h2>
            <span
              style={{ ...css.badge(kb.enabled ? "#22c55e" : "#6b7280"), cursor: "pointer" }}
              onClick={handleToggle}
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
            <span>chunk: {kb.chunk_size} tokens</span>
            <span>overlap: {kb.chunk_overlap}</span>
            <span>max results: {kb.max_chunks_per_query}</span>
            <span>min score: {kb.min_similarity_score}</span>
          </div>
          {activeUploadJob && activeUploadJob.status === "processing" && (
            <div style={{ marginTop: 8 }}>
              <UploadProgressBadge job={activeUploadJob} />
            </div>
          )}
        </div>
        <button type="button" style={css.btn} onClick={startEdit}>
          Settings
        </button>
      </div>

      {/* Settings editor */}
      {editing && (
        <div style={css.card}>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Edit Settings</h3>
          <div style={css.field}>
            <label style={css.label}>Name</label>
            <input
              style={css.input}
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
            />
          </div>
          <div style={css.field}>
            <label style={css.label}>Description</label>
            <input
              style={css.input}
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
            />
          </div>
          <div style={css.field}>
            <label style={css.label}>Scopes</label>
            <ScopeToggleButtons scopes={editScopes} onToggle={toggleScope} />
          </div>
          <div style={{ ...css.row, marginBottom: 16 }}>
            <div style={{ flex: 1 }}>
              <label style={css.label}>Chunk Size (tokens)</label>
              <input
                style={css.input}
                type="number"
                value={editChunkSize}
                onChange={(e) => setEditChunkSize(Number(e.target.value))}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={css.label}>Chunk Overlap</label>
              <input
                style={css.input}
                type="number"
                value={editChunkOverlap}
                onChange={(e) => setEditChunkOverlap(Number(e.target.value))}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={css.label}>Max Chunks/Query</label>
              <input
                style={css.input}
                type="number"
                value={editMaxChunks}
                onChange={(e) => setEditMaxChunks(Number(e.target.value))}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={css.label}>Min Score</label>
              <input
                style={css.input}
                type="number"
                step="0.05"
                value={editMinScore}
                onChange={(e) => setEditMinScore(Number(e.target.value))}
              />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" style={css.btnPrimary} disabled={saving} onClick={handleSave}>
              {saving ? "Saving..." : "Save"}
            </button>
            <button type="button" style={css.btn} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Upload section */}
      <div style={{ ...css.card, position: "relative" }} {...dropZoneProps}>
        {isDragging && <DropOverlay message="Drop files to upload" />}
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Upload</h3>
        <p style={{ fontSize: 13, color: "var(--fg2)", marginBottom: 12 }}>
          Text files, PDFs, archives (.zip, .tar.gz), or entire folders. Drag &amp; drop or use the
          button below. Archives and folders are auto-expanded and the directory hierarchy is
          preserved.
        </p>

        {/* Hidden file inputs */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleIngest}
          disabled={ingesting}
          style={{ display: "none" }}
        />
        <input
          ref={folderInputRef}
          type="file"
          /* @ts-expect-error webkitdirectory is non-standard but widely supported */
          webkitdirectory=""
          onChange={handleIngest}
          disabled={ingesting}
          style={{ display: "none" }}
        />

        <UploadDropdown
          menuRef={uploadMenuRef}
          open={uploadMenuOpen}
          onToggle={() => setUploadMenuOpen((v) => !v)}
          disabled={ingesting}
          onSelectFiles={() => fileInputRef.current?.click()}
          onSelectFolder={() => folderInputRef.current?.click()}
        />

        {/* Real-time per-file progress */}
        {Object.keys(fileStatuses).length > 0 && (
          <div
            style={{
              marginTop: 12,
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              maxHeight: 280,
              overflowY: "auto",
              fontSize: 12,
              fontFamily: "monospace",
              background: "var(--bg)",
            }}
          >
            {Object.entries(fileStatuses).map(([name, status]) => (
              <FileStatusRow key={name} name={name} status={status} />
            ))}
            {ingestSummary && (
              <div style={{ padding: "5px 10px", color: "var(--green)", fontWeight: 600 }}>
                {ingestSummary}
              </div>
            )}
          </div>
        )}
      </div>

      {/* FTS Keyword Index Status */}
      {kb && <FtsStatus kbId={kb.kb_id} />}

      {/* RAPTOR Index Status */}
      {kb && <RaptorStatus kbId={kb.kb_id} />}
      {kb && <RaptorTree kbId={kb.kb_id} />}

      {/* Documents list */}
      <div style={css.card}>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
          Documents ({documents.length})
        </h3>
        {documents.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--fg2)" }}>No documents ingested yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ ...css.table, minWidth: 600 }}>
              <thead>
                <tr>
                  <th style={{ ...css.th, width: "5%" }} />
                  <th style={{ ...css.th, width: "35%" }}>Name</th>
                  <th style={{ ...css.th, width: "15%" }}>Size</th>
                  <th style={{ ...css.th, width: "15%" }}>Chunks</th>
                  <th style={{ ...css.th, width: "20%" }}>Ingested</th>
                  <th style={{ ...css.th, width: "10%" }} />
                </tr>
              </thead>
              <tbody>
                {documents.map((doc) => {
                  const isExpanded = expandedDoc === doc.name;
                  const cached = chunkCache[doc.name];
                  const totalPages = cached ? Math.ceil(cached.total / CHUNKS_PER_PAGE) : 0;
                  return (
                    <Fragment key={doc.name}>
                      <tr style={{ cursor: "pointer" }} onClick={() => toggleDocExpand(doc.name)}>
                        <td
                          style={{
                            ...css.td,
                            fontSize: 14,
                            textAlign: "center",
                            userSelect: "none",
                          }}
                        >
                          {isExpanded ? "▼" : "▶"}
                        </td>
                        <td style={{ ...css.td, fontFamily: "monospace", fontSize: 12 }}>
                          {doc.name}
                        </td>
                        <td style={css.td}>{formatBytes(doc.size_bytes)}</td>
                        <td style={css.td}>{doc.chunk_count}</td>
                        <td style={css.td}>{new Date(doc.ingested_at).toLocaleDateString()}</td>
                        <td style={css.td}>
                          <button
                            type="button"
                            style={{
                              ...css.btnSmall,
                              color: "var(--red)",
                              borderColor: "var(--red)",
                            }}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteDoc(doc.name);
                            }}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr key={`${doc.name}-chunks`}>
                          <td colSpan={6} style={{ padding: 0, border: "none" }}>
                            <div
                              style={{
                                background: "var(--bg)",
                                borderTop: "1px solid var(--border)",
                                padding: "12px 16px 12px 40px",
                              }}
                            >
                              {chunkLoading && !cached ? (
                                <div style={{ fontSize: 13, color: "var(--fg2)" }}>
                                  Loading chunks...
                                </div>
                              ) : cached && cached.chunks.length === 0 ? (
                                <div style={{ fontSize: 13, color: "var(--fg2)" }}>
                                  No chunks found.
                                </div>
                              ) : cached ? (
                                <>
                                  <div
                                    style={{
                                      display: "flex",
                                      justifyContent: "space-between",
                                      alignItems: "center",
                                      marginBottom: 10,
                                    }}
                                  >
                                    <span style={{ fontSize: 12, color: "var(--fg2)" }}>
                                      {cached.total} chunk{cached.total !== 1 ? "s" : ""}
                                      {totalPages > 1 &&
                                        ` · page ${chunkPage + 1} of ${totalPages}`}
                                    </span>
                                    {totalPages > 1 && (
                                      <div style={{ display: "flex", gap: 4 }}>
                                        <button
                                          type="button"
                                          style={css.btnSmall}
                                          disabled={chunkPage === 0 || chunkLoading}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleChunkPage(doc.name, chunkPage - 1);
                                          }}
                                        >
                                          ← Prev
                                        </button>
                                        <button
                                          type="button"
                                          style={css.btnSmall}
                                          disabled={chunkPage >= totalPages - 1 || chunkLoading}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleChunkPage(doc.name, chunkPage + 1);
                                          }}
                                        >
                                          Next →
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                    {cached.chunks.map((chunk, idx) => {
                                      const chunkNum = chunkPage * CHUNKS_PER_PAGE + idx + 1;
                                      const isChunkExpanded = expandedChunkId === chunk.id;
                                      const preview =
                                        chunk.content.length > 300 && !isChunkExpanded
                                          ? chunk.content.slice(0, 300)
                                          : chunk.content;
                                      return (
                                        <div
                                          key={chunk.id}
                                          style={{
                                            border: "1px solid var(--border)",
                                            borderRadius: "var(--radius)",
                                            padding: "8px 12px",
                                            background: "var(--bg2)",
                                          }}
                                        >
                                          <div
                                            style={{
                                              display: "flex",
                                              justifyContent: "space-between",
                                              alignItems: "center",
                                              marginBottom: 4,
                                            }}
                                          >
                                            <div
                                              style={{
                                                display: "flex",
                                                gap: 8,
                                                alignItems: "center",
                                              }}
                                            >
                                              <span
                                                style={{
                                                  fontSize: 11,
                                                  fontWeight: 600,
                                                  color: "var(--fg2)",
                                                }}
                                              >
                                                #{chunkNum}
                                              </span>
                                              {chunk.section && (
                                                <span
                                                  style={{
                                                    fontSize: 11,
                                                    color: "var(--accent)",
                                                    fontFamily: "monospace",
                                                  }}
                                                >
                                                  {chunk.section}
                                                </span>
                                              )}
                                              {chunk.page > 0 && (
                                                <span style={{ fontSize: 11, color: "var(--fg2)" }}>
                                                  p.{chunk.page}
                                                </span>
                                              )}
                                            </div>
                                          </div>
                                          <pre
                                            style={{
                                              fontSize: 12,
                                              lineHeight: 1.5,
                                              whiteSpace: "pre-wrap",
                                              wordBreak: "break-word",
                                              margin: 0,
                                              fontFamily: "monospace",
                                              color: "var(--fg)",
                                            }}
                                          >
                                            {preview}
                                            {!isChunkExpanded && chunk.content.length > 300
                                              ? "..."
                                              : ""}
                                          </pre>
                                          {chunk.content.length > 300 && (
                                            <button
                                              type="button"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                setExpandedChunkId(
                                                  isChunkExpanded ? null : chunk.id,
                                                );
                                              }}
                                              style={{
                                                background: "none",
                                                border: "none",
                                                color: "var(--accent)",
                                                cursor: "pointer",
                                                fontSize: 11,
                                                padding: "4px 0 0",
                                              }}
                                            >
                                              {isChunkExpanded ? "Show less" : "Show full"}
                                            </button>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                  {totalPages > 1 && (
                                    <div
                                      style={{
                                        display: "flex",
                                        justifyContent: "center",
                                        gap: 4,
                                        marginTop: 10,
                                      }}
                                    >
                                      <button
                                        type="button"
                                        style={css.btnSmall}
                                        disabled={chunkPage === 0 || chunkLoading}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleChunkPage(doc.name, chunkPage - 1);
                                        }}
                                      >
                                        ← Prev
                                      </button>
                                      <button
                                        type="button"
                                        style={css.btnSmall}
                                        disabled={chunkPage >= totalPages - 1 || chunkLoading}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleChunkPage(doc.name, chunkPage + 1);
                                        }}
                                      >
                                        Next →
                                      </button>
                                    </div>
                                  )}
                                </>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Search */}
      <div style={css.card}>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Test Search</h3>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <input
            style={{ ...css.input, flex: 1 }}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Enter a search query..."
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          />
          <button type="button" style={css.btnPrimary} disabled={searching} onClick={handleSearch}>
            {searching ? "..." : "Search"}
          </button>
        </div>
        {searchResults.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {searchResults.map((r, i) => (
              <SearchResultCard key={i} result={r} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
