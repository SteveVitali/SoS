import { useCallback, useEffect, useState } from "react";
import {
  getModelConfig,
  type ModelConfigResponse,
  type ModelRoleInfo,
  reloadModelConfig,
  saveModelConfig,
} from "../../api.js";
import { css } from "../../styles/theme.js";
import { PageHeader } from "../shared/PageHeader.js";
import { Spinner } from "../shared/Spinner.js";

const ROLE_ORDER = ["routing", "titleGeneration", "research", "raptorSummarization", "embedding"];

const SOURCE_BADGE: Record<string, { color: string; label: string }> = {
  default: { color: "var(--fg3)", label: "default" },
  file: { color: "#3b82f6", label: "file" },
  env: { color: "#a855f7", label: "env" },
};

function RoleCard({
  roleName,
  role,
  overrideValue,
  onOverrideChange,
}: {
  roleName: string;
  role: ModelRoleInfo;
  overrideValue: string;
  onOverrideChange: (value: string) => void;
}) {
  const badge = SOURCE_BADGE[role.source] || SOURCE_BADGE.default;
  const envIsSet = !!role.envOverride;

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        marginBottom: 12,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "12px 16px",
          background: "var(--bg)",
        }}
      >
        <span style={{ ...css.mono, fontWeight: 600, fontSize: 14, minWidth: 180 }}>
          {roleName}
        </span>
        <span style={{ fontSize: 12, color: "var(--fg3)", flex: 1 }}>{role.description}</span>
        <span style={css.badge(badge.color)}>{badge.label}</span>
      </div>

      <div style={{ padding: "12px 16px", background: "var(--bg2)" }}>
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
          <span style={css.label}>File Override</span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              style={{ ...css.input, maxWidth: 400 }}
              value={overrideValue}
              onChange={(e) => onOverrideChange(e.target.value)}
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
          {envIsSet && (
            <div style={{ fontSize: 11, color: "#f59e0b", marginTop: 4 }}>
              Env var {role.envVar} is set — it takes precedence over file overrides.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

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

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const res: ModelConfigResponse = await getModelConfig();
      setModels(res.models);
      setOverrides(res.overrides);
      setConfigPath(res.path);
      setDirty(false);
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

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
      await saveModelConfig(clean);
      setSaveMsg("Saved");
      setDirty(false);
      // Re-fetch to get canonical state (overrides + resolved models)
      const fresh = await getModelConfig();
      setModels(fresh.models);
      setOverrides(fresh.overrides);
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
        <strong style={{ color: "var(--fg2)" }}>Precedence:</strong> Environment variable &gt; File
        override (model-config.yaml) &gt; Hardcoded default / inheritance
      </div>

      {/* Role cards */}
      {models &&
        roleNames.map((roleName) => (
          <RoleCard
            key={roleName}
            roleName={roleName}
            role={models[roleName]}
            overrideValue={overrides[roleName] || ""}
            onOverrideChange={(value) => handleOverrideChange(roleName, value)}
          />
        ))}
    </div>
  );
}
