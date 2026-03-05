/**
 * GitHubPrsView — displays PRs from the GitHub Hub sync cache.
 * Supports scope (Me/Team/Org), state filter, and pagination.
 */

import { useCallback, useEffect, useState } from "react";
import {
  type GitHubHubPr,
  type GitHubHubPrsResponse,
  type GitHubScope,
  listGitHubPrs,
} from "../../api.js";
import { css } from "../../styles/theme.js";
import { relativeTime } from "../../utils/format.js";
import { ScopeToggle } from "./ScopeToggle.js";

const STATE_OPTIONS = ["open", "merged", "closed", "all"] as const;
const PAGE_SIZE = 30;

export function GitHubPrsView() {
  const [scope, setScope] = useState<GitHubScope>("team");
  const [state, setState] = useState<string>("open");
  const [data, setData] = useState<GitHubHubPrsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [offset, setOffset] = useState(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await listGitHubPrs({ scope, state, limit: PAGE_SIZE, offset });
      setData(res);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [scope, state, offset]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const prs = data?.prs || [];

  return (
    <div>
      {/* Filters */}
      <div style={{ ...css.filters, justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <ScopeToggle
            value={scope}
            onChange={(s) => {
              setScope(s);
              setOffset(0);
            }}
          />
          <div style={{ display: "inline-flex", gap: 4 }}>
            {STATE_OPTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setState(s);
                  setOffset(0);
                }}
                style={{
                  ...css.btnSmall,
                  background: state === s ? "var(--accent)" : "var(--bg3)",
                  color: state === s ? "#fff" : "var(--fg2)",
                  fontWeight: state === s ? 600 : 400,
                  textTransform: "capitalize",
                }}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {data && (
            <span style={{ fontSize: 12, color: "var(--fg3)" }}>
              {data.total} PRs
              {data.backfill_progress.total > 0 && data.backfill_progress.percentage < 100 && (
                <> · Backfill {data.backfill_progress.percentage}%</>
              )}
            </span>
          )}
          <button type="button" onClick={refresh} style={css.btnSmall} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && <div style={css.error}>{error}</div>}

      {/* Table */}
      <div style={{ overflowX: "auto" }}>
        <table style={{ ...css.table, minWidth: 800 }}>
          <thead>
            <tr>
              <th style={{ ...css.th, width: "35%" }}>Title</th>
              <th style={{ ...css.th, width: "12%" }}>Author</th>
              <th style={{ ...css.th, width: "14%" }}>Repo</th>
              <th style={{ ...css.th, width: "8%" }}>State</th>
              <th style={{ ...css.th, width: "8%" }}>Size</th>
              <th style={{ ...css.th, width: "10%" }}>Reviews</th>
              <th style={{ ...css.th, width: "13%" }}>Updated</th>
            </tr>
          </thead>
          <tbody>
            {prs.length === 0 && !loading && (
              <tr>
                <td colSpan={7} style={{ ...css.td, textAlign: "center", color: "var(--fg3)" }}>
                  No PRs found
                </td>
              </tr>
            )}
            {prs.map((pr) => (
              <PrRow key={pr._id} pr={pr} />
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {data && data.total > PAGE_SIZE && (
        <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 16 }}>
          <button
            type="button"
            style={css.btnSmall}
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            ← Prev
          </button>
          <span style={{ fontSize: 12, color: "var(--fg3)", padding: "4px 8px" }}>
            {offset + 1}–{Math.min(offset + PAGE_SIZE, data.total)} of {data.total}
          </span>
          <button
            type="button"
            style={css.btnSmall}
            disabled={offset + PAGE_SIZE >= data.total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}

function PrRow({ pr }: { pr: GitHubHubPr }) {
  const stateColor =
    pr.state === "open" ? "#22c55e" : pr.state === "merged" ? "#a855f7" : "#6b7280";

  const repoShort = pr.repo.split("/").pop() || pr.repo;
  const prUrl = `https://github.com/${pr.repo}/pull/${pr.number}`;
  const size = pr.additions + pr.deletions;
  const sizeLabel = size > 1000 ? "XL" : size > 500 ? "L" : size > 100 ? "M" : "S";
  const sizeColor =
    size > 1000 ? "#ef4444" : size > 500 ? "#f97316" : size > 100 ? "#eab308" : "#22c55e";

  // Review summary
  const approvals = pr.reviews?.filter((r) => r.state === "APPROVED").length || 0;
  const changesReq = pr.reviews?.filter((r) => r.state === "CHANGES_REQUESTED").length || 0;

  const updated = relativeTime(pr.updated_at);

  return (
    <tr style={{ cursor: "pointer" }} onClick={() => window.open(prUrl, "_blank")}>
      <td style={css.td}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {pr.is_draft && (
            <span style={{ fontSize: 10, color: "var(--fg3)", fontWeight: 500 }}>DRAFT</span>
          )}
          <span
            style={{
              fontWeight: 500,
              color: "var(--fg)",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {pr.title}
          </span>
        </div>
        <div style={{ fontSize: 11, color: "var(--fg3)", marginTop: 2 }}>
          #{pr.number} · {pr.head_ref || "—"}
        </div>
      </td>
      <td style={css.td}>
        <span style={{ fontSize: 13 }}>{pr.author}</span>
      </td>
      <td style={css.td}>
        <span style={{ fontSize: 12, color: "var(--fg2)" }}>{repoShort}</span>
      </td>
      <td style={css.td}>
        <span
          style={{
            display: "inline-block",
            padding: "2px 8px",
            borderRadius: 12,
            fontSize: 11,
            fontWeight: 600,
            background: `${stateColor}22`,
            color: stateColor,
            border: `1px solid ${stateColor}44`,
            textTransform: "capitalize",
          }}
        >
          {pr.state}
        </span>
      </td>
      <td style={css.td}>
        <span style={{ fontSize: 12, fontWeight: 600, color: sizeColor }}>{sizeLabel}</span>
        <span style={{ fontSize: 11, color: "var(--fg3)", marginLeft: 4 }}>
          +{pr.additions} −{pr.deletions}
        </span>
      </td>
      <td style={css.td}>
        {approvals > 0 && (
          <span style={{ fontSize: 11, color: "#22c55e", marginRight: 4 }}>✓{approvals}</span>
        )}
        {changesReq > 0 && <span style={{ fontSize: 11, color: "#ef4444" }}>✗{changesReq}</span>}
        {approvals === 0 && changesReq === 0 && (
          <span style={{ fontSize: 11, color: "var(--fg3)" }}>—</span>
        )}
      </td>
      <td style={css.td}>
        <span style={{ fontSize: 12, color: "var(--fg3)" }}>{updated}</span>
      </td>
    </tr>
  );
}
