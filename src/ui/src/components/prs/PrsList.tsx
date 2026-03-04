import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  createAddReviewCommentsJob,
  createRespondToCommentsJob,
  createSelfReviewPrJob,
  type GitHubPr,
} from "../../api.js";
import { useAppData } from "../../stores/AppDataContext.js";
import { css } from "../../styles/theme.js";
import { LastUpdated } from "../shared/LastUpdated.js";
import { PageHeader } from "../shared/PageHeader.js";
import { Spinner } from "../shared/Spinner.js";
import { type PrAction, PrRow } from "./PrRow.js";

export function PrsList() {
  const navigate = useNavigate();
  const { prs: prsState, refreshPrs, refreshJobs, jobOwner } = useAppData();
  const { prs, loading, error, lastRefreshedAt } = prsState;

  const [state, setState] = useState<"open" | "closed" | "merged" | "all">("open");
  const [limit, setLimit] = useState(20);
  const [busyPr, setBusyPr] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");

  // When filters change, refresh with new params
  useEffect(() => {
    refreshPrs({ state, limit });
  }, [state, limit, refreshPrs]);

  const handleTrigger = async (pr: GitHubPr, action: PrAction) => {
    setBusyPr(pr.url);
    setActionError("");
    try {
      if (!jobOwner) {
        setActionError("Job owner not configured on server");
        return;
      }
      const payload = { requested_by: jobOwner, pr_url: pr.url };
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
      setActionError(err instanceof Error ? (err as Error).message : String(err));
    } finally {
      setBusyPr(null);
    }
  };

  return (
    <div>
      <PageHeader
        title="Pull Requests"
        count={prs.length}
        actions={
          <button type="button" style={css.btn} onClick={() => refreshPrs()}>
            ↻ Refresh
          </button>
        }
        subtitle={<LastUpdated at={lastRefreshedAt} />}
      />
      <div style={css.filters}>
        <select
          style={css.select}
          value={state}
          onChange={(e) => {
            setState(e.target.value as "open" | "closed" | "merged" | "all");
            setLimit(20);
          }}
        >
          <option value="open">Open</option>
          <option value="closed">Closed</option>
          <option value="merged">Merged</option>
          <option value="all">All</option>
        </select>
      </div>
      {(error || actionError) && <div style={css.error}>{error || actionError}</div>}
      {loading && prs.length === 0 ? (
        <Spinner label="Loading pull requests..." />
      ) : prs.length === 0 ? (
        <div style={{ color: "var(--fg2)", padding: 20 }}>No pull requests found.</div>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {prs.map((pr) => (
              <PrRow
                key={pr.url}
                pr={pr}
                busy={busyPr === pr.url}
                onTrigger={(action) => handleTrigger(pr, action)}
              />
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "center", marginTop: 16 }}>
            <button
              type="button"
              style={css.btn}
              onClick={() => setLimit((l) => l + 20)}
              disabled={loading}
            >
              {loading ? "Loading..." : "Fetch more"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
