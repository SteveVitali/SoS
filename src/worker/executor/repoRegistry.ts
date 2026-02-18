import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("worker:repoRegistry");

export interface RepoEntry {
  id: string;
  clone: string;
  default_branch: string;
  detect?: { keywords?: string[] };
  commands?: {
    lint?: string[];
    test_fast?: string[];
    test_full?: string[];
  };
  pr?: {
    reviewers_default?: string[];
  };
  ci?: {
    provider?: string;
  };
}

export interface RepoRegistry {
  repos: Map<string, RepoEntry>;
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
          detect: e.detect,
          commands: e.commands,
          pr: e.pr,
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
