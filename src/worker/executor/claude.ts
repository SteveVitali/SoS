import { execSync } from "child_process";
import { writeFileSync, mkdirSync, existsSync } from "fs";
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

  try {
    // Run claude with the prompt, piping output to log
    const result = execSync(
      `claude -p "${promptPath}" --output-format text 2>&1 | tee "${logPath}"`,
      {
        cwd: worktreePath,
        encoding: "utf-8",
        timeout: 30 * 60 * 1000, // 30 min timeout for Claude
        shell: "/bin/bash",
        maxBuffer: 50 * 1024 * 1024,
      }
    );

    const summary = result.slice(-2000).trim();
    log.info("Claude finished", { summary_len: summary.length });

    return { success: true, summary, logPath };
  } catch (err: any) {
    const output = err.stdout || err.stderr || err.message;
    const summary = String(output).slice(-2000).trim();
    writeFileSync(logPath, summary, "utf-8");

    log.error("Claude failed", { error: summary.slice(0, 500) });
    return { success: false, summary, logPath };
  }
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

  try {
    const result = execSync(
      `claude -p "${promptPath}" --output-format text 2>&1 | tee "${logPath}"`,
      {
        cwd: worktreePath,
        encoding: "utf-8",
        timeout: 15 * 60 * 1000,
        shell: "/bin/bash",
        maxBuffer: 50 * 1024 * 1024,
      }
    );

    const summary = result.slice(-2000).trim();
    return { success: true, summary, logPath };
  } catch (err: any) {
    const output = err.stdout || err.stderr || err.message;
    const summary = String(output).slice(-2000).trim();
    writeFileSync(logPath, summary, "utf-8");
    return { success: false, summary, logPath };
  }
}
