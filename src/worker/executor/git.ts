import { execSync, execFileSync } from "child_process";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("worker:git");

function exec(cmd: string, cwd: string): string {
  log.info("exec", { cmd, cwd });
  return execSync(cmd, { cwd, encoding: "utf-8", timeout: 60_000 }).trim();
}

export function hasChanges(worktreePath: string): boolean {
  const status = exec("git status --porcelain", worktreePath);
  return status.length > 0;
}

export function commitAll(worktreePath: string, message: string): string {
  exec("git add -A -- ':!.sonofsteve'", worktreePath);
  // Use execFileSync to avoid shell interpretation of backticks, $, etc.
  log.info("exec", { cmd: "git commit -m <message>", cwd: worktreePath });
  execFileSync("git", ["commit", "-m", message], {
    cwd: worktreePath,
    encoding: "utf-8",
    timeout: 60_000,
  });
  const sha = exec("git rev-parse HEAD", worktreePath);
  log.info("Committed", { sha, message });
  return sha;
}

export function push(worktreePath: string, branch: string): void {
  exec(`git push -u origin ${branch}`, worktreePath);
  log.info("Pushed", { branch });
}

export function getCommitSummary(worktreePath: string): string {
  try {
    return exec("git log --oneline -5", worktreePath);
  } catch {
    return "";
  }
}

export function getDiff(worktreePath: string): string {
  try {
    // Stage everything first so we diff all changes (tracked + untracked)
    exec("git add -A -- ':!.sonofsteve'", worktreePath);
    return exec("git diff --cached", worktreePath);
  } catch {
    return "";
  }
}

export function getDiffStats(worktreePath: string): string {
  try {
    return exec("git diff --stat HEAD~1 HEAD", worktreePath);
  } catch {
    return "";
  }
}
