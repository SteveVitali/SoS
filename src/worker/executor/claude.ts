import { execSync, spawn } from "child_process";
import { writeFileSync, mkdirSync, existsSync, createWriteStream } from "fs";
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

  return runClaudeProcess(
    ["claude", "-p", promptPath, "--output-format", "stream-json", "--dangerously-skip-permissions"],
    worktreePath,
    logPath,
    30 * 60 * 1000
  );
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

  return runClaudeProcess(
    ["claude", "-p", promptPath, "--output-format", "stream-json", "--dangerously-skip-permissions"],
    worktreePath,
    logPath,
    15 * 60 * 1000
  );
}

// Shared runner: streams Claude output to terminal in real-time via stream-json
function runClaudeProcess(
  args: string[],
  cwd: string,
  logPath: string,
  timeoutMs: number
): Promise<ClaudeResult> {
  const [bin, ...rest] = args;
  log.info("Spawning Claude", { bin, args: rest.join(" ").slice(0, 200) });

  return new Promise((resolve) => {
    const child = spawn(bin, rest, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const logStream = createWriteStream(logPath, { encoding: "utf-8" });
    const textChunks: string[] = [];
    let lineBuf = "";

    function processLine(line: string) {
      if (!line.trim()) return;
      try {
        const obj = JSON.parse(line);
        // Extract text from assistant message content blocks
        if (obj.type === "content_block_delta" && obj.delta?.text) {
          process.stdout.write(obj.delta.text);
          textChunks.push(obj.delta.text);
        } else if (obj.type === "content_block_start" && obj.content_block?.text) {
          process.stdout.write(obj.content_block.text);
          textChunks.push(obj.content_block.text);
        } else if (obj.type === "result" && obj.result) {
          // Final result message
          process.stdout.write("\n");
          textChunks.push(obj.result);
        }
      } catch {
        // Not JSON — print raw
        process.stdout.write(line + "\n");
        textChunks.push(line);
      }
      logStream.write(line + "\n");
    }

    child.stdout?.on("data", (data: Buffer) => {
      lineBuf += data.toString();
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() || "";
      for (const line of lines) processLine(line);
    });

    child.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(data);
      logStream.write(data.toString());
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (lineBuf) processLine(lineBuf);
      logStream.end();
      process.stdout.write("\n");

      const fullText = textChunks.join("");
      const summary = fullText.slice(-2000).trim() || `Claude exited with code ${code}`;
      const success = code === 0;

      log.info(success ? "Claude finished" : "Claude failed", {
        exitCode: code,
        summary_len: summary.length,
      });

      resolve({ success, summary, logPath });
    });
  });
}
