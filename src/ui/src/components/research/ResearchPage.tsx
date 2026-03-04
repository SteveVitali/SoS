import { useCallback, useEffect, useState } from "react";
import { getRoutingConfig, type ResearchStrategy, saveRoutingConfig } from "../../api.js";
import { css } from "../../styles/theme.js";
import { ResearchHistory } from "../kb/ResearchHistory.js";
import { ResearchPlayground } from "../kb/ResearchPlayground.js";
import { StrategyComparison } from "../kb/StrategyComparison.js";
import { PageHeader } from "../shared/PageHeader.js";

const STRATEGY_OPTIONS: Array<{ value: ResearchStrategy | ""; label: string; desc: string }> = [
  {
    value: "",
    label: "Off (basic vector search)",
    desc: "Use basic vector search for KB context in chat/Slack",
  },
  { value: "simple", label: "Simple", desc: "Fast — HyDE + reranking (~2-4s, ~3 LLM calls)" },
  {
    value: "deep",
    label: "Deep",
    desc: "Thorough — decomposition + IRCoT + CRAG (~5-15s, ~5-10 LLM calls)",
  },
  {
    value: "agent",
    label: "Agent",
    desc: "Full agent — ReAct tool-use loop (~10-30s, ~8-20 LLM calls)",
  },
];

const MODEL_OPTIONS = [
  { value: "", label: "Default (bedrock/amazon.nova-pro-v1:0)" },
  { value: "bedrock/amazon.nova-pro-v1:0", label: "Amazon Nova Pro" },
  { value: "bedrock/amazon.nova-lite-v1:0", label: "Amazon Nova Lite" },
  { value: "bedrock/amazon.nova-micro-v1:0", label: "Amazon Nova Micro" },
  { value: "gpt-4o-mini", label: "gpt-4o-mini" },
  { value: "gpt-4o", label: "gpt-4o" },
  { value: "claude-3-5-haiku-latest", label: "Claude 3.5 Haiku" },
  { value: "claude-3-5-sonnet-latest", label: "Claude 3.5 Sonnet" },
];

export function ResearchPage() {
  // Global config state
  const [configLoading, setConfigLoading] = useState(true);
  const [configSaving, setConfigSaving] = useState(false);
  const [configError, setConfigError] = useState("");
  const [configSuccess, setConfigSuccess] = useState("");

  // biome-ignore lint/suspicious/noExplicitAny: dynamic routing config
  const [routingConfig, setRoutingConfig] = useState<any>(null);

  // Editable fields
  const [chatStrategy, setChatStrategy] = useState<ResearchStrategy | "">("");
  const [maxTokens, setMaxTokens] = useState<number>(4000);
  const [dirty, setDirty] = useState(false);

  const loadConfig = useCallback(async () => {
    setConfigLoading(true);
    setConfigError("");
    try {
      const { config } = await getRoutingConfig();
      setRoutingConfig(config);
      setChatStrategy(config.kb_research_strategy || "");
      setMaxTokens(config.kb_context_max_tokens || 4000);
    } catch (err: unknown) {
      setConfigError((err as Error).message);
    } finally {
      setConfigLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // Clear success message after 3s
  useEffect(() => {
    if (!configSuccess) return;
    const t = setTimeout(() => setConfigSuccess(""), 3000);
    return () => clearTimeout(t);
  }, [configSuccess]);

  const handleSaveConfig = async () => {
    if (!routingConfig) return;
    setConfigSaving(true);
    setConfigError("");
    setConfigSuccess("");
    try {
      const updated = { ...routingConfig };
      if (chatStrategy) {
        updated.kb_research_strategy = chatStrategy;
      } else {
        delete updated.kb_research_strategy;
      }
      updated.kb_context_max_tokens = maxTokens;
      await saveRoutingConfig(updated);
      setRoutingConfig(updated);
      setDirty(false);
      setConfigSuccess("Saved");
    } catch (err: unknown) {
      setConfigError((err as Error).message);
    } finally {
      setConfigSaving(false);
    }
  };

  return (
    <div>
      <PageHeader title="Research" />

      {/* Global Config Controls */}
      <div style={{ ...css.card, marginBottom: 20 }}>
        <h3 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 4px" }}>Global Research Config</h3>
        <p style={{ fontSize: 12, color: "var(--fg2)", margin: "0 0 16px" }}>
          Controls how Son of Steve uses the research pipeline for chat and Slack KB context
          injection. These settings are persisted in{" "}
          <code style={{ fontSize: 11 }}>routing-config.yaml</code>.
        </p>

        {configLoading ? (
          <div style={{ fontSize: 13, color: "var(--fg2)" }}>Loading config...</div>
        ) : (
          <>
            {configError && <div style={{ ...css.error, marginBottom: 12 }}>{configError}</div>}

            <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 16 }}>
              {/* Chat/Slack research strategy */}
              <div style={{ flex: "1 1 280px", minWidth: 220 }}>
                <label style={{ ...css.label, marginBottom: 6 }}>Chat / Slack KB Strategy</label>
                <select
                  value={chatStrategy}
                  onChange={(e) => {
                    setChatStrategy(e.target.value as ResearchStrategy | "");
                    setDirty(true);
                  }}
                  style={{ ...css.input, width: "100%", cursor: "pointer" }}
                >
                  {STRATEGY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <div style={{ fontSize: 11, color: "var(--fg2)", marginTop: 4 }}>
                  {STRATEGY_OPTIONS.find((o) => o.value === chatStrategy)?.desc}
                </div>
              </div>

              {/* Max context tokens */}
              <div style={{ flex: "0 1 180px", minWidth: 140 }}>
                <label style={{ ...css.label, marginBottom: 6 }}>Max Context Tokens</label>
                <input
                  type="number"
                  style={{ ...css.input, width: "100%" }}
                  value={maxTokens}
                  min={500}
                  max={32000}
                  step={500}
                  onChange={(e) => {
                    setMaxTokens(Number(e.target.value));
                    setDirty(true);
                  }}
                />
                <div style={{ fontSize: 11, color: "var(--fg2)", marginTop: 4 }}>
                  Token budget for KB context in LLM calls
                </div>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button
                type="button"
                style={css.btnPrimary}
                disabled={!dirty || configSaving}
                onClick={handleSaveConfig}
              >
                {configSaving ? "Saving..." : "Save Config"}
              </button>
              {dirty && <span style={{ fontSize: 12, color: "var(--fg2)" }}>Unsaved changes</span>}
              {configSuccess && (
                <span style={{ fontSize: 12, color: "#22c55e", fontWeight: 600 }}>
                  {configSuccess}
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {/* Research Playground */}
      <ResearchPlayground />

      {/* Strategy Comparison */}
      <StrategyComparison />

      {/* Research History */}
      <ResearchHistory />
    </div>
  );
}
