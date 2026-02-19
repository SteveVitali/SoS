import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("worker:repoRegistry");

export type CleanMode = "light" | "full";

export interface RepoEntry {
  id: string;
  clone: string;
  default_branch: string;
  max_worktrees: number;
  clean_mode: CleanMode;
  detect?: { keywords?: string[] };
  commands?: {
    lint?: string[];
    test_fast?: string[];
    test_full?: string[];
  };
  pr?: {
    reviewers_default?: string[];
    draft_by_default?: boolean;
  };
  ci?: {
    provider?: string;
  };
}

export interface RepoRegistry {
  repos: Map<string, RepoEntry>;
}

/** Match a GitHub owner/repo (e.g. "foursquare/fsq-graph") against a clone URL. */
function cloneUrlMatches(cloneUrl: string, owner: string, repo: string): boolean {
  // SSH: git@github.com:foursquare/fsq-graph.git
  // HTTPS: https://github.com/foursquare/fsq-graph.git
  const normalized = cloneUrl.replace(/\.git$/, "").toLowerCase();
  const needle = `${owner}/${repo}`.toLowerCase();
  return normalized.endsWith(needle);
}

/** Find a repo registry entry matching a GitHub PR URL's owner/repo. */
export function findRepoByGitHubUrl(
  registry: RepoRegistry,
  owner: string,
  repo: string,
): RepoEntry | null {
  for (const entry of registry.repos.values()) {
    if (cloneUrlMatches(entry.clone, owner, repo)) return entry;
  }
  // Fallback: try matching by repo ID (e.g. "fsq-graph")
  const byId = registry.repos.get(repo);
  if (byId) return byId;
  return null;
}

export function loadRegistry(path: string): RepoRegistry {
  try {
    const raw = readFileSync(path, "utf-8");
    const data = parseYaml(raw);
    const repos = new Map<string, RepoEntry>();

    if (data?.repos) {
      for (const [id, entry] of Object.entries(data.repos)) {
        const e = entry as any;
        repos.set(id, {
          id,
          clone: e.clone,
          default_branch: e.default_branch || "main",
          max_worktrees: typeof e.max_worktrees === "number" ? e.max_worktrees : 1,
          clean_mode: e.clean_mode === "full" ? "full" : "light",
          detect: e.detect,
          commands: e.commands,
          pr: e.pr
            ? {
                reviewers_default: e.pr.reviewers_default,
                draft_by_default: e.pr.draft_by_default ?? true,
              }
            : { draft_by_default: true },
          ci: e.ci,
        });
      }
    }

    log.info("Repo registry loaded", { count: repos.size, path });
    return { repos };
  } catch (err: any) {
    log.error("Failed to load repo registry", { path, error: err.message });
    return { repos: new Map() };
  }
}
