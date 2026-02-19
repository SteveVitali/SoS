import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createRespondToCommentsJob, type GitHubPr } from "../../api.js";
import { useAppData } from "../../stores/AppDataContext.js";
import { css } from "../../styles/theme.js";
import { LastUpdated } from "../shared/LastUpdated.js";
import { PageHeader } from "../shared/PageHeader.js";
import { Spinner } from "../shared/Spinner.js";
import { PrRow } from "./PrRow.js";

export function PrsList() {
  const navigate = useNavigate();
  const { prs: prsState, refreshPrs, refreshJobs, jobOwner } = useAppData();
  const { prs, loading, error, lastRefreshedAt } = prsState;

  const [state, setState] = useState<"open" | "closed" | "merged" | "all">("open");
  const [limit, setLimit] = useState(20);
  const [responding, setResponding] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");

  // When filters change, refresh with new params
  useEffect(() => {
    refreshPrs({ state, limit });
  }, [state, limit, refreshPrs]);

  const handleRespondToComments = async (pr: GitHubPr) => {
    setResponding(pr.url);
    setActionError("");
    try {
      if (!jobOwner) {
        setActionError("Job owner not configured on server");
        return;
      }
      const res = await createRespondToCommentsJob({
        requested_by: jobOwner,
        pr_url: pr.url,
      });
      refreshJobs();
      navigate(`/jobs/${res.job.task_id}`);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setResponding(null);
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
                responding={responding === pr.url}
                onRespond={() => handleRespondToComments(pr)}
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
