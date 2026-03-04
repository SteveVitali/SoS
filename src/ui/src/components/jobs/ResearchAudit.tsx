import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listResearchSessions, type ResearchSession } from "../../api.js";
import { css } from "../../styles/theme.js";
import { strategyColor } from "../kb/kbShared.js";

const STAGE_ICONS: Record<string, string> = {
  query_analysis: "🔍",
  query_expansion: "📝",
  retrieval: "📚",
  evaluation: "⚖️",
  reasoning: "🧠",
  synthesis: "✨",
  agent_turn: "🤖",
};

export function ResearchAudit({ taskId }: { taskId: string }) {
  const [sessions, setSessions] = useState<ResearchSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listResearchSessions({
        consumer_type: "job",
        consumer_id: taskId,
        limit: 20,
      });
      setSessions(res.sessions);
    } catch {
      // Non-fatal — just means no sessions
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return null;
  if (sessions.length === 0) return null;

  return (
    <div style={css.card}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          cursor: "pointer",
        }}
        onClick={() => setExpanded((v) => !v)}
      >
        <div style={css.sectionTitle}>
          🔬 Research Audit ({sessions.length} session{sessions.length !== 1 ? "s" : ""})
        </div>
        <span style={{ fontSize: 12, color: "var(--fg2)" }}>{expanded ? "▼" : "▶"}</span>
      </div>

      {expanded && (
        <div style={{ marginTop: 12 }}>
          {sessions.map((session) => {
            const isOpen = expandedSession === session.session_id;
            const durationMs = session.completed_at
              ? new Date(session.completed_at).getTime() - new Date(session.created_at).getTime()
              : 0;

            return (
              <div
                key={session.session_id}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  marginBottom: 8,
                  overflow: "hidden",
                }}
              >
                {/* Session header */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "8px 12px",
                    background: "var(--bg)",
                    cursor: "pointer",
                  }}
                  onClick={() => setExpandedSession(isOpen ? null : session.session_id)}
                >
                  <div style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13 }}>
                    <span style={{ fontSize: 11, color: "var(--fg2)" }}>{isOpen ? "▼" : "▶"}</span>
                    <span
                      style={{
                        fontSize: 11,
                        padding: "2px 6px",
                        borderRadius: 3,
                        background: `${strategyColor(session.config.strategy)}22`,
                        color: strategyColor(session.config.strategy),
                        fontWeight: 600,
                      }}
                    >
                      {session.config.strategy}
                    </span>
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        maxWidth: 400,
                      }}
                    >
                      {session.original_query}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 12, fontSize: 11, color: "var(--fg2)" }}>
                    <span>{session.steps.length} steps</span>
                    {durationMs > 0 && <span>{(durationMs / 1000).toFixed(1)}s</span>}
                    <span
                      style={{
                        color:
                          session.status === "completed"
                            ? "#22c55e"
                            : session.status === "failed"
                              ? "#ef4444"
                              : "var(--fg2)",
                      }}
                    >
                      {session.status}
                    </span>
                  </div>
                </div>

                {/* Expanded: show steps */}
                {isOpen && (
                  <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border)" }}>
                    {session.steps.map((step, idx) => (
                      <div
                        key={idx}
                        style={{
                          display: "flex",
                          gap: 8,
                          alignItems: "flex-start",
                          padding: "4px 0",
                          borderBottom:
                            idx < session.steps.length - 1 ? "1px solid var(--border)" : "none",
                          fontSize: 12,
                        }}
                      >
                        <span style={{ flexShrink: 0 }}>{STAGE_ICONS[step.stage] || "•"}</span>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            <span style={{ fontWeight: 600 }}>{step.stage}</span>
                            <span style={{ color: "var(--fg2)", fontSize: 11 }}>
                              {step.duration_ms}ms
                            </span>
                            {step.llm_calls?.length ? (
                              <span style={{ color: "var(--fg2)", fontSize: 11 }}>
                                {step.llm_calls.length} LLM call
                                {step.llm_calls.length !== 1 ? "s" : ""}
                              </span>
                            ) : null}
                            {step.retrievals?.length ? (
                              <span style={{ color: "var(--fg2)", fontSize: 11 }}>
                                {step.retrievals.length} retrieval
                                {step.retrievals.length !== 1 ? "s" : ""}
                              </span>
                            ) : null}
                          </div>
                          {step.output && (
                            <pre
                              style={{
                                fontSize: 11,
                                color: "var(--fg2)",
                                margin: "4px 0 0",
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-word",
                                maxHeight: 100,
                                overflow: "hidden",
                              }}
                            >
                              {typeof step.output === "string"
                                ? step.output.slice(0, 300)
                                : JSON.stringify(step.output, null, 2).slice(0, 300)}
                            </pre>
                          )}
                        </div>
                      </div>
                    ))}

                    <div style={{ marginTop: 8, textAlign: "right" }}>
                      <Link
                        to="/knowledge"
                        style={{ fontSize: 11, color: "var(--accent)", textDecoration: "none" }}
                      >
                        View full session in Research Playground →
                      </Link>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
