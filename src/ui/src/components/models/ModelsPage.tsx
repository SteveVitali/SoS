import type React from "react";
import { useCallback, useEffect, useState } from "react";
import {
  fetchAvailableModels,
  getModelConfig,
  type ModelConfigResponse,
  type ModelRoleInfo,
  type ProviderResolved,
  type ProviderSettings,
  reloadModelConfig,
  saveModelConfig,
} from "../../api.js";
import { css } from "../../styles/theme.js";
import { PageHeader } from "../shared/PageHeader.js";
import { Spinner } from "../shared/Spinner.js";
import { ModelAutocomplete } from "./ModelAutocomplete.js";

const ROLE_ORDER = ["routing", "titleGeneration", "research", "raptorSummarization", "embedding"];

const SOURCE_BADGE: Record<string, { color: string; label: string }> = {
  default: { color: "var(--fg3)", label: "default" },
  file: { color: "#3b82f6", label: "file" },
  env: { color: "#a855f7", label: "env" },
};

/** Reusable card with a header row and a body section. */
function CardSection({
  header,
  children,
  style,
}: {
  header: React.ReactNode;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        marginBottom: 12,
        ...style,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "12px 16px",
          background: "var(--bg)",
          borderRadius: "var(--radius) var(--radius) 0 0",
        }}
      >
        {header}
      </div>
      <div
        style={{
          padding: "12px 16px",
          background: "var(--bg2)",
          borderRadius: "0 0 var(--radius) var(--radius)",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function RoleCard({
  roleName,
  role,
  overrideValue,
  onOverrideChange,
  availableModels,
  modelsLoading,
}: {
  roleName: string;
  role: ModelRoleInfo;
  overrideValue: string;
  onOverrideChange: (value: string) => void;
  availableModels: string[];
  modelsLoading: boolean;
}) {
  const badge = SOURCE_BADGE[role.source] || SOURCE_BADGE.default;
  const envIsSet = !!role.envOverride;

  return (
    <CardSection
      header={
        <>
          <span style={{ ...css.mono, fontWeight: 600, fontSize: 14, minWidth: 180 }}>
            {roleName}
          </span>
          <span style={{ fontSize: 12, color: "var(--fg3)", flex: 1 }}>{role.description}</span>
          <span style={css.badge(badge.color)}>{badge.label}</span>
        </>
      }
    >
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        {/* Effective model */}
        <div style={{ flex: 1, minWidth: 200 }}>
          <span style={css.label}>Effective Model</span>
          <div
            style={{
              ...css.mono,
              fontSize: 13,
              fontWeight: 600,
              color: "var(--fg)",
              marginTop: 2,
            }}
          >
            {role.model}
          </div>
        </div>

        {/* Default */}
        <div style={{ minWidth: 200 }}>
          <span style={css.label}>Default</span>
          <div style={{ ...css.mono, fontSize: 12, color: "var(--fg3)", marginTop: 2 }}>
            {role.default}
          </div>
        </div>

        {/* Env var */}
        <div style={{ minWidth: 200 }}>
          <span style={css.label}>Env Var</span>
          <div style={{ ...css.mono, fontSize: 12, color: "var(--fg3)", marginTop: 2 }}>
            {role.envVar}
            {envIsSet && (
              <span
                style={{
                  marginLeft: 6,
                  fontSize: 10,
                  padding: "1px 6px",
                  borderRadius: 8,
                  background: "#a855f722",
                  color: "#a855f7",
                  border: "1px solid #a855f744",
                }}
              >
                set
              </span>
            )}
          </div>
        </div>
      </div>

      {/* File override input */}
      <div style={{ marginTop: 12 }}>
        <span style={css.label}>File Override (highest priority)</span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <ModelAutocomplete
            value={overrideValue}
            onChange={onOverrideChange}
            models={availableModels}
            loading={modelsLoading}
            placeholder={`Enter model name to override ${roleName}...`}
          />
          {overrideValue && (
            <button
              type="button"
              style={{ ...css.btnSmall, color: "var(--fg3)" }}
              onClick={() => onOverrideChange("")}
              title="Clear override"
            >
              Clear
            </button>
          )}
        </div>
        {envIsSet && overrideValue && (
          <div style={{ fontSize: 11, color: "var(--fg3)", marginTop: 4 }}>
            File override takes precedence over env var {role.envVar}.
          </div>
        )}
      </div>
    </CardSection>
  );
}

const PROVIDER_OPTIONS: { value: string; label: string }[] = [
  { value: "openai_compatible", label: "OpenAI-compatible (LiteLLM)" },
  { value: "anthropic", label: "Anthropic (direct)" },
];

export function ModelsPage() {
  const [models, setModels] = useState<Record<string, ModelRoleInfo> | null>(null);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [configPath, setConfigPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saveMsg, setSaveMsg] = useState("");
  const [dirty, setDirty] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [provider, setProvider] = useState<ProviderSettings>({});
  const [providerResolved, setProviderResolved] = useState<ProviderResolved | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const res: ModelConfigResponse = await getModelConfig();
      setModels(res.models);
      setOverrides(res.overrides);
      setConfigPath(res.path);
      setProvider(res.provider || {});
      setProviderResolved(res.providerResolved || null);
      setDirty(false);
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshAvailableModels = useCallback(() => {
    setModelsLoading(true);
    fetchAvailableModels()
      .then((res) => setAvailableModels(res.models || []))
      .catch(() => setAvailableModels([]))
      .finally(() => setModelsLoading(false));
  }, []);

  useEffect(() => {
    fetchConfig();
    refreshAvailableModels();
  }, [fetchConfig, refreshAvailableModels]);

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setSaveMsg("");
    try {
      // Filter out empty values before saving
      const clean: Record<string, string> = {};
      for (const [key, val] of Object.entries(overrides)) {
        if (val.trim()) clean[key] = val.trim();
      }
      await saveModelConfig(clean, provider);
      setSaveMsg("Saved");
      setDirty(false);
      // Re-fetch to get canonical state (overrides + resolved models)
      const fresh = await getModelConfig();
      setModels(fresh.models);
      setOverrides(fresh.overrides);
      setProvider(fresh.provider || {});
      setProviderResolved(fresh.providerResolved || null);
      // Re-fetch available models since provider may have changed
      refreshAvailableModels();
      setTimeout(() => setSaveMsg(""), 3000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleReload = async () => {
    try {
      await reloadModelConfig();
      await fetchConfig();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleOverrideChange = (roleName: string, value: string) => {
    setOverrides((prev) => ({ ...prev, [roleName]: value }));
    setDirty(true);
  };

  const handleProviderChange = (field: keyof ProviderSettings, value: string) => {
    setProvider((prev) => ({ ...prev, [field]: value || undefined }));
    setDirty(true);
  };

  if (loading) return <Spinner label="Loading model config..." />;

  const displayError = error || loadError;
  const roleNames = ROLE_ORDER.filter((r) => models?.[r]);

  return (
    <div>
      <PageHeader
        title="Model Config"
        count={roleNames.length}
        actions={
          <>
            {configPath && (
              <span style={{ ...css.mono, fontSize: 11, color: "var(--fg3)" }}>{configPath}</span>
            )}
            {saveMsg && (
              <span style={{ fontSize: 13, color: "var(--green)", fontWeight: 500 }}>
                {saveMsg}
              </span>
            )}
            <button type="button" style={css.btn} onClick={handleReload}>
              ↻ Reload
            </button>
            <button
              type="button"
              style={{
                ...css.btnPrimary,
                opacity: dirty ? 1 : 0.5,
                background: dirty ? "var(--accent)" : "var(--bg3)",
                color: dirty ? "#fff" : "var(--fg3)",
              }}
              disabled={!dirty || saving}
              onClick={handleSave}
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </>
        }
      />
      {displayError && <div style={{ ...css.error, marginBottom: 12 }}>{displayError}</div>}
      {dirty && (
        <div
          style={{
            padding: "8px 12px",
            marginBottom: 12,
            borderRadius: "var(--radius)",
            background: "#f59e0b22",
            border: "1px solid #f59e0b44",
            color: "#f59e0b",
            fontSize: 13,
          }}
        >
          Unsaved changes — click Save to write to model-config.yaml.
        </div>
      )}

      {/* Precedence info */}
      <div
        style={{
          padding: "10px 14px",
          marginBottom: 16,
          borderRadius: "var(--radius)",
          background: "var(--bg2)",
          border: "1px solid var(--border)",
          fontSize: 12,
          color: "var(--fg3)",
        }}
      >
        <strong style={{ color: "var(--fg2)" }}>Precedence:</strong> File override
        (model-config.yaml) &gt; Environment variable &gt; Hardcoded default / inheritance
      </div>

      {/* Provider settings */}
      <CardSection
        style={{ marginBottom: 16 }}
        header={
          <>
            <span style={{ ...css.mono, fontWeight: 600, fontSize: 14 }}>LLM Provider</span>
            <span style={{ fontSize: 12, color: "var(--fg3)", flex: 1 }}>
              Connection settings for the LLM API
            </span>
            {providerResolved && (
              <span
                style={css.badge(
                  SOURCE_BADGE[providerResolved.source.provider]?.color || "var(--fg3)",
                )}
              >
                {providerResolved.source.provider}
              </span>
            )}
          </>
        }
      >
        {providerResolved && (
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 12 }}>
            <div>
              <span style={css.label}>Effective Provider</span>
              <div style={{ ...css.mono, fontSize: 13, fontWeight: 600, marginTop: 2 }}>
                {providerResolved.provider}
              </div>
            </div>
            <div>
              <span style={css.label}>Effective Base URL</span>
              <div style={{ ...css.mono, fontSize: 12, color: "var(--fg3)", marginTop: 2 }}>
                {providerResolved.base_url || "(not set)"}
              </div>
            </div>
            <div>
              <span style={css.label}>API Key</span>
              <div style={{ ...css.mono, fontSize: 12, color: "var(--fg3)", marginTop: 2 }}>
                {providerResolved.api_key_set ? "***" : "(not set)"}
                {providerResolved.api_key_set && (
                  <span style={{ marginLeft: 6, ...css.badge("#22c55e") }}>
                    {providerResolved.source.api_key}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <span style={css.label}>Provider</span>
            <select
              style={{ ...css.input, maxWidth: 280, cursor: "pointer" }}
              value={provider.provider || ""}
              onChange={(e) => handleProviderChange("provider", e.target.value)}
            >
              <option value="">Default (openai_compatible)</option>
              {PROVIDER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 250 }}>
            <span style={css.label}>Base URL</span>
            <input
              style={{ ...css.input, width: "100%" }}
              value={provider.base_url || ""}
              onChange={(e) => handleProviderChange("base_url", e.target.value)}
              placeholder="https://litellm.example.com"
            />
          </div>
          <div style={{ minWidth: 200 }}>
            <span style={css.label}>API Key</span>
            <input
              style={{ ...css.input, maxWidth: 280 }}
              type="password"
              value={provider.api_key || ""}
              onChange={(e) => handleProviderChange("api_key", e.target.value)}
              placeholder="sk-..."
            />
          </div>
        </div>
        <div style={{ fontSize: 11, color: "var(--fg3)", marginTop: 6 }}>
          Env vars: SOS_LLM_PROVIDER, SOS_LLM_BASE_URL, SOS_LLM_API_KEY
        </div>
      </CardSection>

      {/* Role cards */}
      {models &&
        roleNames.map((roleName) => (
          <RoleCard
            key={roleName}
            roleName={roleName}
            role={models[roleName]}
            overrideValue={overrides[roleName] || ""}
            onOverrideChange={(value) => handleOverrideChange(roleName, value)}
            availableModels={availableModels}
            modelsLoading={modelsLoading}
          />
        ))}
    </div>
  );
}
