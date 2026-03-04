import { useState } from "react";
import type { ResearchMetrics, ResearchSession, ResearchStep } from "../../api.js";

const STAGE_ICONS: Record<string, string> = {
  query_analysis: "🔍",
  query_expansion: "🔀",
  retrieval: "📥",
  evaluation: "⚖️",
  reasoning: "🧠",
  synthesis: "📝",
};

const STAGE_LABELS: Record<string, string> = {
  query_analysis: "Query Analysis",
  query_expansion: "Query Expansion",
  retrieval: "Retrieval",
  evaluation: "Evaluation",
  reasoning: "Reasoning",
  synthesis: "Synthesis",
};

function StepDetail({ step }: { step: ResearchStep }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      style={{
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: 10,
        marginTop: 6,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          cursor: "pointer",
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 16 }}>{STAGE_ICONS[step.stage] || "▪"}</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>
            {STAGE_LABELS[step.stage] || step.stage}
          </span>
          {step.iteration > 0 && (
            <span
              style={{
                fontSize: 10,
                padding: "1px 5px",
                borderRadius: 4,
                background: "var(--accent)22",
                color: "var(--accent)",
              }}
            >
              iter {step.iteration + 1}
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "var(--fg2)" }}>{step.duration_ms}ms</span>
          {step.llm_calls.length > 0 && (
            <span style={{ fontSize: 10, color: "var(--fg2)" }}>{step.llm_calls.length} LLM</span>
          )}
          {step.retrieval_calls.length > 0 && (
            <span style={{ fontSize: 10, color: "var(--fg2)" }}>
              {step.retrieval_calls.length} retrieval
            </span>
          )}
          <span style={{ fontSize: 12, color: "var(--fg2)" }}>{expanded ? "▼" : "▶"}</span>
        </div>
      </div>

      {expanded && (
        <div style={{ marginTop: 10, fontSize: 12 }}>
          {/* Output summary */}
          {step.output && Object.keys(step.output).length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontWeight: 600, color: "var(--fg2)", marginBottom: 4 }}>Output</div>
              <pre
                style={{
                  background: "var(--bg2)",
                  padding: 8,
                  borderRadius: 4,
                  fontSize: 11,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  margin: 0,
                  color: "var(--fg)",
                }}
              >
                {JSON.stringify(step.output, null, 2)}
              </pre>
            </div>
          )}

          {/* LLM calls */}
          {step.llm_calls.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontWeight: 600, color: "var(--fg2)", marginBottom: 4 }}>LLM Calls</div>
              {step.llm_calls.map((call) => (
                <div
                  key={call.call_id}
                  style={{
                    background: "var(--bg2)",
                    padding: 8,
                    borderRadius: 4,
                    marginBottom: 4,
                    fontSize: 11,
                  }}
                >
                  <div
                    style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}
                  >
                    <span style={{ fontWeight: 600 }}>{call.purpose}</span>
                    <span style={{ color: "var(--fg2)" }}>
                      {call.model} · {call.duration_ms}ms
                      {call.cost_usd ? ` · $${call.cost_usd.toFixed(4)}` : ""}
                    </span>
                  </div>
                  <div style={{ color: "var(--fg2)" }}>
                    {call.prompt_tokens} in / {call.completion_tokens} out
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Retrieval calls */}
          {step.retrieval_calls.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, color: "var(--fg2)", marginBottom: 4 }}>
                Retrieval Calls
              </div>
              {step.retrieval_calls.map((call) => (
                <div
                  key={call.call_id}
                  style={{
                    background: "var(--bg2)",
                    padding: 8,
                    borderRadius: 4,
                    marginBottom: 4,
                    fontSize: 11,
                  }}
                >
                  <div
                    style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}
                  >
                    <span style={{ fontWeight: 600 }}>
                      [{call.query_type}] {call.query_text.slice(0, 80)}
                      {call.query_text.length > 80 ? "..." : ""}
                    </span>
                    <span style={{ color: "var(--fg2)" }}>{call.duration_ms}ms</span>
                  </div>
                  <div style={{ color: "var(--fg2)" }}>
                    {call.results_count} results · top score: {(call.top_score * 100).toFixed(1)}%
                    {call.kb_ids_searched.length > 0 && ` · ${call.kb_ids_searched.length} KBs`}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function MetricsSummary({ metrics }: { metrics: ResearchMetrics }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 16,
        flexWrap: "wrap",
        fontSize: 12,
        color: "var(--fg2)",
        padding: "8px 0",
      }}
    >
      <span>
        <strong style={{ color: "var(--fg)" }}>{metrics.total_duration_ms}ms</strong> total
      </span>
      <span>
        <strong style={{ color: "var(--fg)" }}>{metrics.iterations}</strong> iteration
        {metrics.iterations !== 1 ? "s" : ""}
      </span>
      <span>
        <strong style={{ color: "var(--fg)" }}>{metrics.llm_calls}</strong> LLM calls
      </span>
      <span>
        <strong style={{ color: "var(--fg)" }}>{metrics.retrieval_calls}</strong> retrievals
      </span>
      <span>
        <strong style={{ color: "var(--fg)" }}>{metrics.chunks_used}</strong>/
        {metrics.chunks_retrieved} chunks used
      </span>
      <span>
        <strong style={{ color: "var(--fg)" }}>
          {metrics.prompt_tokens + metrics.completion_tokens}
        </strong>{" "}
        tokens
      </span>
      <span>
        <strong style={{ color: "var(--fg)" }}>${metrics.estimated_cost_usd.toFixed(4)}</strong>{" "}
        est. cost
      </span>
    </div>
  );
}

function statusColor(status: string): string {
  switch (status) {
    case "completed":
      return "#22c55e";
    case "failed":
      return "#ef4444";
    case "budget_exhausted":
      return "#eab308";
    case "running":
      return "#3b82f6";
    default:
      return "var(--fg2)";
  }
}

export function ResearchTimeline({
  session,
  metrics,
}: {
  session: ResearchSession;
  metrics?: ResearchMetrics;
}) {
  return (
    <div>
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span
            style={{
              fontSize: 11,
              padding: "2px 8px",
              borderRadius: 4,
              fontWeight: 600,
              background: `${statusColor(session.status)}22`,
              color: statusColor(session.status),
            }}
          >
            {session.status}
          </span>
          <span
            style={{
              fontSize: 11,
              padding: "2px 8px",
              borderRadius: 4,
              background: "var(--accent)22",
              color: "var(--accent)",
              fontWeight: 600,
            }}
          >
            {session.config.strategy}
          </span>
        </div>
        <span style={{ fontSize: 11, color: "var(--fg2)" }}>{session.session_id.slice(0, 8)}</span>
      </div>

      {/* Metrics */}
      {metrics && <MetricsSummary metrics={metrics} />}

      {/* Steps */}
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {session.steps.map((step) => (
          <StepDetail key={step.step_id} step={step} />
        ))}
      </div>
    </div>
  );
}
