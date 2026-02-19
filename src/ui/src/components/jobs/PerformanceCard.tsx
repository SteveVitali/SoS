import type { Job } from "../../api.js";
import { css } from "../../styles/theme.js";
import { formatDuration } from "../../utils/format.js";

const PHASES: Array<{ key: string; label: string; color: string }> = [
  { key: "claude_code_ms", label: "Claude Code", color: "#8b5cf6" },
  { key: "self_review_ms", label: "Self-review", color: "#6366f1" },
  { key: "local_checks_ms", label: "Local checks", color: "#06b6d4" },
  { key: "ci_wait_ms", label: "CI wait", color: "#f59e0b" },
  { key: "ci_fix_ms", label: "CI fix", color: "#ef4444" },
  { key: "commit_push_ms", label: "Git ops", color: "#10b981" },
  { key: "prepare_workspace_ms", label: "Workspace", color: "#64748b" },
];

export function PerformanceCard({ job }: { job: Job }) {
  if (!job.metrics) return null;

  const d = (job.metrics.durations || {}) as Record<string, number>;
  const total = d.total_ms || 0;
  const phases = PHASES.map((p) => ({ ...p, ms: d[p.key] || 0 })).filter((p) => p.ms > 0);

  return (
    <div style={css.card}>
      <div style={css.sectionTitle}>Performance</div>

      {total > 0 && (
        <div style={{ marginBottom: 12, fontSize: 14 }}>
          <b>Total duration:</b> {formatDuration(total)}
        </div>
      )}

      {phases.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div
            style={{
              display: "flex",
              height: 20,
              borderRadius: 6,
              overflow: "hidden",
              marginBottom: 8,
            }}
          >
            {phases.map((p, i) => (
              <div
                key={i}
                title={`${p.label}: ${formatDuration(p.ms)}`}
                style={{
                  width: `${(p.ms / (total || 1)) * 100}%`,
                  background: p.color,
                  minWidth: p.ms > 0 ? 2 : 0,
                }}
              />
            ))}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px", fontSize: 12 }}>
            {phases.map((p, i) => (
              <span key={i}>
                <span
                  style={{
                    display: "inline-block",
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    background: p.color,
                    marginRight: 4,
                  }}
                />
                {p.label}: {formatDuration(p.ms)}
              </span>
            ))}
          </div>
        </div>
      )}

      {job.metrics.claude?.sessions && job.metrics.claude.sessions.length > 0 && (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: "var(--fg2)" }}>
            Claude Usage
          </div>
          <table style={{ ...css.table, fontSize: 12 }}>
            <thead>
              <tr>
                <th style={css.th}>Phase</th>
                <th style={css.th}>Model</th>
                <th style={{ ...css.th, textAlign: "right" }}>Input</th>
                <th style={{ ...css.th, textAlign: "right" }}>Output</th>
                <th style={{ ...css.th, textAlign: "right" }}>Duration</th>
                <th style={{ ...css.th, textAlign: "right" }}>Cost</th>
              </tr>
            </thead>
            <tbody>
              {job.metrics.claude.sessions.map((s, i) => (
                <tr key={i}>
                  <td style={css.td}>{s.phase}</td>
                  <td style={{ ...css.td, ...css.mono }}>
                    {s.model?.replace("claude-", "") || "\u2014"}
                  </td>
                  <td style={{ ...css.td, textAlign: "right" }}>
                    {s.input_tokens ? `${(s.input_tokens / 1000).toFixed(1)}K` : "\u2014"}
                  </td>
                  <td style={{ ...css.td, textAlign: "right" }}>
                    {s.output_tokens ? `${(s.output_tokens / 1000).toFixed(1)}K` : "\u2014"}
                  </td>
                  <td style={{ ...css.td, textAlign: "right" }}>
                    {s.duration_ms ? formatDuration(s.duration_ms) : "\u2014"}
                  </td>
                  <td style={{ ...css.td, textAlign: "right" }}>
                    {s.cost_usd != null ? (
                      <span
                        title={
                          s.cost_source === "computed"
                            ? "Estimated from token counts"
                            : "Direct from provider"
                        }
                      >
                        {s.cost_source === "computed" ? "~" : ""}${s.cost_usd.toFixed(4)}
                      </span>
                    ) : (
                      "\u2014"
                    )}
                  </td>
                </tr>
              ))}
              {job.metrics.claude.sessions.length > 1 && (
                <tr style={{ fontWeight: 600 }}>
                  <td style={css.td}>Total</td>
                  <td style={css.td} />
                  <td style={{ ...css.td, textAlign: "right" }}>
                    {job.metrics.claude.total_input_tokens
                      ? `${(job.metrics.claude.total_input_tokens / 1000).toFixed(1)}K`
                      : ""}
                  </td>
                  <td style={{ ...css.td, textAlign: "right" }}>
                    {job.metrics.claude.total_output_tokens
                      ? `${(job.metrics.claude.total_output_tokens / 1000).toFixed(1)}K`
                      : ""}
                  </td>
                  <td style={css.td} />
                  <td style={{ ...css.td, textAlign: "right" }}>
                    {job.metrics.claude.total_cost_usd != null ? (
                      <span
                        title={
                          job.metrics.claude.cost_source === "computed"
                            ? "Estimated from token counts"
                            : "Direct from provider"
                        }
                      >
                        {job.metrics.claude.cost_source === "computed" ? "~" : ""}$
                        {job.metrics.claude.total_cost_usd.toFixed(4)}
                      </span>
                    ) : (
                      ""
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
