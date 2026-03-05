import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createLogger } from "../../shared/logger.js";
import { withRepoLock } from "./repoLock.js";
import type { RepoEntry } from "./repoRegistry.js";

const log = createLogger("worker:workspace");

function exec(cmd: string, cwd?: string): string {
  log.info("exec", { cmd, cwd });
  return execSync(cmd, { cwd, encoding: "utf-8", timeout: 120_000 }).trim();
}

/**
 * Ensure the bare clone exists and is up-to-date.
 * Serialized per-repo via repoLock to prevent concurrent git fetch contention.
 */
export async function ensureClone(workspaceRoot: string, repo: RepoEntry): Promise<string> {
  const cloneDir = path.join(workspaceRoot, "clones", repo.id);

  await withRepoLock(repo.id, () => {
    if (!existsSync(cloneDir)) {
      mkdirSync(path.dirname(cloneDir), { recursive: true });
      log.info("Cloning repo", { repoId: repo.id, url: repo.clone });
      exec(`git clone ${repo.clone} ${cloneDir}`);
    } else {
      log.info("Clone exists, fetching", { repoId: repo.id });
      exec("git fetch origin", cloneDir);
    }
  });

  return cloneDir;
}
