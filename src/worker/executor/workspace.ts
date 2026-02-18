import { execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import { createLogger } from "../../shared/logger.js";
import type { RepoEntry } from "./repoRegistry.js";

const log = createLogger("worker:workspace");

function exec(cmd: string, cwd?: string): string {
  log.info("exec", { cmd, cwd });
  return execSync(cmd, { cwd, encoding: "utf-8", timeout: 120_000 }).trim();
}

export function ensureClone(workspaceRoot: string, repo: RepoEntry): string {
  const cloneDir = path.join(workspaceRoot, "clones", repo.id);

  if (!existsSync(cloneDir)) {
    mkdirSync(path.dirname(cloneDir), { recursive: true });
    log.info("Cloning repo", { repoId: repo.id, url: repo.clone });
    exec(`git clone ${repo.clone} ${cloneDir}`);
  } else {
    log.info("Clone exists, fetching", { repoId: repo.id });
    exec("git fetch origin", cloneDir);
  }

  return cloneDir;
}
