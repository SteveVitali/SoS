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
  ensureSosGitignore(sosDir);

  const promptPath = path.join(sosDir, "prompt.md");
  const logPath = path.join(sosDir, "claude.log");

  const prompt = buildPrompt(taskText, repo, threadContext);
  writeFileSync(promptPath, prompt, "utf-8");

  log.info("Running Claude Code CLI", { worktree: worktreePath });

  return runClaudeProcess(
    ["claude", "-p", promptPath, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"],
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
  ensureSosGitignore(sosDir);

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
    ["claude", "-p", promptPath, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"],
    worktreePath,
    logPath,
    15 * 60 * 1000
  );
}

export async function runClaudeReview(
  worktreePath: string,
  repo: RepoEntry,
  diff: string
): Promise<ClaudeResult> {
  const sosDir = path.join(worktreePath, ".sonofsteve");
  if (!existsSync(sosDir)) mkdirSync(sosDir, { recursive: true });
  ensureSosGitignore(sosDir);

  const promptPath = path.join(sosDir, "review-prompt.md");
  const logPath = path.join(sosDir, "claude-review.log");

  const prompt = [
    "# Self-Review",
    "",
    "You are a Staff Engineer who cares deeply about clean, maintainable code, elegant abstractions,",
    "and best software design practices. Do a very critical review of the changes in the current branch",
    "and fix any issues that would be raised by very experienced colleagues with the utmost code review standards.",
    "",
    "## Review Checklist",
    "- **Correctness**: Are there bugs, off-by-one errors, race conditions, or edge cases?",
    "- **Design**: Are abstractions clean? Is there unnecessary complexity?",
    "- **Dead code**: Remove any unused imports, variables, or functions introduced by the changes.",
    "- **Naming**: Are variable/function names clear and consistent with the codebase style?",
    "- **Error handling**: Are errors handled gracefully? Are there missing null checks?",
    "- **Test coverage**: Are there missing tests for the changes? Add tests where sensible.",
    "- **Security**: Any hardcoded secrets, injection risks, or unsafe patterns?",
    "- **Performance**: Any obvious N+1 queries, unnecessary allocations, or hot-path issues?",
    "",
    "## Current Diff",
    "```diff",
    diff.slice(0, 30000),
    "```",
    "",
    "## Instructions",
    "- Fix all issues you find directly — do not just list them.",
    "- Keep fixes minimal and focused. Do not refactor unrelated code.",
    "- Ensure the result builds and lints cleanly.",
    ...(repo.commands?.lint ? [`- Lint: \`${repo.commands.lint.join(" ")}\``] : []),
    ...(repo.commands?.test_fast ? [`- Test: \`${repo.commands.test_fast.join(" ")}\``] : []),
    "- If no issues are found, say so briefly and finish.",
  ].join("\n");

  writeFileSync(promptPath, prompt, "utf-8");

  log.info("Running Claude Code CLI for self-review", { worktree: worktreePath });

  return runClaudeProcess(
    ["claude", "-p", promptPath, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"],
    worktreePath,
    logPath,
    15 * 60 * 1000
  );
}

function ensureSosGitignore(sosDir: string) {
  const gi = path.join(sosDir, ".gitignore");
  if (!existsSync(gi)) writeFileSync(gi, "*\n", "utf-8");
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
    let receivedOutput = false;

    // Heartbeat: log every 10s while waiting for first output
    const heartbeat = setInterval(() => {
      if (!receivedOutput) {
        log.info("Claude is working...", { pid: child.pid, elapsed: `${Math.round((Date.now() - startTime) / 1000)}s` });
      }
    }, 10_000);
    const startTime = Date.now();

    function processLine(line: string) {
      if (!line.trim()) return;
      logStream.write(line + "\n");
      try {
        const obj = JSON.parse(line);

        if (obj.type === "system") {
          // Init event — show model info
          if (obj.subtype === "init") {
            const info = `\n🤖 Claude (${obj.model || "unknown"}) session started\n`;
            process.stdout.write(info);
          }
        } else if (obj.type === "assistant") {
          // Assistant message with content blocks
          const content = obj.message?.content || [];
          for (const block of content) {
            if (block.type === "text" && block.text) {
              process.stdout.write(block.text);
              textChunks.push(block.text);
            } else if (block.type === "tool_use") {
              const msg = `\n🔧 [${block.name}] ${JSON.stringify(block.input || {}).slice(0, 200)}\n`;
              process.stdout.write(msg);
            }
          }
        } else if (obj.type === "tool_result") {
          // Tool output — show truncated result
          const content = obj.content || "";
          const preview = typeof content === "string" ? content.slice(0, 300) : JSON.stringify(content).slice(0, 300);
          if (preview) {
            process.stdout.write(`   → ${preview.split("\n")[0]}\n`);
          }
        } else if (obj.type === "result") {
          // Final result
          if (obj.result) {
            process.stdout.write("\n--- Claude Result ---\n");
            process.stdout.write(obj.result + "\n");
            textChunks.push(obj.result);
          }
        }
      } catch {
        // Not JSON — print raw
        process.stdout.write(line + "\n");
        textChunks.push(line);
      }
    }

    child.stdout?.on("data", (data: Buffer) => {
      receivedOutput = true;
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
      clearInterval(heartbeat);
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
