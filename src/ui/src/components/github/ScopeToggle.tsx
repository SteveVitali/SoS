/**
 * ScopeToggle — Me / Team / Org scope selector.
 */

import type { GitHubScope } from "../../api.js";

interface ScopeToggleProps {
  value: GitHubScope;
  onChange: (scope: GitHubScope) => void;
}

const scopes: { key: GitHubScope; label: string }[] = [
  { key: "me", label: "Me" },
  { key: "team", label: "My Team" },
  { key: "org", label: "My Org" },
];

export function ScopeToggle({ value, onChange }: ScopeToggleProps) {
  return (
    <div
      style={{
        display: "inline-flex",
        borderRadius: 6,
        border: "1px solid var(--border)",
        overflow: "hidden",
      }}
    >
      {scopes.map((s) => (
        <button
          key={s.key}
          type="button"
          onClick={() => onChange(s.key)}
          style={{
            padding: "5px 14px",
            border: "none",
            borderRight: s.key !== "org" ? "1px solid var(--border)" : "none",
            background: value === s.key ? "var(--accent)" : "var(--bg2)",
            color: value === s.key ? "#fff" : "var(--fg2)",
            fontSize: 12,
            fontWeight: value === s.key ? 600 : 400,
            cursor: "pointer",
          }}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
