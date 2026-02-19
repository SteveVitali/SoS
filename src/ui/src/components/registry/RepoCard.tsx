import { useState } from "react";
import type { RepoConfig } from "../../api.js";
import { css } from "../../styles/theme.js";
import { CommandEditor } from "./CommandEditor.js";

interface RepoCardProps {
  id: string;
  repo: RepoConfig;
  expanded: boolean;
  onToggle: () => void;
  onChange: (r: RepoConfig) => void;
  onChangeId: (oldId: string, newId: string) => void;
  onDelete: () => void;
}

const SECTION_HEADING: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 8,
  marginTop: 12,
  color: "var(--fg2)",
};

export function RepoCard({
  id,
  repo,
  expanded,
  onToggle,
  onChange,
  onChangeId,
  onDelete,
}: RepoCardProps) {
  const [editingId, setEditingId] = useState(false);
  const [newId, setNewId] = useState(id);

  const update = (partial: Partial<RepoConfig>) => onChange({ ...repo, ...partial });

  const cloneDisplay = repo.clone
    ? repo.clone.replace(/^git@github\.com:/, "").replace(/\.git$/, "")
    : "not configured";

  return (
    <div
      style={{
        ...css.card,
        marginBottom: 12,
        border: expanded ? "1px solid var(--accent)" : "1px solid var(--border)",
      }}
    >
      {/* Header row */}
      <div
        style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}
        onClick={onToggle}
      >
        <span style={{ fontSize: 12, color: "var(--fg3)", userSelect: "none", width: 16 }}>
          {expanded ? "\u25BC" : "\u25B6"}
        </span>
        <span style={{ fontWeight: 600, fontSize: 15, flex: 1 }}>{id}</span>
        <span style={{ ...css.mono, fontSize: 12, color: "var(--fg3)" }}>{cloneDisplay}</span>
        <span
          style={{
            ...css.badge(repo.max_worktrees && repo.max_worktrees > 1 ? "#3b82f6" : "#6b7280"),
            fontSize: 10,
          }}
        >
          {repo.max_worktrees || 1} worktree{(repo.max_worktrees || 1) > 1 ? "s" : ""}
        </span>
        <span style={{ ...css.badge("#6b7280"), fontSize: 10 }}>{repo.clean_mode || "light"}</span>
        {repo.ci?.provider && (
          <span style={{ ...css.badge("#8b5cf6"), fontSize: 10 }}>{repo.ci.provider}</span>
        )}
      </div>

      {expanded && (
        <div style={{ marginTop: 16 }}>
          {/* Identity */}
          <div style={SECTION_HEADING}>Identity</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div style={css.field}>
              <label style={css.label}>Repo ID</label>
              {editingId ? (
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    style={{ ...css.input, flex: 1 }}
                    value={newId}
                    onChange={(e) => setNewId(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newId && newId !== id) {
                        onChangeId(id, newId);
                        setEditingId(false);
                      } else if (e.key === "Escape") {
                        setNewId(id);
                        setEditingId(false);
                      }
                    }}
                  />
                  <button
                    style={css.btnSmall}
                    onClick={() => {
                      if (newId && newId !== id) onChangeId(id, newId);
                      setEditingId(false);
                    }}
                  >
                    OK
                  </button>
                </div>
              ) : (
                <div
                  style={{
                    ...css.input,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingId(true);
                  }}
                >
                  <span style={css.mono}>{id}</span>
                  <span style={{ fontSize: 11, color: "var(--fg3)" }}>click to edit</span>
                </div>
              )}
            </div>
            <div style={css.field}>
              <label style={css.label}>Clone URL</label>
              <input
                style={css.input}
                value={repo.clone || ""}
                onChange={(e) => update({ clone: e.target.value })}
                placeholder="git@github.com:org/repo.git"
              />
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <div style={css.field}>
              <label style={css.label}>Default Branch</label>
              <input
                style={css.input}
                value={repo.default_branch || "main"}
                onChange={(e) => update({ default_branch: e.target.value })}
              />
            </div>
            <div style={css.field}>
              <label style={css.label}>Max Worktrees</label>
              <input
                style={css.input}
                type="number"
                min={1}
                max={10}
                value={repo.max_worktrees ?? 1}
                onChange={(e) => update({ max_worktrees: parseInt(e.target.value, 10) || 1 })}
              />
            </div>
            <div style={css.field}>
              <label style={css.label}>Clean Mode</label>
              <select
                style={{ ...css.select, width: "100%" }}
                value={repo.clean_mode || "light"}
                onChange={(e) => update({ clean_mode: e.target.value as "light" | "full" })}
              >
                <option value="light">light (preserve build caches)</option>
                <option value="full">full (clean everything)</option>
              </select>
            </div>
          </div>

          {/* Detection */}
          <div style={SECTION_HEADING}>Detection</div>
          <div style={css.field}>
            <label style={css.label}>Keywords (comma-separated)</label>
            <input
              style={css.input}
              value={(repo.detect?.keywords || []).join(", ")}
              onChange={(e) =>
                update({
                  detect: {
                    keywords: e.target.value
                      .split(",")
                      .map((k) => k.trim())
                      .filter(Boolean),
                  },
                })
              }
              placeholder="e.g. my-app, frontend, react"
            />
          </div>

          {/* Commands */}
          <div style={SECTION_HEADING}>Commands</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <CommandEditor
              label="Lint"
              value={repo.commands?.lint}
              onChange={(v) => update({ commands: { ...repo.commands, lint: v } })}
            />
            <CommandEditor
              label="Test (fast)"
              value={repo.commands?.test_fast}
              onChange={(v) => update({ commands: { ...repo.commands, test_fast: v } })}
            />
            <CommandEditor
              label="Test (full)"
              value={repo.commands?.test_full}
              onChange={(v) => update({ commands: { ...repo.commands, test_full: v } })}
            />
          </div>

          {/* PR & CI */}
          <div style={SECTION_HEADING}>Pull Requests & CI</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <div style={css.field}>
              <label style={css.label}>Default Reviewers (comma-separated)</label>
              <input
                style={css.input}
                value={(repo.pr?.reviewers_default || []).join(", ")}
                onChange={(e) =>
                  update({
                    pr: {
                      ...repo.pr,
                      reviewers_default: e.target.value
                        .split(",")
                        .map((r) => r.trim())
                        .filter(Boolean),
                    },
                  })
                }
                placeholder="alice, bob"
              />
            </div>
            <div style={css.field}>
              <label style={css.label}>Draft by Default</label>
              <select
                style={{ ...css.select, width: "100%" }}
                value={repo.pr?.draft_by_default !== false ? "true" : "false"}
                onChange={(e) =>
                  update({ pr: { ...repo.pr, draft_by_default: e.target.value === "true" } })
                }
              >
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </div>
            <div style={css.field}>
              <label style={css.label}>CI Provider</label>
              <select
                style={{ ...css.select, width: "100%" }}
                value={repo.ci?.provider || ""}
                onChange={(e) => update({ ci: { provider: e.target.value || undefined } })}
              >
                <option value="">None</option>
                <option value="github_actions">GitHub Actions</option>
                <option value="jenkins">Jenkins</option>
              </select>
            </div>
          </div>

          {/* Delete */}
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
            <button
              style={css.btnDanger}
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Delete repo "${id}"?`)) onDelete();
              }}
            >
              Delete Repo
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
