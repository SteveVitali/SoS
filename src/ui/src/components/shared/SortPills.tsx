import { css } from "../../styles/theme.js";

export type SortKey =
  | "task_id"
  | "status"
  | "requested_by"
  | "created_at"
  | "updated"
  | "repo"
  | "worktree_slot"
  | "pr";
export type SortDir = "asc" | "desc";

const SORT_OPTIONS: [SortKey, string][] = [
  ["updated", "Updated"],
  ["created_at", "Created"],
  ["status", "Status"],
  ["requested_by", "User"],
  ["repo", "Repo"],
  ["task_id", "Task"],
  ["pr", "PR"],
];

interface SortPillsProps {
  sortKey: SortKey | null;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
}

export function SortPills({ sortKey, sortDir, onSort }: SortPillsProps) {
  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        marginBottom: 12,
        flexWrap: "wrap",
        alignItems: "center",
      }}
    >
      <span style={{ fontSize: 12, color: "var(--fg3)", marginRight: 4 }}>Sort by:</span>
      {SORT_OPTIONS.map(([key, label]) => (
        <button
          key={key}
          style={{
            ...css.btnSmall,
            background: sortKey === key ? "var(--accent)" : "var(--bg3)",
            color: sortKey === key ? "#fff" : "var(--fg2)",
            border: sortKey === key ? "1px solid var(--accent)" : "1px solid var(--border)",
          }}
          onClick={() => onSort(key)}
        >
          {label} {sortKey === key ? (sortDir === "asc" ? "\u25B2" : "\u25BC") : ""}
        </button>
      ))}
    </div>
  );
}
