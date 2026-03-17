import { useCallback, useEffect, useState } from "react";
import type { MemoryConfig } from "../../api.js";
import { getMemoryConfig, updateMemoryConfig } from "../../api.js";
import { css } from "../../styles/theme.js";
import { Spinner } from "../shared/Spinner.js";
import { WeightSliders } from "./WeightSliders.js";

export function MemoryConfigEditor() {
  const [config, setConfig] = useState<MemoryConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getMemoryConfig();
      setConfig(res.config);
      setDirty(false);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
  }, [fetch]);

  function update<K extends keyof MemoryConfig>(key: K, value: MemoryConfig[K]) {
    if (!config) return;
    setConfig({ ...config, [key]: value });
    setDirty(true);
    setSaveMsg(null);
  }

  async function handleSave() {
    if (!config) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await updateMemoryConfig(config);
      setConfig(res.config);
      setDirty(false);
      setSaveMsg("Configuration saved.");
    } catch (err) {
      setSaveMsg(`Save failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    setSaving(true);
    setSaveMsg(null);
    try {
      // Save empty object to clear all overrides
      const res = await updateMemoryConfig({});
      setConfig(res.config);
      setDirty(false);
      setSaveMsg("Reset to defaults.");
    } catch (err) {
      setSaveMsg(`Reset failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  if (loading || !config) return <Spinner label="Loading config…" />;

  return (
    <div>
      {/* System */}
      <Section title="System">
        <ToggleField
          label="Memory System Enabled"
          value={config.enabled}
          onChange={(v) => update("enabled", v)}
        />
      </Section>

      {/* Extraction */}
      <Section title="Extraction (Pipeline B)">
        <TextField
          label="Extraction Model"
          value={config.extraction_model}
          onChange={(v) => update("extraction_model", v)}
          hint="SOS_MEMORY_MODEL"
        />
        <NumberField
          label="Min Turns"
          value={config.extraction_min_turns}
          onChange={(v) => update("extraction_min_turns", v)}
          hint="Minimum conversation turns before extraction"
        />
        <TextField
          label="Skip Actions"
          value={config.extraction_skip_actions.join(", ")}
          onChange={(v) =>
            update(
              "extraction_skip_actions",
              v
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            )
          }
          hint="Comma-separated routed actions to skip"
        />
        <NumberField
          label="Max Facts per Call"
          value={config.extraction_max_facts_per_call}
          onChange={(v) => update("extraction_max_facts_per_call", v)}
        />
      </Section>

      {/* Retrieval */}
      <Section title="Retrieval (Read Path)">
        <NumberField
          label="Max Memories in Context"
          value={config.retrieval_max_memories}
          onChange={(v) => update("retrieval_max_memories", v)}
          hint="SOS_MEMORY_RETRIEVAL_MAX_MEMORIES"
        />
        <NumberField
          label="Max Tokens"
          value={config.retrieval_max_tokens}
          onChange={(v) => update("retrieval_max_tokens", v)}
          hint="Token budget for {MEMORY_CONTEXT}"
        />
        <NumberField
          label="Min Score"
          value={config.retrieval_min_score}
          onChange={(v) => update("retrieval_min_score", v)}
          step={0.05}
          hint="Minimum composite score threshold (0.0–1.0)"
        />
        <NumberField
          label="Recency Half-life (days)"
          value={config.retrieval_recency_halflife_days}
          onChange={(v) => update("retrieval_recency_halflife_days", v)}
        />
      </Section>

      {/* Scoring Weights */}
      <Section title="Scoring Weights">
        <div style={{ marginBottom: 8, fontSize: 12, color: "var(--fg3)" }}>
          Weights for the composite scoring formula. Should sum to 1.0.
        </div>
        <WeightSliders
          similarity={config.weight_similarity}
          recency={config.weight_recency}
          importance={config.weight_importance}
          access={config.weight_access}
          onChange={(w) => {
            setConfig({
              ...config,
              weight_similarity: w.similarity,
              weight_recency: w.recency,
              weight_importance: w.importance,
              weight_access: w.access,
            });
            setDirty(true);
            setSaveMsg(null);
          }}
        />
      </Section>

      {/* Evolution */}
      <Section title="Evolution (Pipeline E — A-MEM)">
        <ToggleField
          label="Evolution Enabled"
          value={config.evolution_enabled}
          onChange={(v) => update("evolution_enabled", v)}
        />
        <NumberField
          label="Max Neighbors"
          value={config.evolution_max_neighbors}
          onChange={(v) => update("evolution_max_neighbors", v)}
        />
        <NumberField
          label="Link Threshold"
          value={config.evolution_link_threshold}
          onChange={(v) => update("evolution_link_threshold", v)}
          step={0.05}
          hint="Min similarity for memory linking (0.0–1.0)"
        />
      </Section>

      {/* Reflection */}
      <Section title="Reflection (Pipeline D)">
        <ToggleField
          label="Reflection Enabled"
          value={config.reflection_enabled}
          onChange={(v) => update("reflection_enabled", v)}
        />
        <NumberField
          label="Interval (hours)"
          value={config.reflection_interval_hours}
          onChange={(v) => update("reflection_interval_hours", v)}
          hint="Min hours between reflection runs"
        />
        <NumberField
          label="Min Episodes"
          value={config.reflection_min_episodes}
          onChange={(v) => update("reflection_min_episodes", v)}
          hint="Min new episodes to trigger reflection"
        />
      </Section>

      {/* Signals */}
      <Section title="Signals (Pipeline C)">
        <NumberField
          label="Signal Delay (ms)"
          value={config.signal_delay_ms}
          onChange={(v) => update("signal_delay_ms", v)}
          hint="Wait before collecting signals (default: 300000 = 5min)"
        />
        <NumberField
          label="No-Response Timeout (ms)"
          value={config.signal_no_response_timeout_ms}
          onChange={(v) => update("signal_no_response_timeout_ms", v)}
          hint="Timeout for 'no_response' signal (default: 1800000 = 30min)"
        />
      </Section>

      {/* Save bar */}
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginTop: 16,
          paddingTop: 12,
          borderTop: "1px solid var(--border)",
        }}
      >
        <button
          type="button"
          style={css.btnPrimary}
          onClick={handleSave}
          disabled={saving || !dirty}
        >
          {saving ? "Saving…" : "Save Configuration"}
        </button>
        <button type="button" style={css.btnSmall} onClick={handleReset} disabled={saving}>
          Reset to Defaults
        </button>
        {saveMsg && (
          <span
            style={{
              fontSize: 12,
              color: saveMsg.includes("failed") ? "var(--red)" : "var(--green)",
            }}
          >
            {saveMsg}
          </span>
        )}
      </div>
    </div>
  );
}

// --- Helper components ---

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <h3
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: "var(--fg)",
          marginBottom: 10,
          paddingBottom: 4,
          borderBottom: "1px solid var(--border)",
        }}
      >
        {title}
      </h3>
      {children}
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <div style={css.field}>
      <label style={css.label}>{label}</label>
      <input style={css.input} value={value} onChange={(e) => onChange(e.target.value)} />
      {hint && <div style={{ fontSize: 11, color: "var(--fg3)", marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  hint,
  step,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  hint?: string;
  step?: number;
}) {
  return (
    <div style={css.field}>
      <label style={css.label}>{label}</label>
      <input
        type="number"
        step={step}
        style={{ ...css.input, width: 200 }}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <div style={{ fontSize: 11, color: "var(--fg3)", marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

function ToggleField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div style={{ ...css.field, display: "flex", alignItems: "center", gap: 8 }}>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <label style={{ fontSize: 13, color: "var(--fg)" }}>{label}</label>
    </div>
  );
}
