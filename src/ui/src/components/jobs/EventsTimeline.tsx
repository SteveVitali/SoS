import type { Job } from "../../api.js";
import { css, EVENT_LABELS, eventColor } from "../../styles/theme.js";
import { relativeTime } from "../../utils/format.js";

export function EventsTimeline({ job }: { job: Job }) {
  if (!job.events || job.events.length === 0) return null;

  return (
    <div style={css.card}>
      <div style={css.sectionTitle}>Events ({job.events.length})</div>
      <div style={css.timeline}>
        {[...job.events].reverse().map((ev, i) => {
          const color = eventColor(ev.type);
          return (
            <div key={i} style={css.timelineItem}>
              <div style={css.dot(color)} />
              <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <span style={{ ...css.badge(color), fontSize: 11 }}>
                  {EVENT_LABELS[ev.type] || ev.type}
                </span>
                <span style={{ color: "var(--fg3)", fontSize: 12 }}>{relativeTime(ev.at)}</span>
                {ev.node_id && (
                  <span style={{ ...css.mono, color: "var(--fg3)", fontSize: 11 }}>
                    {ev.node_id}
                  </span>
                )}
              </div>
              {ev.payload && (
                <div style={{ ...css.pre, marginTop: 4, fontSize: 11, maxHeight: 120 }}>
                  {typeof ev.payload === "string"
                    ? ev.payload
                    : JSON.stringify(ev.payload, null, 2)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
