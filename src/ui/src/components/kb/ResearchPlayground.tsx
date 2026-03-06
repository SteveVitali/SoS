import { useState } from "react";
import {
  type ResearchResult,
  type ResearchStrategy,
  type ResearchStreamEvent,
  runResearchStreaming,
} from "../../api.js";
import { css } from "../../styles/theme.js";
import {
  CollapsibleSection,
  ExpandableText,
  ScopeToggleButtons,
  SearchResultCard,
  useToggleScopes,
} from "./kbShared.js";
import { MetricsSummary, ResearchTimeline } from "./ResearchTimeline.js";

const STRATEGY_DESCRIPTIONS: Record<ResearchStrategy, string> = {
  simple: "Fast — HyDE + reranking (2-4s, ~3 LLM calls)",
  deep: "Thorough — decomposition + IRCoT loop + CRAG (5-15s, ~5-10 LLM calls)",
  agent: "Full agent — ReAct tool-use loop (10-30s, ~8-20 LLM calls)",
};

const RESEARCH_MODELS = [
  { value: "", label: "Default (env)" },
  { value: "bedrock/amazon.nova-pro-v1:0", label: "Amazon Nova Pro" },
  { value: "bedrock/amazon.nova-lite-v1:0", label: "Amazon Nova Lite" },
  { value: "bedrock/amazon.nova-micro-v1:0", label: "Amazon Nova Micro" },
  { value: "gpt-4o-mini", label: "gpt-4o-mini" },
  { value: "gpt-4o", label: "gpt-4o" },
  { value: "claude-3-5-haiku-latest", label: "Claude 3.5 Haiku" },
  { value: "claude-3-5-sonnet-latest", label: "Claude 3.5 Sonnet" },
];

export function ResearchPlayground() {
  const [query, setQuery] = useState("");
  const { scopes, toggle: toggleScope } = useToggleScopes();
  const [strategy, setStrategy] = useState<ResearchStrategy>("deep");
  const [model, setModel] = useState("");
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
      const config_overrides = model ? { model } : undefined;
      const res = await runResearchStreaming(
        { query: query.trim(), scopes, strategy, config_overrides },
        (event) => {
          setEvents((prev) => [...prev, event]);
          if (event.type === "step_start") {
            setCurrentStage(event.stage);
          } else if (event.type === "session_complete" || event.type === "session_error") {
            setCurrentStage(null);
          }
        },
      );
      if (res) setResult(res);
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
      setCurrentStage(null);
    }
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

      {/* Model selector */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ ...css.label, marginBottom: 6 }}>Research LLM Model</label>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          style={{
            ...css.input,
            width: "auto",
            minWidth: 200,
            cursor: "pointer",
          }}
        >
          {RESEARCH_MODELS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
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

          {/* Retrieved chunks (collapsible) */}
          {result.chunks.length > 0 && (
            <CollapsibleSection
              title={`Retrieved Chunks (${result.chunks.length})`}
              defaultOpen={false}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {result.chunks.map((c, i) => (
                  <SearchResultCard key={i} result={c} showKBName />
                ))}
              </div>
            </CollapsibleSection>
          )}

          {/* Reasoning trace (collapsible) */}
          {result.reasoning_trace && (
            <CollapsibleSection title="Reasoning Trace" defaultOpen={false}>
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
            </CollapsibleSection>
          )}

          {/* Final answer */}
          {result.context && (
            <CollapsibleSection title="📋 Synthesized Answer" defaultOpen>
              <div
                style={{
                  background: "var(--bg)",
                  border: "1px solid var(--accent)44",
                  borderRadius: "var(--radius)",
                  padding: 12,
                }}
              >
                <ExpandableText text={result.context} />
              </div>
            </CollapsibleSection>
          )}
        </div>
      )}
    </div>
  );
}
