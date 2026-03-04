import { useCallback, useState } from "react";
import type { KBScope, KBSearchResult } from "../../api.js";
import { css } from "../../styles/theme.js";

export const SCOPE_COLORS: Record<string, string> = {
  all: "#a855f7",
  chat: "#3b82f6",
  create_job: "#22c55e",
  plan_job: "#eab308",
  agent_task: "#f97316",
};

export const ALL_SCOPES: KBScope[] = ["chat", "create_job", "plan_job", "agent_task", "all"];

export function useToggleScopes(initial: KBScope[] = [...ALL_SCOPES]) {
  const [scopes, setScopes] = useState<KBScope[]>(initial);
  const toggle = useCallback(
    (scope: KBScope) =>
      setScopes((prev) =>
        prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
      ),
    [],
  );
  return { scopes, toggle } as const;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
}

export function sessionStatusColor(status: string): string {
  switch (status) {
    case "completed":
      return "#22c55e";
    case "failed":
      return "#ef4444";
    case "budget_exhausted":
      return "#eab308";
    case "running":
      return "#3b82f6";
    default:
      return "var(--fg2)";
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function ScopeBadge({ scope }: { scope: string }) {
  const color = SCOPE_COLORS[scope] || "#6b7280";
  return <span style={css.badge(color)}>{scope}</span>;
}

export function ScopeToggleButtons({
  scopes,
  onToggle,
}: {
  scopes: KBScope[];
  onToggle: (scope: KBScope) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
      {ALL_SCOPES.map((scope) => (
        <button
          key={scope}
          type="button"
          onClick={() => onToggle(scope)}
          style={{
            ...css.btnSmall,
            background: scopes.includes(scope) ? "var(--accent)" : "var(--bg3)",
            color: scopes.includes(scope) ? "#fff" : "var(--fg2)",
            border: scopes.includes(scope) ? "1px solid var(--accent)" : "1px solid var(--border)",
          }}
        >
          {scope}
        </button>
      ))}
    </div>
  );
}

export function SearchResultCard({
  result,
  showKBName,
}: {
  result: KBSearchResult;
  showKBName?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const truncateAt = 300;
  const needsTruncation = result.content.length > truncateAt;
  const preview =
    needsTruncation && !expanded ? result.content.slice(0, truncateAt) : result.content;

  return (
    <div
      style={{
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 6,
        }}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {showKBName && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: "2px 6px",
                borderRadius: 4,
                background: "var(--accent)22",
                color: "var(--accent)",
              }}
            >
              {result.kb_name}
            </span>
          )}
          <span style={{ fontSize: 12, color: "var(--fg2)", fontFamily: "monospace" }}>
            {result.source_file}
            {result.metadata.section ? ` > ${result.metadata.section}` : ""}
          </span>
        </div>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--accent)" }}>
          {(result.score * 100).toFixed(1)}%
        </span>
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
        {needsTruncation && !expanded ? "..." : ""}
      </pre>
      {needsTruncation && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          style={{
            background: "none",
            border: "none",
            color: "var(--accent)",
            cursor: "pointer",
            fontSize: 11,
            padding: "4px 0 0",
          }}
        >
          {expanded ? "Show less" : "Show full"}
        </button>
      )}
    </div>
  );
}
