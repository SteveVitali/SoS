import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  createKB,
  deleteKB,
  type KBScope,
  type KnowledgeBase,
  listKBs,
  updateKB,
} from "../../api.js";
import { css } from "../../styles/theme.js";
import { PageHeader } from "../shared/PageHeader.js";
import { KBPlayground } from "./KBPlayground.js";
import { formatBytes, ScopeBadge, ScopeToggleButtons } from "./kbShared.js";
import { ResearchHistory } from "./ResearchHistory.js";
import { ResearchPlayground } from "./ResearchPlayground.js";
import { StrategyComparison } from "./StrategyComparison.js";

export function KBList() {
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newScopes, setNewScopes] = useState<KBScope[]>(["chat"]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const { kbs: data } = await listKBs();
      setKbs(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setError("");
    try {
      await createKB({
        name: newName.trim(),
        description: newDesc.trim(),
        scopes: newScopes,
      });
      setNewName("");
      setNewDesc("");
      setNewScopes(["chat"]);
      setShowCreate(false);
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
          <button
            type="button"
            style={css.btnPrimary}
            disabled={creating || !newName.trim()}
            onClick={handleCreate}
          >
            {creating ? "Creating..." : "Create Knowledge Base"}
          </button>
        </div>
      )}

      <KBPlayground />
      <ResearchPlayground />
      <StrategyComparison />
      <ResearchHistory />

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
