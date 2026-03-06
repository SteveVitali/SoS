/**
 * GitHubPrsView — displays PRs from the GitHub Hub sync cache.
 * Card-style layout with sort/filter controls, scope toggle, and pagination.
 * Supports job actions (self-review, add review comments, respond to comments).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  createAddReviewCommentsJob,
  createRespondToCommentsJob,
  createSelfReviewPrJob,
  type GitHubHubPr,
  type GitHubHubPrsResponse,
  type GitHubScope,
  listGitHubPrs,
  type PrCommentStats,
  type PrSortField,
} from "../../api.js";
import { buildCacheKey, getCached, setCache } from "../../hooks/useApiCache.js";
import { useClickOutside } from "../../hooks/useClickOutside.js";
import { useAppData } from "../../stores/AppDataContext.js";
import { css } from "../../styles/theme.js";
import { relativeTime, toErrorMessage } from "../../utils/format.js";
import { Dot } from "../shared/Dot.js";
import { HoverRow } from "../shared/HoverRow.js";
import { Pagination } from "../shared/Pagination.js";
import { Spinner } from "../shared/Spinner.js";
import { ScopeToggle } from "./ScopeToggle.js";

const STATE_OPTIONS = ["open", "merged", "closed", "all"] as const;
const PAGE_SIZE = 30;

const SORT_OPTIONS: { key: PrSortField; label: string }[] = [
  { key: "updated", label: "Updated" },
  { key: "created", label: "Created" },
  { key: "title", label: "Title" },
  { key: "author", label: "Author" },
  { key: "repo", label: "Repo" },
  { key: "size", label: "Size" },
  { key: "reviews", label: "Reviews" },
];

type PrAction = "self_review" | "add_review_comments" | "respond_to_comments";

const PR_ACTIONS: PrAction[] = ["self_review", "add_review_comments", "respond_to_comments"];

const ACTION_LABELS: Record<PrAction, string> = {
  self_review: "Self Review",
  add_review_comments: "Add Review Comments",
  respond_to_comments: "Respond to Comments",
};

export function GitHubPrsView() {
  const navigate = useNavigate();
  const { refreshJobs, jobOwner } = useAppData();

  const [scope, setScope] = useState<GitHubScope>("team");
  const [state, setState] = useState<string>("open");
  const [data, setData] = useState<GitHubHubPrsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [offset, setOffset] = useState(0);
  const [sortField, setSortField] = useState<PrSortField>("updated");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [busyPr, setBusyPr] = useState<string | null>(null);

  const cacheParams = { scope, state, limit: PAGE_SIZE, offset, sort: sortField, order: sortOrder };
  const cacheKey = buildCacheKey("github-prs", cacheParams);

  // When params change, immediately show cached data or clear stale data so the
  // big Spinner renders while the network request is in flight.
  useEffect(() => {
    const cached = getCached<GitHubHubPrsResponse>(cacheKey);
    if (cached) {
      setData(cached);
      setError("");
    } else {
      setData(null);
    }
  }, [cacheKey]);

  const fetchPrs = useCallback(
    async (skipCache = false) => {
      if (!skipCache) {
        const cached = getCached<GitHubHubPrsResponse>(cacheKey);
        if (cached) {
          setData(cached);
          setError("");
          return;
        }
      }
      setLoading(true);
      setError("");
      try {
        const res = await listGitHubPrs({
          scope,
          state,
          limit: PAGE_SIZE,
          offset,
          sort: sortField,
          order: sortOrder,
        });
        setData(res);
        setCache(cacheKey, res);
      } catch (err: unknown) {
        setError(toErrorMessage(err));
      } finally {
        setLoading(false);
      }
    },
    [cacheKey, scope, state, offset, sortField, sortOrder],
  );

  useEffect(() => {
    fetchPrs();
  }, [fetchPrs]);

  const handleTrigger = async (pr: GitHubHubPr, action: PrAction) => {
    const prUrl = `https://github.com/${pr.repo}/pull/${pr.number}`;
    setBusyPr(pr._id);
    setActionError("");
    try {
      if (!jobOwner) {
        setActionError("Job owner not configured on server");
        return;
      }
      const payload = { requested_by: jobOwner, pr_url: prUrl };
      let taskId: string;
      if (action === "self_review") {
        const res = await createSelfReviewPrJob(payload);
        taskId = res.job.task_id;
      } else if (action === "add_review_comments") {
        const res = await createAddReviewCommentsJob(payload);
        taskId = res.job.task_id;
      } else {
        const res = await createRespondToCommentsJob(payload);
        taskId = res.job.task_id;
      }
      refreshJobs();
      navigate(`/jobs/${taskId}`);
    } catch (err: unknown) {
      setActionError(toErrorMessage(err));
    } finally {
      setBusyPr(null);
    }
  };

  const prs = data?.prs || [];

  return (
    <div>
      {/* Filter bar */}
      <div style={{ ...css.filters, justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
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
          {/* Sort controls */}
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              marginLeft: 4,
              borderLeft: "1px solid var(--border)",
              paddingLeft: 12,
            }}
          >
            <span style={{ fontSize: 11, color: "var(--fg3)", fontWeight: 500 }}>Sort:</span>
            <select
              value={sortField}
              onChange={(e) => {
                const field = e.target.value as PrSortField;
                setSortField(field);
                setSortOrder(
                  field === "title" || field === "author" || field === "repo" ? "asc" : "desc",
                );
                setOffset(0);
              }}
              style={{
                ...css.btnSmall,
                background: "var(--bg3)",
                cursor: "pointer",
                paddingRight: 6,
                appearance: "auto" as any,
              }}
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.key} value={opt.key}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setSortOrder((o) => (o === "desc" ? "asc" : "desc"))}
              style={{
                ...css.btnSmall,
                padding: "4px 6px",
                fontSize: 11,
                cursor: "pointer",
                fontWeight: 600,
              }}
              title={
                sortOrder === "desc"
                  ? "Descending (click to toggle)"
                  : "Ascending (click to toggle)"
              }
            >
              {sortOrder === "desc" ? "▼" : "▲"}
            </button>
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
          <button
            type="button"
            onClick={() => fetchPrs(true)}
            style={css.btnSmall}
            disabled={loading}
          >
            {loading ? "Loading…" : "↻ Refresh"}
          </button>
        </div>
      </div>

      {(error || actionError) && <div style={css.error}>{error || actionError}</div>}

      {/* PR Cards */}
      {loading && prs.length === 0 ? (
        <Spinner label="Loading pull requests…" />
      ) : prs.length === 0 ? (
        <div style={{ color: "var(--fg2)", padding: 20 }}>No pull requests found.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {prs.map((pr) => (
            <PrCard
              key={pr._id}
              pr={pr}
              busy={busyPr === pr._id}
              onTrigger={(action) => handleTrigger(pr, action)}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {data && data.total > PAGE_SIZE && (
        <Pagination
          offset={offset}
          limit={PAGE_SIZE}
          total={data.total}
          onPrev={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          onNext={() => setOffset(offset + PAGE_SIZE)}
        />
      )}
    </div>
  );
}

// --- Extracted Sub-Components ---

function prStateColor(state: string, isDraft: boolean): string {
  if (state === "open") return isDraft ? "#6b7280" : "#22c55e";
  if (state === "merged") return "#a855f7";
  return "#ef4444";
}

function ReviewBadges({ reviews }: { reviews: GitHubHubPr["reviews"] }) {
  const approvals = reviews?.filter((r) => r.state === "APPROVED").length || 0;
  const changesReq = reviews?.filter((r) => r.state === "CHANGES_REQUESTED").length || 0;
  if (approvals === 0 && changesReq === 0) return null;
  return (
    <div style={{ display: "flex", gap: 4, fontSize: 11 }}>
      {approvals > 0 && (
        <span
          style={{ ...css.badge("#22c55e"), fontSize: 11 }}
          title={`${approvals} approval${approvals > 1 ? "s" : ""}`}
        >
          ✓ {approvals}
        </span>
      )}
      {changesReq > 0 && (
        <span
          style={{ ...css.badge("#ef4444"), fontSize: 11 }}
          title={`${changesReq} changes requested`}
        >
          ✗ {changesReq}
        </span>
      )}
    </div>
  );
}

function CommentStatBadges({ stats }: { stats?: PrCommentStats }) {
  if (!stats || stats.total_threads === 0) return null;
  return (
    <div style={{ display: "flex", gap: 4, fontSize: 11 }}>
      <span
        style={{ ...css.badge("#6b7280"), fontSize: 11 }}
        title={`${stats.total_threads} review threads, ${stats.total_comments} comments total`}
      >
        {stats.total_threads} threads
      </span>
      {stats.unresolved_threads > 0 && (
        <span
          style={{ ...css.badge("#f59e0b"), fontSize: 11 }}
          title={`${stats.unresolved_threads} unresolved review threads`}
        >
          {stats.unresolved_threads} unresolved
        </span>
      )}
      {stats.unaddressed_threads > 0 && (
        <span
          style={{ ...css.badge("#ef4444"), fontSize: 11 }}
          title={`${stats.unaddressed_threads} threads awaiting response`}
        >
          {stats.unaddressed_threads} needs reply
        </span>
      )}
    </div>
  );
}

const MAX_VISIBLE_LABELS = 4;

function LabelPills({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null;
  return (
    <>
      <Dot />
      <span style={{ display: "inline-flex", gap: 4 }}>
        {labels.slice(0, MAX_VISIBLE_LABELS).map((label) => (
          <span
            key={label}
            style={{
              padding: "1px 6px",
              borderRadius: 10,
              fontSize: 10,
              fontWeight: 500,
              background: "var(--bg3)",
              color: "var(--fg2)",
              border: "1px solid var(--border)",
            }}
          >
            {label}
          </span>
        ))}
        {labels.length > MAX_VISIBLE_LABELS && (
          <span style={{ fontSize: 10, color: "var(--fg3)" }}>
            +{labels.length - MAX_VISIBLE_LABELS}
          </span>
        )}
      </span>
    </>
  );
}

function SizeBadge({ additions, deletions }: { additions: number; deletions: number }) {
  const size = additions + deletions;
  const label = size > 1000 ? "XL" : size > 500 ? "L" : size > 100 ? "M" : "S";
  const color =
    size > 1000 ? "#ef4444" : size > 500 ? "#f97316" : size > 100 ? "#eab308" : "#22c55e";
  return (
    <>
      <span style={{ fontWeight: 600, color, fontSize: 11 }}>{label}</span>
      <span style={{ margin: "0 3px" }} />
      <span style={{ color: "#22c55e" }}>+{additions}</span>
      <span style={{ margin: "0 4px" }}>/</span>
      <span style={{ color: "#ef4444" }}>-{deletions}</span>
    </>
  );
}

function TriggerDropdown({
  busy,
  onTrigger,
}: {
  busy: boolean;
  onTrigger: (action: PrAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useClickOutside(ref, () => setOpen(false), open);

  return (
    <div style={{ position: "relative" }} ref={ref}>
      <button
        type="button"
        style={css.btnSmall}
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        {busy ? "…" : "Trigger ▾"}
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            right: 0,
            top: "100%",
            marginTop: 4,
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
            zIndex: 10,
            minWidth: 200,
            overflow: "hidden",
          }}
        >
          {PR_ACTIONS.map((action) => (
            <button
              key={action}
              type="button"
              style={{
                display: "block",
                width: "100%",
                padding: "8px 14px",
                background: "transparent",
                border: "none",
                color: "var(--fg)",
                fontSize: 13,
                textAlign: "left",
                cursor: "pointer",
              }}
              onMouseEnter={(e) => {
                (e.target as HTMLElement).style.background = "var(--bg2)";
              }}
              onMouseLeave={(e) => {
                (e.target as HTMLElement).style.background = "transparent";
              }}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onTrigger(action);
              }}
            >
              {ACTION_LABELS[action]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --- PrCard ---

function PrCard({
  pr,
  busy,
  onTrigger,
}: {
  pr: GitHubHubPr;
  busy: boolean;
  onTrigger: (action: PrAction) => void;
}) {
  const prUrl = `https://github.com/${pr.repo}/pull/${pr.number}`;
  const stateColor = prStateColor(pr.state, pr.is_draft);
  const stateLabel = pr.is_draft ? "DRAFT" : pr.state.toUpperCase();

  return (
    <HoverRow>
      {/* Line 1: state badge + title + review badges + comment badges + actions */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={css.badge(stateColor)}>{stateLabel}</span>
        <a
          href={prUrl}
          target="_blank"
          rel="noopener"
          style={{
            ...css.link,
            fontWeight: 500,
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {pr.title}
        </a>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <ReviewBadges reviews={pr.reviews} />
          <CommentStatBadges stats={pr.comment_stats} />
          <TriggerDropdown busy={busy} onTrigger={onTrigger} />
        </div>
      </div>

      {/* Line 2: metadata chips */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "4px 0",
          marginTop: 6,
          fontSize: 12,
          color: "var(--fg3)",
          alignItems: "center",
        }}
      >
        <span style={css.mono}>
          {pr.repo}#{pr.number}
        </span>
        <Dot />
        <span>{pr.author}</span>
        <Dot />
        <span style={css.mono}>{pr.head_ref || "—"}</span>
        <Dot />
        <span style={{ color: "var(--fg3)" }} title={new Date(pr.updated_at).toLocaleString()}>
          {relativeTime(pr.updated_at)}
        </span>
        <Dot />
        <SizeBadge additions={pr.additions} deletions={pr.deletions} />
        {pr.requested_reviewers.length > 0 && (
          <>
            <Dot />
            <span
              title={`Requested reviewers: ${pr.requested_reviewers.join(", ")}`}
              style={{ fontSize: 11 }}
            >
              Reviewers: {pr.requested_reviewers.join(", ")}
            </span>
          </>
        )}
        <LabelPills labels={pr.labels} />
        {pr.linked_job_task_id && (
          <>
            <Dot />
            <Link
              to={`/jobs/${pr.linked_job_task_id}`}
              style={{ ...css.link, ...css.mono, fontSize: 11 }}
              onClick={(e) => e.stopPropagation()}
            >
              job {pr.linked_job_task_id.slice(0, 8)}
            </Link>
          </>
        )}
      </div>
    </HoverRow>
  );
}
