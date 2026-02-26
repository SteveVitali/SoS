import { useCallback, useEffect, useState } from "react";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { getRoutingConfig, reloadRoutingConfig, saveRoutingConfig } from "../../api.js";
import { css } from "../../styles/theme.js";
import { PageHeader } from "../shared/PageHeader.js";
import { Spinner } from "../shared/Spinner.js";
import { ExecutionEditor } from "./ExecutionEditor.js";
import { ParameterListEditor } from "./ParameterListEditor.js";

type ViewMode = "visual" | "yaml";

function ViewModeToggle({
  viewMode,
  onChange,
}: {
  viewMode: ViewMode;
  onChange: (mode: ViewMode) => void;
}) {
  const btnStyle = (active: boolean): React.CSSProperties => ({
    ...css.btnSmall,
    background: active ? "var(--bg2)" : "transparent",
    border: active ? "1px solid var(--border)" : "1px solid transparent",
    fontWeight: active ? 600 : 400,
  });

  return (
    <div
      style={{
        display: "flex",
        gap: 2,
        background: "var(--bg3)",
        borderRadius: "var(--radius)",
        padding: 2,
      }}
    >
      <button
        type="button"
        style={btnStyle(viewMode === "visual")}
        onClick={() => onChange("visual")}
      >
        Visual
      </button>
      <button type="button" style={btnStyle(viewMode === "yaml")} onClick={() => onChange("yaml")}>
        YAML
      </button>
    </div>
  );
}

