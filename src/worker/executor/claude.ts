import { execSync } from "child_process";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import { createLogger } from "../../shared/logger.js";
import type { RepoEntry } from "./repoRegistry.js";

const log = createLogger("worker:claude");

export interface ClaudeResult {
  success: boolean;
  summary: string;
  logPath: string;
}

function buildPrompt(
  taskText: string,
  repo: RepoEntry,
  threadContext?: string
): string {
  const lines: string[] = [];
  lines.push("# Task");
  lines.push(taskText);
  lines.push("");

  if (threadContext) {
    lines.push("# Slack Thread Context");
    lines.push(threadContext);
    lines.push("");
  }

  lines.push("# Repository");
  lines.push(`- Repo: ${repo.id}`);
  lines.push(`- Default branch: ${repo.default_branch}`);
  lines.push("");

  if (repo.commands) {
    lines.push("# Available Commands");
    if (repo.commands.lint) lines.push(`- Lint: \`${repo.commands.lint.join(" ")}\``);
    if (repo.commands.test_fast) lines.push(`- Test (fast): \`${repo.commands.test_fast.join(" ")}\``);
    if (repo.commands.test_full) lines.push(`- Test (full): \`${repo.commands.test_full.join(" ")}\``);
    lines.push("");
  }

  lines.push("# Constraints");
  lines.push("- Keep changes minimal and focused on the task");
  lines.push("- Run lint and tests per the commands above before finishing");
  lines.push("- Produce a clear, concise PR description when done");
  lines.push("- Do not modify unrelated files");

  return lines.join("\n");
}

export async function runClaude(
  worktreePath: string,
  taskText: string,
  repo: RepoEntry,
  threadContext?: string
): Promise<ClaudeResult> {
  const sosDir = path.join(worktreePath, ".sonofsteve");
  if (!existsSync(sosDir)) mkdirSync(sosDir, { recursive: true });

  const promptPath = path.join(sosDir, "prompt.md");
  const logPath = path.join(sosDir, "claude.log");

  const prompt = buildPrompt(taskText, repo, threadContext);
  writeFileSync(promptPath, prompt, "utf-8");

  log.info("Running Claude Code CLI", { worktree: worktreePath });

  return Promise.resolve(runClaudeProcess(
    `claude -p "${promptPath}" --output-format text --dangerously-skip-permissions`,
    worktreePath,
    logPath,
    30 * 60 * 1000
  ));
}

export async function runClaudeFix(
  worktreePath: string,
  repo: RepoEntry,
  failureSummary: string
): Promise<ClaudeResult> {
  const sosDir = path.join(worktreePath, ".sonofsteve");
  if (!existsSync(sosDir)) mkdirSync(sosDir, { recursive: true });

  const promptPath = path.join(sosDir, "fix-prompt.md");
  const logPath = path.join(sosDir, "claude-fix.log");

  const prompt = [
    "# CI Fix Required",
    "",
    "The CI pipeline failed with the following output:",
    "```",
    failureSummary.slice(0, 5000),
    "```",
    "",
    "Please fix the failing checks. Keep changes minimal.",
    "",
    repo.commands?.lint ? `- Lint: \`${repo.commands.lint.join(" ")}\`` : "",
    repo.commands?.test_fast ? `- Test: \`${repo.commands.test_fast.join(" ")}\`` : "",
  ]
    .filter(Boolean)
    .join("\n");

  writeFileSync(promptPath, prompt, "utf-8");

  log.info("Running Claude Code CLI for CI fix", { worktree: worktreePath });

  return Promise.resolve(runClaudeProcess(
    `claude -p "${promptPath}" --output-format text --dangerously-skip-permissions`,
    worktreePath,
    logPath,
    15 * 60 * 1000
  ));
}

// Shared runner: uses `script` to preserve TTY for real-time output + log capture
function runClaudeProcess(
  command: string,
  cwd: string,
  logPath: string,
  timeoutMs: number
): ClaudeResult {
  try {
    execSync(
      `script -q "${logPath}" ${command}`,
      {
        cwd,
        stdio: "inherit",
        timeout: timeoutMs,
        shell: "/bin/bash",
      }
    );

    const output = readFileSync(logPath, "utf-8");
    const summary = output.slice(-2000).trim();
    log.info("Claude finished", { summary_len: summary.length });
    return { success: true, summary, logPath };
  } catch (err: any) {
    let summary = "";
    try {
      summary = readFileSync(logPath, "utf-8").slice(-2000).trim();
    } catch {
      summary = err.message?.slice(0, 2000) || "Claude process failed";
    }
    log.error("Claude failed", { error: summary.slice(0, 500) });
    return { success: false, summary, logPath };
  }
}
