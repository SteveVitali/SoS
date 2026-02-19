import { css, STATUS_COLORS } from "../../styles/theme.js";

export function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] || "#6b7280";
  return <span style={css.badge(color)}>{status}</span>;
}

export function JobTypeBadge({ jobType }: { jobType?: string }) {
  if (jobType !== "respond_to_pr_comments") return null;
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        padding: "2px 6px",
        borderRadius: 4,
        background: "var(--bg2)",
        color: "var(--fg2)",
        textTransform: "uppercase",
        letterSpacing: "0.5px",
        whiteSpace: "nowrap",
      }}
    >
      PR Comments
    </span>
  );
}
