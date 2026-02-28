import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { cancelJob, deleteJob, type Job, retryJob } from "../../api.js";
import { getSlackNameCache, useSlackNames } from "../../hooks/useSlackNames.js";
import { useAppData } from "../../stores/AppDataContext.js";
import { css, lastSubstantiveEvent } from "../../styles/theme.js";
import { formatUserShort } from "../../utils/format.js";
import { LastUpdated } from "../shared/LastUpdated.js";
import { PageHeader } from "../shared/PageHeader.js";
import { Pagination } from "../shared/Pagination.js";
import { type SortDir, type SortKey, SortPills } from "../shared/SortPills.js";
import { Spinner } from "../shared/Spinner.js";
import { JobRow } from "./JobRow.js";

function getJobSortValue(job: Job, key: SortKey): string {
  const cache = getSlackNameCache();
  switch (key) {
    case "task_id":
      return job.task_id;
    case "status":
      return job.status;
    case "requested_by": {
      const cached = cache.get(job.requested_by);
      return (cached?.displayName || job.requested_by).toLowerCase();
    }
    case "created_at":
      return job.created_at;
    case "updated": {
      const ev = lastSubstantiveEvent(job.events);
      return ev ? ev.at : job.updated_at || job.created_at;
    }
    case "repo":
      return (job.repos_resolved?.join(", ") || job.repo_hint || "").toLowerCase();
    case "worktree_slot":
      return (job.worktree_slot || "").toLowerCase();
    case "pr":
      return (job.pr_urls?.join(", ") || "").toLowerCase();
    default:
      return "";
  }
}

function sortJobs(jobs: Job[], key: SortKey, dir: SortDir): Job[] {
  const sorted = [...jobs].sort((a, b) => {
    const va = getJobSortValue(a, key);
    const vb = getJobSortValue(b, key);
    if (va < vb) return -1;
    if (va > vb) return 1;
    return 0;
  });
  return dir === "desc" ? sorted.reverse() : sorted;
}

export function JobsList() {
  const navigate = useNavigate();
  const { jobs: jobsState, refreshJobs } = useAppData();
  const { jobs, total, users, loading, error, prStats, lastRefreshedAt } = jobsState;

  const [status, setStatus] = useState("");
  const [requestedBy, setRequestedBy] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const limit = 25;

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const sortedJobs = sortKey ? sortJobs(jobs, sortKey, sortDir) : jobs;

  // When filters change, refresh with new params
  useEffect(() => {
    refreshJobs({
      status: status || undefined,
      requested_by: requestedBy || undefined,
      q: search || undefined,
      limit,
      offset,
    });
  }, [status, requestedBy, search, offset, refreshJobs]);

  // Browser notifications for WAITING_FOR_APPROVAL
  const prevStatuses = useRef(new Map<string, string>());
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);
  useEffect(() => {
    for (const job of jobs) {
      const prev = prevStatuses.current.get(job.task_id);
      if (prev && prev !== "WAITING_FOR_APPROVAL" && job.status === "WAITING_FOR_APPROVAL") {
        if ("Notification" in window && Notification.permission === "granted") {
          const n = new Notification("Son of Steve — PR Ready for Review", {
            body: `${job.title || job.task_text.slice(0, 60)}\nClick to review and promote.`,
            tag: `sos-approval-${job.task_id}`,
          });
          n.onclick = () => {
            window.focus();
            navigate(`/jobs/${job.task_id}`);
          };
        }
      }
      prevStatuses.current.set(job.task_id, job.status);
    }
  }, [jobs, navigate]);

  // Resolve Slack display names for all visible user IDs
  const allUserIds = [...new Set([...users, ...jobs.map((j) => j.requested_by)])];
  useSlackNames(allUserIds);
  const cache = getSlackNameCache();

  const handleAction = async (action: "cancel" | "retry" | "delete", taskId: string) => {
    try {
      if (action === "cancel") await cancelJob(taskId);
      else if (action === "retry") await retryJob(taskId);
      else if (action === "delete") await deleteJob(taskId);
      refreshJobs();
    } catch (_err: unknown) {
      // Error will show on next refresh
    }
  };

  return (
    <div>
      <PageHeader
        title="Jobs"
        count={total}
        actions={
          <>
            <button type="button" style={css.btn} onClick={() => refreshJobs()}>
              ↻ Refresh
            </button>
            <button type="button" style={css.btnPrimary} onClick={() => navigate("/jobs/new")}>
              + Create Job
            </button>
          </>
        }
        subtitle={<LastUpdated at={lastRefreshedAt} />}
      />
      <div style={css.filters}>
        <select
          style={css.select}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">All statuses</option>
          {["QUEUED", "RUNNING", "FIXING_CI", "DONE", "FAILED", "CANCELED"].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          style={css.select}
          value={requestedBy}
          onChange={(e) => {
            setRequestedBy(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">All users</option>
          {users.map((u) => (
            <option key={u} value={u}>
              {formatUserShort(u, cache)}
            </option>
          ))}
        </select>
        <input
          style={{ ...css.input, maxWidth: 250 }}
          placeholder="Search task text or ID..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
          }}
        />
      </div>
      {error && <div style={css.error}>{error}</div>}
      {loading && jobs.length === 0 ? (
        <Spinner label="Loading jobs..." />
      ) : jobs.length === 0 ? (
        <div style={{ color: "var(--fg2)", padding: 20 }}>No jobs found.</div>
      ) : (
        <>
          <SortPills sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {sortedJobs.map((job) => (
              <JobRow key={job.task_id} job={job} prStats={prStats} onAction={handleAction} />
            ))}
          </div>
          <Pagination
            offset={offset}
            limit={limit}
            total={total}
            onPrev={() => setOffset(Math.max(0, offset - limit))}
            onNext={() => setOffset(offset + limit)}
          />
        </>
      )}
    </div>
  );
}
