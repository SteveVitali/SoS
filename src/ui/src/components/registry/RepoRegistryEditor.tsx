import { useState } from "react";
import { type RepoConfig, saveRegistry } from "../../api.js";
import { useAppData } from "../../stores/AppDataContext.js";
import { css } from "../../styles/theme.js";
import { PageHeader } from "../shared/PageHeader.js";
import { Spinner } from "../shared/Spinner.js";
import { RepoCard } from "./RepoCard.js";

function emptyRepo(): RepoConfig {
  return {
    clone: "",
    default_branch: "main",
    max_worktrees: 1,
    clean_mode: "light",
    detect: { keywords: [] },
    commands: {},
    pr: { reviewers_default: [], draft_by_default: true },
    ci: { provider: "" },
  };
}

export function RepoRegistryEditor() {
  const { registry: registryState, refreshRegistry, setRegistryLocal } = useAppData();
  const { registry, path: registryPath, loading, error: loadError } = registryState;

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saveMsg, setSaveMsg] = useState("");
  const [dirty, setDirty] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const updateRegistry = (fn: (prev: Record<string, RepoConfig>) => Record<string, RepoConfig>) => {
    if (!registry) return;
    setRegistryLocal({ repos: fn(registry.repos) });
    setDirty(true);
  };

  const handleSave = async () => {
    if (!registry) return;
    setSaving(true);
    setError("");
    setSaveMsg("");
    try {
      await saveRegistry(registry);
      setSaveMsg("Saved");
      setDirty(false);
      setTimeout(() => setSaveMsg(""), 3000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const updateRepo = (id: string, repo: RepoConfig) => {
    updateRegistry((repos) => ({ ...repos, [id]: repo }));
  };

  const renameRepo = (oldId: string, newId: string) => {
    if (!registry || !newId || newId === oldId) return;
    if (registry.repos[newId]) {
      setError(`Repo ID "${newId}" already exists`);
      return;
    }
    updateRegistry((repos) => {
      const entries = Object.entries(repos);
      const newRepos: Record<string, RepoConfig> = {};
      for (const [k, v] of entries) {
        newRepos[k === oldId ? newId : k] = v;
      }
      return newRepos;
    });
    if (expandedId === oldId) setExpandedId(newId);
  };

  const deleteRepo = (id: string) => {
    updateRegistry((repos) => {
      const { [id]: _, ...rest } = repos;
      return rest;
    });
    if (expandedId === id) setExpandedId(null);
  };

  const addRepo = () => {
    if (!registry) return;
    let newId = "new-repo";
    let i = 1;
    while (registry.repos[newId]) {
      newId = `new-repo-${i++}`;
    }
    updateRegistry((repos) => ({ ...repos, [newId]: emptyRepo() }));
    setExpandedId(newId);
  };

  if (loading) return <Spinner label="Loading registry..." />;

  const displayError = error || loadError;
  const repoIds = registry ? Object.keys(registry.repos) : [];

  return (
    <div>
      <PageHeader
        title="Repo Registry"
        count={repoIds.length}
        actions={
          <>
            {registryPath && (
              <span style={{ ...css.mono, fontSize: 11, color: "var(--fg3)" }}>{registryPath}</span>
            )}
            {saveMsg && (
              <span style={{ fontSize: 13, color: "var(--green)", fontWeight: 500 }}>
                {saveMsg}
              </span>
            )}
            <button type="button" style={css.btn} onClick={() => refreshRegistry()}>
              ↻ Reload
            </button>
            <button type="button" style={css.btnPrimary} onClick={addRepo}>
              + Add Repo
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
      {repoIds.length === 0 ? (
        <div style={{ color: "var(--fg2)", padding: 20 }}>
          No repos configured. Click "+ Add Repo" to get started.
        </div>
      ) : (
        repoIds.map((id) => (
          <RepoCard
            key={id}
            id={id}
            repo={registry!.repos[id]}
            expanded={expandedId === id}
            onToggle={() => setExpandedId(expandedId === id ? null : id)}
            onChange={(r) => updateRepo(id, r)}
            onChangeId={renameRepo}
            onDelete={() => deleteRepo(id)}
          />
        ))
      )}
    </div>
  );
}
