import { useCallback, useEffect, useState } from "react";
import {
  getResearchSession,
  listResearchSessions,
  type ResearchSession,
  type ResearchStrategy,
} from "../../api.js";
import { css } from "../../styles/theme.js";
import { formatDuration, sessionStatusColor, strategyColor } from "./kbShared.js";
import { ResearchTimeline } from "./ResearchTimeline.js";

export function ResearchHistory() {
  const [sessions, setSessions] = useState<ResearchSession[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filterStrategy, setFilterStrategy] = useState<ResearchStrategy | "">("");
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<ResearchSession | null>(null);

  const limit = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params: { limit: number; offset: number; strategy?: ResearchStrategy } = {
        limit,
        offset,
      };
      if (filterStrategy) params.strategy = filterStrategy;
      const data = await listResearchSessions(params);
      setSessions(data.sessions);
      setTotal(data.total);
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [offset, filterStrategy]);

  useEffect(() => {
    load();
  }, [load]);

  const loadSession = async (id: string) => {
    if (selectedId === id) {
      setSelectedId(null);
      setSelectedSession(null);
      return;
    }
    setSelectedId(id);
    try {
      const data = await getResearchSession(id);
      setSelectedSession(data.session);
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  return (
    <div style={{ ...css.card, marginBottom: 20 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>📜 Research History</h3>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select
            style={{
              ...css.input,
              width: "auto",
              fontSize: 12,
              padding: "4px 8px",
            }}
            value={filterStrategy}
            onChange={(e) => {
              setFilterStrategy(e.target.value as ResearchStrategy | "");
              setOffset(0);
            }}
          >
            <option value="">All strategies</option>
            <option value="simple">simple</option>
            <option value="deep">deep</option>
            <option value="agent">agent</option>
          </select>
          <span style={{ fontSize: 12, color: "var(--fg2)" }}>
            {total} session{total !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      {error && <div style={css.error}>{error}</div>}

      {loading && <div style={{ fontSize: 13, color: "var(--fg2)" }}>Loading...</div>}

      {!loading && sessions.length === 0 && (
        <div style={{ fontSize: 13, color: "var(--fg2)" }}>
          No research sessions yet. Run a query in the Research Playground to get started.
        </div>
      )}

      {sessions.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {sessions.map((s) => {
            const llmCalls = s.steps.flatMap((st) => st.llm_calls).length;
            const duration = s.completed_at
              ? new Date(s.completed_at).getTime() - new Date(s.created_at).getTime()
              : 0;

            return (
              <div key={s.session_id}>
                <div
                  style={{
                    background: selectedId === s.session_id ? "var(--bg2)" : "var(--bg)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius)",
                    padding: 10,
                    cursor: "pointer",
                    transition: "background 0.1s",
                  }}
                  onClick={() => loadSession(s.session_id)}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "center",
                        flex: 1,
                        minWidth: 0,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 10,
                          padding: "1px 6px",
                          borderRadius: 4,
                          fontWeight: 600,
                          background: `${sessionStatusColor(s.status)}22`,
                          color: sessionStatusColor(s.status),
                          flexShrink: 0,
                        }}
                      >
                        {s.status}
                      </span>
                      <span
                        style={{
                          fontSize: 10,
                          padding: "1px 6px",
                          borderRadius: 4,
                          background: `${strategyColor(s.config.strategy)}22`,
                          color: strategyColor(s.config.strategy),
                          fontWeight: 600,
                          flexShrink: 0,
                        }}
                      >
                        {s.config.strategy}
                      </span>
                      <span
                        style={{
                          fontSize: 12,
                          color: "var(--fg)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {s.original_query}
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        gap: 12,
                        alignItems: "center",
                        flexShrink: 0,
                        marginLeft: 8,
                      }}
                    >
                      <span style={{ fontSize: 11, color: "var(--fg2)" }}>
                        {formatDuration(duration)}
                      </span>
                      <span style={{ fontSize: 11, color: "var(--fg2)" }}>{llmCalls} LLM</span>
                      <span style={{ fontSize: 11, color: "var(--fg2)" }}>
                        {new Date(s.created_at).toLocaleString()}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Expanded detail */}
                {selectedId === s.session_id && selectedSession && (
                  <div
                    style={{
                      background: "var(--bg)",
                      border: "1px solid var(--border)",
                      borderTop: "none",
                      borderRadius: "0 0 var(--radius) var(--radius)",
                      padding: 12,
                    }}
                  >
                    <ResearchTimeline session={selectedSession} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {total > limit && (
        <div style={{ display: "flex", justifyContent: "center", gap: 12, marginTop: 12 }}>
          <button
            type="button"
            style={css.btnSmall}
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - limit))}
          >
            ← Previous
          </button>
          <span style={{ fontSize: 12, color: "var(--fg2)", alignSelf: "center" }}>
            {offset + 1}–{Math.min(offset + limit, total)} of {total}
          </span>
          <button
            type="button"
            style={css.btnSmall}
            disabled={offset + limit >= total}
            onClick={() => setOffset(offset + limit)}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
