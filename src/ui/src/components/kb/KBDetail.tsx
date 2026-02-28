import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  deleteKBDocument,
  getKB,
  ingestKBFiles,
  type KBDocument,
  type KBScope,
  type KBSearchResult,
  type KnowledgeBase,
  searchKB,
  updateKB,
} from "../../api.js";
import { css } from "../../styles/theme.js";
import { formatBytes, ScopeBadge, ScopeToggleButtons } from "./kbShared.js";

export function KBDetail() {
  const { id } = useParams<{ id: string }>();
  const [kb, setKb] = useState<KnowledgeBase | null>(null);
  const [documents, setDocuments] = useState<KBDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [ingesting, setIngesting] = useState(false);
  const [ingestResult, setIngestResult] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const handleIngest = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !kb) return;
    setIngesting(true);
    setIngestResult("");
    setError("");
    try {
      const result = await ingestKBFiles(kb.kb_id, Array.from(files));
      setIngestResult(
        `Added ${result.documents_added} docs, ${result.chunks_added} chunks` +
          (result.skipped.length ? `. Skipped: ${result.skipped.length}` : "") +
          (result.errors.length ? `. Errors: ${result.errors.length}` : ""),
      );
      await refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIngesting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
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
      await refresh();
    } catch (err: any) {
      setError(err.message);
    }
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
      <div style={css.card}>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Upload Files</h3>
        <p style={{ fontSize: 13, color: "var(--fg2)", marginBottom: 12 }}>
          Upload text files, PDFs, or archives (.zip, .tar.gz). Archives are auto-extracted.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleIngest}
            disabled={ingesting}
            style={{ fontSize: 13 }}
          />
          {ingesting && <span style={{ fontSize: 13, color: "var(--fg2)" }}>Ingesting...</span>}
        </div>
        {ingestResult && (
          <div style={{ marginTop: 8, fontSize: 13, color: "var(--green)" }}>{ingestResult}</div>
        )}
      </div>

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
                  <th style={{ ...css.th, width: "40%" }}>Name</th>
                  <th style={{ ...css.th, width: "15%" }}>Size</th>
                  <th style={{ ...css.th, width: "15%" }}>Chunks</th>
                  <th style={{ ...css.th, width: "20%" }}>Ingested</th>
                  <th style={{ ...css.th, width: "10%" }} />
                </tr>
              </thead>
              <tbody>
                {documents.map((doc) => (
                  <tr key={doc.name}>
                    <td style={{ ...css.td, fontFamily: "monospace", fontSize: 12 }}>{doc.name}</td>
                    <td style={css.td}>{formatBytes(doc.size_bytes)}</td>
                    <td style={css.td}>{doc.chunk_count}</td>
                    <td style={css.td}>{new Date(doc.ingested_at).toLocaleDateString()}</td>
                    <td style={css.td}>
                      <button
                        type="button"
                        style={{ ...css.btnSmall, color: "var(--red)", borderColor: "var(--red)" }}
                        onClick={() => handleDeleteDoc(doc.name)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
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
              <div
                key={i}
                style={{
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  padding: 12,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 12, color: "var(--fg2)", fontFamily: "monospace" }}>
                    {r.source_file}
                    {r.metadata.section ? ` > ${r.metadata.section}` : ""}
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--accent)" }}>
                    {(r.score * 100).toFixed(1)}%
                  </span>
                </div>
                <div style={{ fontSize: 13, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                  {r.content.slice(0, 500)}
                  {r.content.length > 500 ? "..." : ""}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