export function RoutingConfigEditor() {
  const [config, setConfig] = useState<any>(null);
  const [configPath, setConfigPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saveMsg, setSaveMsg] = useState("");
  const [dirty, setDirty] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("visual");
  const [yamlText, setYamlText] = useState("");
  const [expandedAction, setExpandedAction] = useState<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await getRoutingConfig();
      setConfig(res.config);
      setConfigPath(res.path);
      setYamlText(stringifyYaml(res.config, { lineWidth: 120 }));
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
      const dataToSave = viewMode === "yaml" ? parseYaml(yamlText) : config;
      await saveRoutingConfig(dataToSave);
      setSaveMsg("Saved");
      setDirty(false);
      // Refresh to get the canonical version
      const res = await getRoutingConfig();
      setConfig(res.config);
      setYamlText(stringifyYaml(res.config, { lineWidth: 120 }));
      setTimeout(() => setSaveMsg(""), 3000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleReload = async () => {
    try {
      await reloadRoutingConfig();
      await fetchConfig();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const updateConfig = (fn: (prev: any) => any) => {
    setConfig((prev: any) => {
      const next = fn(prev);
      setYamlText(stringifyYaml(next, { lineWidth: 120 }));
      return next;
    });
    setDirty(true);
  };

  const handleYamlChange = (text: string) => {
    setYamlText(text);
    setDirty(true);
    // Try to parse for live preview
    try {
      const parsed = parseYaml(text);
      setConfig(parsed);
      setError("");
    } catch {
      // Invalid YAML — that's ok, will validate on save
    }
  };

  const toggleAction = (name: string) => {
    updateConfig((prev: any) => {
      const section = prev.actions?.[name] != null ? "actions" : "custom_actions";
      return {
        ...prev,
        [section]: {
          ...prev[section],
          [name]: { ...prev[section][name], enabled: !prev[section]?.[name]?.enabled },
        },
      };
    });
  };

  const allActions = config
    ? {
        ...(config.actions || {}),
        ...(config.custom_actions || {}),
      }
    : {};
  const actionNames = Object.keys(allActions);
  const isCustom = (name: string) => config?.custom_actions?.[name] != null;

  if (loading) return <Spinner label="Loading routing config..." />;

  const displayError = error || loadError;

  return (
    <div>
      <PageHeader
        title="Routing Config"
        count={actionNames.length}
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
            <ViewModeToggle viewMode={viewMode} onChange={setViewMode} />
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
          Unsaved changes — click Save to write to disk.
        </div>
      )}

      {viewMode === "yaml" ? (
        <div style={css.field}>
          <textarea
            style={{
              ...css.textarea,
              minHeight: 600,
              fontFamily: "'SF Mono', Monaco, Consolas, monospace",
              fontSize: 12,
              lineHeight: 1.5,
              tabSize: 2,
            }}
            value={yamlText}
            onChange={(e) => handleYamlChange(e.target.value)}
            spellCheck={false}
          />
        </div>
      ) : (
        <>
          {/* System Prompt */}
          <div style={{ ...css.card, marginBottom: 20 }}>
            <div style={css.sectionTitle}>System Prompt</div>
            <p style={{ fontSize: 12, color: "var(--fg3)", marginBottom: 8 }}>
              Steve's personality, guidelines, and routing instructions. Use {"{JOBS_CONTEXT}"} for
              recent jobs context and {"{ACTIONS}"} for auto-generated action list.
            </p>
            <textarea
              style={{ ...css.textarea, minHeight: 200, fontSize: 13 }}
              value={config?.system_prompt || ""}
              onChange={(e) =>
                updateConfig((prev: any) => ({ ...prev, system_prompt: e.target.value }))
              }
              spellCheck={false}
            />
          </div>

          {/* Model */}
          <div style={{ ...css.card, marginBottom: 20 }}>
            <div style={css.sectionTitle}>Model</div>
            <input
              style={{ ...css.input, maxWidth: 400 }}
              value={config?.model || ""}
              onChange={(e) => updateConfig((prev: any) => ({ ...prev, model: e.target.value }))}
              placeholder="claude-sonnet-4-20250514"
            />
          </div>

          {/* Actions */}
          <div style={{ ...css.card, marginBottom: 20 }}>
            <div style={{ ...css.sectionTitle, marginBottom: 12 }}>
              Actions ({actionNames.length})
            </div>
            {actionNames.map((name) => {
              const action = allActions[name];
              const expanded = expandedAction === name;
              const custom = isCustom(name);
              return (
                <div
                  key={name}
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius)",
                    marginBottom: 8,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "10px 14px",
                      background: "var(--bg)",
                      cursor: "pointer",
                    }}
                    onClick={() => setExpandedAction(expanded ? null : name)}
                  >
                    <span style={{ fontSize: 12, color: "var(--fg3)" }}>
                      {expanded ? "▼" : "▶"}
                    </span>
                    <span style={{ ...css.mono, fontWeight: 600, fontSize: 13 }}>{name}</span>
                    {custom && (
                      <span
                        style={{
                          fontSize: 10,
                          padding: "1px 6px",
                          borderRadius: 8,
                          background: "#8b5cf622",
                          color: "#8b5cf6",
                          border: "1px solid #8b5cf644",
                        }}
                      >
                        custom
                      </span>
                    )}
                    <span style={{ fontSize: 12, color: "var(--fg3)", flex: 1 }}>
                      {(action?.description || "").slice(0, 80)}
                    </span>
                    <span
                      style={{
                        ...css.badge(action?.enabled ? "var(--green)" : "var(--fg3)"),
                        cursor: "pointer",
                        userSelect: "none",
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleAction(name);
                      }}
                    >
                      {action?.enabled ? "enabled" : "disabled"}
                    </span>
                  </div>
                  {expanded && (
                    <div style={{ padding: 14, background: "var(--bg2)" }}>
                      <ActionEditor
                        action={action}
                        onChange={(updated) => {
                          const section = custom ? "custom_actions" : "actions";
                          updateConfig((prev: any) => ({
                            ...prev,
                            [section]: { ...prev[section], [name]: updated },
                          }));
                        }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function ActionEditor({ action, onChange }: { action: any; onChange: (updated: any) => void }) {
  const update = (field: string, value: any) => {
    onChange({ ...action, [field]: value });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={css.field}>
        <span style={css.label}>Description</span>
        <textarea
          style={{ ...css.textarea, minHeight: 50 }}
          value={action?.description || ""}
          onChange={(e) => update("description", e.target.value)}
        />
      </div>
      <div style={css.field}>
        <span style={css.label}>Routing Hint</span>
        <textarea
          style={{ ...css.textarea, minHeight: 50 }}
          value={action?.routing_hint || ""}
          onChange={(e) => update("routing_hint", e.target.value)}
        />
      </div>
      <div style={css.field}>
        <ParameterListEditor
          parameters={action?.parameters || {}}
          onChange={(params) => update("parameters", params)}
        />
      </div>
      <div style={css.field}>
        <span style={{ ...css.label, marginBottom: 8 }}>Execution</span>
        <ExecutionEditor
          execution={action?.execution || {}}
          onChange={(exec) => update("execution", exec)}
        />
      </div>
    </div>
  );
}
