import type { KBScope } from "../../api.js";
import { css } from "../../styles/theme.js";

export const SCOPE_COLORS: Record<string, string> = {
  all: "#a855f7",
  chat: "#3b82f6",
  create_job: "#22c55e",
  plan_job: "#eab308",
  agent_task: "#f97316",
};

export const ALL_SCOPES: KBScope[] = ["chat", "create_job", "plan_job", "agent_task", "all"];

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
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
