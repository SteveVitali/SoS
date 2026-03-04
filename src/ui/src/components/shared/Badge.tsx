import { css, STATUS_COLORS } from "../../styles/theme.js";

export function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] || "#6b7280";
  return <span style={css.badge(color)}>{status}</span>;
}

const JOB_TYPE_LABELS: Record<string, string> = {
  respond_to_pr_comments: "PR Comments",
  self_review_pr: "Self Review",
  add_pr_review_comments: "Add Review",
};

export function JobTypeBadge({ jobType }: { jobType?: string }) {
  const label = jobType ? JOB_TYPE_LABELS[jobType] : undefined;
  if (!label) return null;
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
      {label}
    </span>
  );
}
