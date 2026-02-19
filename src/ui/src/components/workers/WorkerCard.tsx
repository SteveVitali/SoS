import { useNavigate } from "react-router-dom";
import type { WorkerInfo } from "../../api.js";
import { css } from "../../styles/theme.js";
import { relativeTime } from "../../utils/format.js";
import { HoverRow } from "../shared/HoverRow.js";

interface WorkerCardProps {
  worker: WorkerInfo;
  onViewLogs: () => void;
  onShutdown: () => void;
  onRemove: () => void;
}

function statusDotColor(status: string): string {
  if (status === "online") return "#22c55e";
  if (status === "degraded") return "#eab308";
  return "#6b7280";
}

function loopDotColor(status: string): string {
  return status === "busy" ? "#eab308" : "#22c55e";
}

function formatUptime(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hrs < 24) return `${hrs}h ${remMins}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

export function WorkerCard({ worker, onViewLogs, onShutdown, onRemove }: WorkerCardProps) {
  const navigate = useNavigate();
  const isOffline = worker.status === "offline";

  return (
    <HoverRow onClick={onViewLogs} style={{ opacity: isOffline ? 0.5 : 1 }}>
      {/* Line 1: status dot + worker ID + uptime + PID */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: statusDotColor(worker.status),
            flexShrink: 0,
          }}
        />
        <span style={{ fontWeight: 600, color: "var(--fg)" }}>{worker.worker_id}</span>
        <span style={{ fontSize: 12, color: "var(--fg3)" }}>
          {isOffline
            ? `offline (last seen ${relativeTime(worker.last_seen)})`
            : `▲ ${formatUptime(worker.started_at)}`}
        </span>
        <span
          style={{
            ...css.mono,
            fontSize: 11,
            color: "var(--fg3)",
            background: "var(--bg3)",
            padding: "1px 6px",
            borderRadius: 4,
          }}
        >
          PID {worker.pid}
        </span>
        <div style={{ flex: 1 }} />
        <fieldset
          style={{ display: "flex", gap: 4, border: "none", padding: 0, margin: 0 }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {!isOffline && (
            <>
              <button type="button" style={css.btnSmall} onClick={onViewLogs}>
                Logs
              </button>
              <button
                type="button"
                style={{ ...css.btnSmall, color: "var(--red)" }}
                onClick={onShutdown}
              >
                Shutdown
              </button>
            </>
          )}
          {isOffline && (
            <button
              type="button"
              style={{ ...css.btnSmall, color: "var(--red)" }}
              onClick={onRemove}
            >
              Remove
            </button>
          )}
        </fieldset>
      </div>

      {/* Line 2+: loop lines */}
      {worker.loops.map((loop) => (
        <div
          key={loop.index}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 6,
            marginLeft: 18,
            fontSize: 12,
            color: "var(--fg3)",
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: loopDotColor(loop.status),
              flexShrink: 0,
            }}
          />
          <span style={{ color: "var(--fg2)", fontWeight: 500 }}>Loop {loop.index}</span>
          <span style={css.badge(loopDotColor(loop.status))}>{loop.status}</span>
          {loop.worktree_slot && <span style={css.mono}>{loop.worktree_slot}</span>}
          {loop.task_id && (
            <a
              href={`/jobs/${loop.task_id}`}
              style={{ ...css.mono, ...css.link, textDecoration: "none" }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                navigate(`/jobs/${loop.task_id}`);
              }}
            >
              {loop.task_id.slice(0, 8)}…
            </a>
          )}
          {loop.busy_since && <span>{relativeTime(loop.busy_since)}</span>}
        </div>
      ))}
    </HoverRow>
  );
}
