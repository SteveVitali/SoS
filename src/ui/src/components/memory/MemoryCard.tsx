import { useState } from "react";
import type { MemoryNote, MemorySearchResult } from "../../api.js";
import { editMemoryNote, invalidateMemoryNote } from "../../api.js";
import { css } from "../../styles/theme.js";
import { MEMORY_TYPE_COLORS, MEMORY_TYPE_LABELS, relTime, SOURCE_ICONS } from "./memoryShared.js";
import { ScoreBreakdown } from "./ScoreBreakdown.js";

function ImportanceBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value * 100));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <div
        style={{
          width: 50,
          height: 5,
          background: "var(--bg)",
          borderRadius: 3,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: pct > 70 ? "#eab308" : pct > 40 ? "#3b82f6" : "var(--fg3)",
            borderRadius: 3,
          }}
        />
      </div>
      <span style={{ fontSize: 10, color: "var(--fg3)", fontFamily: "monospace" }}>
        {value.toFixed(1)}
      </span>
    </div>
  );
}

interface MemoryCardProps {
  memory: MemoryNote;
  searchResult?: MemorySearchResult;
  onNavigateMemory?: (id: string) => void;
  onNavigateEpisode?: (id: string) => void;
  onRefresh?: () => void;
}

export function MemoryCard({
  memory,
  searchResult,
  onNavigateMemory,
  onNavigateEpisode,
  onRefresh,
}: MemoryCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(memory.content);
  const [editImportance, setEditImportance] = useState(String(memory.importance));
  const [editTags, setEditTags] = useState(memory.tags.join(", "));
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const typeColor = MEMORY_TYPE_COLORS[memory.memory_type] || "#6b7280";
  const typeLabel = MEMORY_TYPE_LABELS[memory.memory_type] || memory.memory_type;
  const sourceIcon = SOURCE_ICONS[memory.source_type] || "❓";
  const isInvalidated = !!memory.invalidated_at;

  async function handleSave() {
    setSaving(true);
    try {
      await editMemoryNote(memory.memory_id, {
        content: editContent,
        importance: Number.parseFloat(editImportance),
        tags: editTags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      setEditing(false);
      onRefresh?.();
    } catch {
      // keep editing open
    } finally {
      setSaving(false);
    }
  }

  async function handleInvalidate() {
    try {
      await invalidateMemoryNote(memory.memory_id);
      setConfirmDelete(false);
      onRefresh?.();
    } catch {
      // ignore
    }
  }

  return (
    <div
      style={{
        ...css.card,
        opacity: isInvalidated ? 0.5 : 1,
        borderLeft: `3px solid ${typeColor}`,
        cursor: "pointer",
      }}
      onClick={() => !editing && setExpanded(!expanded)}
      onKeyDown={(e) => e.key === "Enter" && !editing && setExpanded(!expanded)}
    >
      {/* Header row */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={css.badge(typeColor)}>{typeLabel}</span>
          {isInvalidated && <span style={css.badge("#ef4444")}>INVALIDATED</span>}
          <span style={{ fontSize: 11, color: "var(--fg3)" }}>
            {sourceIcon} {memory.source_type}
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              color: "var(--fg3)",
            }}
          >
            <span>imp:</span>
            <ImportanceBar value={memory.importance} />
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              color: "var(--fg3)",
            }}
          >
            <span>conf:</span>
            <ImportanceBar value={memory.confidence} />
          </div>
        </div>
      </div>

      {/* Content */}
      <div style={{ fontSize: 14, color: "var(--fg)", lineHeight: 1.5, marginBottom: 8 }}>
        {memory.content}
      </div>

      {/* Tags */}
      {memory.tags.length > 0 && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
          {memory.tags
            .filter((t) => !t.startsWith("__"))
            .map((tag) => (
              <span
                key={tag}
                style={{
                  fontSize: 10,
                  padding: "1px 6px",
                  borderRadius: 4,
                  background: "var(--bg3)",
                  color: "var(--fg2)",
                }}
              >
                {tag}
              </span>
            ))}
        </div>
      )}

      {/* Meta line */}
      <div
        style={{ fontSize: 11, color: "var(--fg3)", display: "flex", gap: 12, flexWrap: "wrap" }}
      >
        <span>Learned {relTime(memory.created_at)}</span>
        <span>accessed {memory.access_count}x</span>
        <span>
          from {memory.source_episodes.length} episode
          {memory.source_episodes.length !== 1 ? "s" : ""}
        </span>
        {memory.linked_memory_ids.length > 0 && (
          <span>
            {memory.linked_memory_ids.length} link{memory.linked_memory_ids.length !== 1 ? "s" : ""}
          </span>
        )}
        {memory.memory_type === "reflection" && (
          <span>from {memory.source_episodes.length} interactions</span>
        )}
      </div>

      {/* Search score breakdown */}
      {searchResult && expanded && (
        <div style={{ marginTop: 10 }}>
          <ScoreBreakdown
            similarity={searchResult.similarity_score}
            recency={searchResult.recency_score}
            importance={searchResult.importance_score}
            access={searchResult.access_score}
            composite={searchResult.score}
          />
        </div>
      )}

      {/* Expanded detail */}
      {expanded && !editing && (
        <div
          style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {/* Context */}
          {memory.context && (
            <div style={{ ...css.section }}>
              <div style={css.sectionTitle}>Context</div>
              <div style={{ fontSize: 13, color: "var(--fg2)" }}>{memory.context}</div>
            </div>
          )}

          {/* Keywords */}
          {memory.keywords.length > 0 && (
            <div style={{ ...css.section }}>
              <div style={css.sectionTitle}>Keywords</div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {memory.keywords.map((kw) => (
                  <span key={kw} style={{ ...css.badge("#6b7280") }}>
                    {kw}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Temporal */}
          <div style={{ ...css.section }}>
            <div style={css.sectionTitle}>Temporal</div>
            <div
              style={{
                fontSize: 12,
                color: "var(--fg2)",
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              <span>Valid from: {new Date(memory.valid_from).toLocaleString()}</span>
              {memory.invalidated_at && (
                <span style={{ color: "var(--red)" }}>
                  Invalidated: {new Date(memory.invalidated_at).toLocaleString()}
                </span>
              )}
              {memory.invalidated_by && (
                <span>
                  Replaced by:{" "}
                  <button
                    type="button"
                    style={{
                      ...css.link,
                      background: "none",
                      border: "none",
                      padding: 0,
                      fontSize: 12,
                    }}
                    onClick={() => onNavigateMemory?.(memory.invalidated_by!)}
                  >
                    {memory.invalidated_by.slice(0, 8)}…
                  </button>
                </span>
              )}
            </div>
          </div>

          {/* Linked memories */}
          {memory.linked_memory_ids.length > 0 && (
            <div style={{ ...css.section }}>
              <div style={css.sectionTitle}>
                Linked Memories ({memory.linked_memory_ids.length})
              </div>
              {memory.linked_memory_ids.map((id, i) => (
                <div
                  key={id}
                  style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}
                >
                  <button
                    type="button"
                    style={{
                      ...css.link,
                      background: "none",
                      border: "none",
                      padding: 0,
                      fontSize: 12,
                    }}
                    onClick={() => onNavigateMemory?.(id)}
                  >
                    {id.slice(0, 8)}…
                  </button>
                  {memory.link_reasons[i] && (
                    <span style={{ fontSize: 11, color: "var(--fg3)" }}>
                      — {memory.link_reasons[i]}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Source episodes */}
          {memory.source_episodes.length > 0 && (
            <div style={{ ...css.section }}>
              <div style={css.sectionTitle}>Source Episodes ({memory.source_episodes.length})</div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {memory.source_episodes.map((epId) => (
                  <button
                    key={epId}
                    type="button"
                    style={{ ...css.btnSmall, cursor: "pointer" }}
                    onClick={() => onNavigateEpisode?.(epId)}
                  >
                    {epId.slice(0, 8)}…
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Embedding text (collapsible) */}
          <details style={{ marginTop: 4 }}>
            <summary style={{ fontSize: 11, color: "var(--fg3)", cursor: "pointer" }}>
              Embedding text
            </summary>
            <pre style={{ ...css.pre, marginTop: 4, fontSize: 11 }}>{memory.embedding_text}</pre>
          </details>

          {/* Actions */}
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              type="button"
              style={css.btnSmall}
              onClick={() => {
                setEditing(true);
                setExpanded(true);
              }}
            >
              ✏️ Edit
            </button>
            {!isInvalidated && (
              <button
                type="button"
                style={{ ...css.btnSmall, color: "var(--red)" }}
                onClick={() => setConfirmDelete(true)}
              >
                🗑️ Invalidate
              </button>
            )}
          </div>

          {confirmDelete && (
            <div
              style={{
                marginTop: 8,
                padding: 10,
                background: "var(--bg)",
                borderRadius: 6,
                border: "1px solid var(--red)",
              }}
            >
              <div style={{ fontSize: 12, color: "var(--fg2)", marginBottom: 8 }}>
                This memory will be soft-deleted. It won't appear in search or context injection.
                Continue?
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" style={css.btnDanger} onClick={handleInvalidate}>
                  Confirm
                </button>
                <button type="button" style={css.btnSmall} onClick={() => setConfirmDelete(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Edit mode */}
      {editing && (
        <div
          style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <div style={css.field}>
            <label style={css.label}>Content</label>
            <textarea
              style={css.textarea}
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
            />
          </div>
          <div style={{ ...css.row, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={css.label}>Importance (0.0–1.0)</label>
              <input
                type="number"
                step="0.1"
                min="0"
                max="1"
                style={{ ...css.input, width: 100 }}
                value={editImportance}
                onChange={(e) => setEditImportance(e.target.value)}
              />
            </div>
            <div style={{ flex: 2 }}>
              <label style={css.label}>Tags (comma-separated)</label>
              <input
                style={css.input}
                value={editTags}
                onChange={(e) => setEditTags(e.target.value)}
              />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" style={css.btnPrimary} onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button type="button" style={css.btnSmall} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
