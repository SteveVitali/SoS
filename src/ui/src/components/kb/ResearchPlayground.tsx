import { useState } from "react";
import {
  type KBScope,
  type ResearchResult,
  type ResearchStrategy,
  type ResearchStreamEvent,
  runResearchStreaming,
} from "../../api.js";
import { css } from "../../styles/theme.js";
import { ALL_SCOPES, ScopeToggleButtons, SearchResultCard } from "./kbShared.js";
import { MetricsSummary, ResearchTimeline } from "./ResearchTimeline.js";

const STRATEGY_DESCRIPTIONS: Record<ResearchStrategy, string> = {
  simple: "Fast — HyDE + reranking (2-4s, ~3 LLM calls)",
  deep: "Thorough — decomposition + IRCoT loop + CRAG (5-15s, ~5-10 LLM calls)",
  agent: "Full agent — ReAct tool-use loop (10-30s, ~8-20 LLM calls)",
};

export function ResearchPlayground() {
  const [query, setQuery] = useState("");
  const [scopes, setScopes] = useState<KBScope[]>([...ALL_SCOPES]);
  const [strategy, setStrategy] = useState<ResearchStrategy>("deep");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  const [result, setResult] = useState<ResearchResult | null>(null);
  const [events, setEvents] = useState<ResearchStreamEvent[]>([]);
  const [currentStage, setCurrentStage] = useState<string | null>(null);

  const handleRun = async () => {
    if (!query.trim()) return;
    setRunning(true);
    setError("");
    setResult(null);
    setEvents([]);
    setCurrentStage(null);

    try {
      const res = await runResearchStreaming({ query: query.trim(), scopes, strategy }, (event) => {
        setEvents((prev) => [...prev, event]);
        if (event.type === "step_start") {
          setCurrentStage(event.stage);
        } else if (event.type === "session_complete" || event.type === "session_error") {
          setCurrentStage(null);
        }
      });
      if (res) setResult(res);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRunning(false);
      setCurrentStage(null);
    }
  };

  const toggleScope = (scope: KBScope) => {
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  };

  return (
    <div style={{ ...css.card, marginBottom: 20 }}>
      <h3 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 12px" }}>🔬 Research Playground</h3>
      <p style={{ fontSize: 12, color: "var(--fg2)", margin: "0 0 12px" }}>
        Run the advanced research pipeline with real-time step-by-step visualization.
      </p>

      {/* Strategy selector */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ ...css.label, marginBottom: 6 }}>Strategy</label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(["simple", "deep", "agent"] as ResearchStrategy[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStrategy(s)}
              style={{
                ...css.btnSmall,
                background: strategy === s ? "var(--accent)" : "var(--bg3)",
                color: strategy === s ? "#fff" : "var(--fg2)",
                border: strategy === s ? "1px solid var(--accent)" : "1px solid var(--border)",
              }}
              title={STRATEGY_DESCRIPTIONS[s]}
            >
              {s}
            </button>
          ))}
          <span style={{ fontSize: 11, color: "var(--fg2)", alignSelf: "center", marginLeft: 4 }}>
            {STRATEGY_DESCRIPTIONS[strategy]}
          </span>
        </div>
      </div>

      {/* Scope selector */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ ...css.label, marginBottom: 6 }}>Scopes</label>
        <ScopeToggleButtons scopes={scopes} onToggle={toggleScope} />
      </div>

      {/* Query input */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          style={{ ...css.input, flex: 1 }}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Enter a research query..."
          onKeyDown={(e) => e.key === "Enter" && handleRun()}
        />
        <button
          type="button"
          style={css.btnPrimary}
          disabled={running || !query.trim()}
          onClick={handleRun}
        >
          {running ? "Researching..." : "Research"}
        </button>
      </div>

      {error && <div style={css.error}>{error}</div>}

      {/* Live progress indicator */}
      {running && currentStage && (
        <div
          style={{
            background: "var(--accent)11",
            border: "1px solid var(--accent)33",
            borderRadius: "var(--radius)",
            padding: 10,
            marginBottom: 12,
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>⏳</span>
          <span style={{ color: "var(--accent)", fontWeight: 600 }}>
            {currentStage.replace(/_/g, " ")}
          </span>
          <span style={{ color: "var(--fg2)" }}>
            ({events.filter((e) => e.type === "llm_call").length} LLM calls,{" "}
            {events.filter((e) => e.type === "retrieval").length} retrievals)
          </span>
        </div>
      )}

      {/* Results */}
      {result && (
        <div style={{ marginTop: 8 }}>
          {/* Metrics */}
          <MetricsSummary metrics={result.metrics} />

          {/* Timeline */}
          <div
            style={{
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: 12,
              marginBottom: 12,
            }}
          >
            <h4 style={{ fontSize: 13, fontWeight: 600, margin: "0 0 8px", color: "var(--fg)" }}>
              Pipeline Timeline
            </h4>
            <ResearchTimeline session={result.audit} metrics={result.metrics} />
          </div>

          {/* Retrieved chunks */}
          {result.chunks.length > 0 && (
            <div>
              <h4 style={{ fontSize: 13, fontWeight: 600, margin: "0 0 8px", color: "var(--fg)" }}>
                Retrieved Chunks ({result.chunks.length})
              </h4>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {result.chunks.map((c, i) => (
                  <SearchResultCard key={i} result={c} showKBName />
                ))}
              </div>
            </div>
          )}

          {/* Reasoning trace */}
          {result.reasoning_trace && (
            <div style={{ marginTop: 12 }}>
              <h4 style={{ fontSize: 13, fontWeight: 600, margin: "0 0 8px", color: "var(--fg)" }}>
                Reasoning Trace
              </h4>
              <pre
                style={{
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  padding: 12,
                  fontSize: 12,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  margin: 0,
                  color: "var(--fg)",
                }}
              >
                {result.reasoning_trace}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
