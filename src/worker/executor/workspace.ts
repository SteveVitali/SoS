import { execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import { createLogger } from "../../shared/logger.js";
import type { RepoEntry } from "./repoRegistry.js";

const log = createLogger("worker:workspace");

export interface WorkspaceInfo {
  worktreePath: string;
  branch: string;
  clonePath: string;
}

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

export function createWorktree(
  workspaceRoot: string,
  workerId: string,
  taskId: string,
  repo: RepoEntry,
  branch: string,
  clonePath: string
): WorkspaceInfo {
  const worktreeBase = path.join(workspaceRoot, "worktrees", workerId, taskId);
  const worktreePath = path.join(worktreeBase, repo.id);

  if (existsSync(worktreePath)) {
    log.info("Worktree already exists", { path: worktreePath });
    return { worktreePath, branch, clonePath };
  }

  mkdirSync(worktreeBase, { recursive: true });

  log.info("Creating worktree", { branch, path: worktreePath });

  // Check if branch already exists (e.g. retry of a previously claimed job)
  let branchExists = false;
  try {
    exec(`git rev-parse --verify ${branch}`, clonePath);
    branchExists = true;
  } catch { /* branch doesn't exist */ }

  if (branchExists) {
    // Clean up any stale worktree reference for this path
    try { exec(`git worktree prune`, clonePath); } catch { /* best-effort */ }
    log.info("Branch already exists, reusing", { branch });
    exec(
      `git worktree add ${worktreePath} ${branch}`,
      clonePath
    );
  } else {
    exec(
      `git worktree add ${worktreePath} -b ${branch} origin/${repo.default_branch}`,
      clonePath
    );
  }

  return { worktreePath, branch, clonePath };
}

export function cleanupWorktree(clonePath: string, worktreePath: string): void {
  try {
    exec(`git worktree remove ${worktreePath} --force`, clonePath);
    log.info("Worktree removed", { path: worktreePath });
  } catch (err: any) {
    log.warn("Failed to remove worktree", { path: worktreePath, error: err.message });
  }
}
