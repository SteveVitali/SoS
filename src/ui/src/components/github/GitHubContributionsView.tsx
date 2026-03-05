/**
 * GitHubContributionsView — summary cards, chart, and leaderboard.
 */

import { useCallback, useEffect, useState } from "react";
import { type ContributionsResponse, type GitHubScope, getGitHubContributions } from "../../api.js";
import { css } from "../../styles/theme.js";
import { ScopeToggle } from "./ScopeToggle.js";

const RANGE_OPTIONS = [
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
  { key: "1y", label: "1 year" },
] as const;

export function GitHubContributionsView() {
  const [scope, setScope] = useState<GitHubScope>("team");
  const [range, setRange] = useState("30d");
  const [data, setData] = useState<ContributionsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await getGitHubContributions({ scope, range, group_by: "week" });
      setData(res);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [scope, range]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const summary = data?.summary;

  return (
    <div>
      {/* Filters */}
      <div style={{ ...css.filters, justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <ScopeToggle value={scope} onChange={setScope} />
          <div style={{ display: "inline-flex", gap: 4 }}>
            {RANGE_OPTIONS.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => setRange(r.key)}
                style={{
                  ...css.btnSmall,
                  background: range === r.key ? "var(--accent)" : "var(--bg3)",
                  color: range === r.key ? "#fff" : "var(--fg2)",
                  fontWeight: range === r.key ? 600 : 400,
                }}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <button type="button" onClick={refresh} style={css.btnSmall} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && <div style={css.error}>{error}</div>}

      {/* Summary Cards */}
      {summary && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: 12,
            marginBottom: 20,
          }}
        >
          <StatCard label="PRs Opened" value={summary.prs_opened} color="#3b82f6" />
          <StatCard label="PRs Merged" value={summary.prs_merged} color="#a855f7" />
          <StatCard label="Reviews" value={summary.reviews_submitted} color="#22c55e" />
          <StatCard label="Additions" value={summary.additions} color="#22c55e" />
          <StatCard label="Deletions" value={summary.deletions} color="#ef4444" />
          <StatCard label="Repos" value={summary.repos_touched?.length || 0} color="#eab308" />
        </div>
      )}

      {/* Chart (simple bar visualization) */}
      {data?.data_points && data.data_points.length > 0 && (
        <div style={css.card}>
          <div style={css.sectionTitle}>Activity Over Time</div>
          <div
            style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 120, marginTop: 12 }}
          >
            {data.data_points.map((dp) => {
              const maxVal = Math.max(
                ...data.data_points.map((d) => d.prs_merged + d.reviews_submitted),
                1,
              );
              const val = dp.prs_merged + dp.reviews_submitted;
              const height = Math.max(2, (val / maxVal) * 100);
              return (
                <div
                  key={dp.period}
                  title={`${dp.period}: ${dp.prs_merged} merged, ${dp.reviews_submitted} reviews`}
                  style={{
                    flex: 1,
                    height: `${height}%`,
                    background: "var(--accent)",
                    borderRadius: "3px 3px 0 0",
                    minWidth: 6,
                    opacity: 0.8,
                    position: "relative",
                  }}
                >
                  {dp.reviews_submitted > 0 && (
                    <div
                      style={{
                        position: "absolute",
                        bottom: 0,
                        left: 0,
                        right: 0,
                        height: `${Math.max(2, (dp.reviews_submitted / (dp.prs_merged + dp.reviews_submitted)) * 100)}%`,
                        background: "#22c55e",
                        borderRadius: "0 0 3px 3px",
                        opacity: 0.7,
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
            <span style={{ fontSize: 10, color: "var(--fg3)" }}>{data.data_points[0]?.period}</span>
            <div style={{ display: "flex", gap: 12, fontSize: 10, color: "var(--fg3)" }}>
              <span>■ Merged</span>
              <span style={{ color: "#22c55e" }}>■ Reviews</span>
            </div>
            <span style={{ fontSize: 10, color: "var(--fg3)" }}>
              {data.data_points[data.data_points.length - 1]?.period}
            </span>
          </div>
        </div>
      )}

      {/* Leaderboard */}
      {data?.leaderboard && data.leaderboard.length > 0 && (
        <div style={css.card}>
          <div style={css.sectionTitle}>Leaderboard</div>
          <table style={{ ...css.table, minWidth: 600 }}>
            <thead>
              <tr>
                <th style={{ ...css.th, width: "5%" }}>#</th>
                <th style={{ ...css.th, width: "25%" }}>Author</th>
                <th style={{ ...css.th, width: "15%" }}>PRs Merged</th>
                <th style={{ ...css.th, width: "15%" }}>Reviews</th>
                <th style={{ ...css.th, width: "15%" }}>Additions</th>
                <th style={{ ...css.th, width: "15%" }}>Deletions</th>
                <th style={{ ...css.th, width: "10%" }}>Repos</th>
              </tr>
            </thead>
            <tbody>
              {data.leaderboard.map((entry, idx) => (
                <tr key={entry.login}>
                  <td style={css.td}>
                    <span
                      style={{ fontWeight: 600, color: idx < 3 ? "var(--accent)" : "var(--fg3)" }}
                    >
                      {idx + 1}
                    </span>
                  </td>
                  <td style={css.td}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {entry.avatar_url && (
                        <img
                          src={entry.avatar_url}
                          alt=""
                          style={{ width: 20, height: 20, borderRadius: "50%" }}
                        />
                      )}
                      <span style={{ fontWeight: 500 }}>{entry.name || entry.login}</span>
                    </div>
                  </td>
                  <td style={css.td}>{entry.prs_merged}</td>
                  <td style={css.td}>{entry.reviews_submitted}</td>
                  <td style={{ ...css.td, color: "#22c55e" }}>+{entry.additions}</td>
                  <td style={{ ...css.td, color: "#ef4444" }}>−{entry.deletions}</td>
                  <td style={css.td}>{entry.repos_touched?.length || 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && !data?.leaderboard?.length && !data?.data_points?.length && !error && (
        <div style={{ textAlign: "center", padding: 40, color: "var(--fg3)" }}>
          No contribution data available yet. Sync must complete first.
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div
      style={{
        ...css.card,
        padding: 16,
        marginBottom: 0,
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 24, fontWeight: 700, color }}>{formatNum(value)}</div>
      <div style={{ fontSize: 12, color: "var(--fg3)", marginTop: 4 }}>{label}</div>
    </div>
  );
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
