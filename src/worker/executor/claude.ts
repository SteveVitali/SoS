import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createLogger } from "../../shared/logger.js";
import type { JobAttachment } from "../../shared/types.js";
import type { RepoEntry } from "./repoRegistry.js";

const log = createLogger("worker:claude");

export interface ClaudeResult {
  success: boolean;
  summary: string;
  logPath: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  cost_usd?: number;
}

function writeAttachments(sosDir: string, attachments: JobAttachment[]): string[] {
  const attachDir = path.join(sosDir, "attachments");
  if (!existsSync(attachDir)) mkdirSync(attachDir, { recursive: true });

  const writtenPaths: string[] = [];
  const usedNames = new Set<string>();

  for (const att of attachments) {
    // Deduplicate filenames by prepending file_id if needed
    let filename = att.filename;
    if (usedNames.has(filename)) {
      filename = `${att.file_id}_${filename}`;
    }
    usedNames.add(filename);

    const filePath = path.join(attachDir, filename);
    writeFileSync(filePath, Buffer.from(att.base64, "base64"));
    writtenPaths.push(`.sonofsteve/attachments/${filename}`);
    log.info("Wrote attachment to worktree", {
      filename,
      size: att.size_bytes,
    });
  }

  return writtenPaths;
}

function buildPrompt(
  taskText: string,
  repo: RepoEntry,
  threadContext?: string,
  attachmentPaths?: { path: string; mimetype: string; size_bytes: number }[],
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

  if (attachmentPaths && attachmentPaths.length > 0) {
    lines.push("# Attached Files");
    lines.push("");
    lines.push("The user attached the following files in the Slack thread. They have been");
    lines.push("saved to the `.sonofsteve/attachments/` directory in this worktree:");
    lines.push("");
    for (const att of attachmentPaths) {
      const sizeKb = Math.round(att.size_bytes / 1024);
      lines.push(`- \`${att.path}\` (${att.mimetype}, ${sizeKb}KB)`);
    }
    lines.push("");
    lines.push("Review these files for context before starting work.");
    lines.push("");
  }

  lines.push("# Repository");
  lines.push(`- Repo: ${repo.id}`);
  lines.push(`- Default branch: ${repo.default_branch}`);
  lines.push("");

  if (repo.commands) {
    lines.push("# Available Commands");
    if (repo.commands.lint) lines.push(`- Lint: \`${repo.commands.lint.join(" ")}\``);
    if (repo.commands.test_fast)
      lines.push(`- Test (fast): \`${repo.commands.test_fast.join(" ")}\``);
    if (repo.commands.test_full)
      lines.push(`- Test (full): \`${repo.commands.test_full.join(" ")}\``);
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
  threadContext?: string,
  attachments?: JobAttachment[],
  abortSignal?: AbortSignal,
): Promise<ClaudeResult> {
  const sosDir = path.join(worktreePath, ".sonofsteve");
  if (!existsSync(sosDir)) mkdirSync(sosDir, { recursive: true });
  ensureSosGitignore(sosDir);

  // Write attachments to disk
  let attachmentPaths: { path: string; mimetype: string; size_bytes: number }[] | undefined;
  if (attachments && attachments.length > 0) {
    const writtenPaths = writeAttachments(sosDir, attachments);
    attachmentPaths = attachments.map((att, i) => ({
      path: writtenPaths[i],
      mimetype: att.mimetype,
      size_bytes: att.size_bytes,
    }));
    log.info("Attachments written to worktree", { count: attachments.length });
  }

  const promptPath = path.join(sosDir, "prompt.md");
  const logPath = path.join(sosDir, "claude.log");

  const prompt = buildPrompt(taskText, repo, threadContext, attachmentPaths);
  writeFileSync(promptPath, prompt, "utf-8");

  log.info("Running Claude Code CLI", { worktree: worktreePath });

  return runClaudeProcess(
    [
      "claude",
      "-p",
      promptPath,
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ],
    worktreePath,
    logPath,
    30 * 60 * 1000,
    abortSignal,
  );
}

export async function runClaudeFix(
  worktreePath: string,
  repo: RepoEntry,
  failureSummary: string,
  abortSignal?: AbortSignal,
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
    [
      "claude",
      "-p",
      promptPath,
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ],
    worktreePath,
    logPath,
    15 * 60 * 1000,
    abortSignal,
  );
}

export async function runClaudeReview(
  worktreePath: string,
  repo: RepoEntry,
  diff: string,
  abortSignal?: AbortSignal,
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
    [
      "claude",
      "-p",
      promptPath,
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ],
    worktreePath,
    logPath,
    15 * 60 * 1000,
    abortSignal,
  );
}

export interface RespondToCommentOptions {
  worktreePath: string;
  repo: RepoEntry;
  threadIndex: number;
  path: string;
  line: number | null;
  comments: Array<{ author: string; body: string; diffHunk: string }>;
  branch: string;
  abortSignal?: AbortSignal;
}

export async function runClaudeRespondToComment(
  opts: RespondToCommentOptions,
): Promise<ClaudeResult> {
  const {
    worktreePath,
    repo,
    threadIndex,
    path: filePath,
    line,
    comments,
    branch,
    abortSignal,
  } = opts;
  const sosDir = path.join(worktreePath, ".sonofsteve");
  if (!existsSync(sosDir)) mkdirSync(sosDir, { recursive: true });
  ensureSosGitignore(sosDir);

  const promptPath = path.join(sosDir, `respond-prompt-${threadIndex}.md`);
  const logPath = path.join(sosDir, `claude-respond-${threadIndex}.log`);

  const commentBlocks = comments.map((c) => {
    const lines = [`**${c.author}** said:`, `> ${c.body.replace(/\n/g, "\n> ")}`];
    if (c.diffHunk) {
      lines.push("", "Diff context:", "```diff", c.diffHunk, "```");
    }
    return lines.join("\n");
  });

  const locationStr = line != null ? `${filePath}:${line}` : filePath;

  const prompt = [
    "# Address Review Comment",
    "",
    `Branch: \`${branch}\``,
    `Repo: \`${repo.id}\``,
    "",
    `## Review Thread — \`${locationStr}\``,
    "",
    ...commentBlocks,
    "",
    "## Instructions",
    "- Address the reviewer's comment with minimal, focused changes.",
    "- If the comment is a question, observation, or stylistic preference that",
    "  doesn't warrant a code change, just explain your reasoning in your summary",
    "  and make NO file changes.",
    "- If you make changes, ensure the result builds and lints cleanly.",
    ...(repo.commands?.lint ? [`- Lint: \`${repo.commands.lint.join(" ")}\``] : []),
    ...(repo.commands?.test_fast ? [`- Test: \`${repo.commands.test_fast.join(" ")}\``] : []),
    "- Keep your summary concise — it will be posted as a reply to the reviewer.",
  ].join("\n");

  writeFileSync(promptPath, prompt, "utf-8");

  log.info("Running Claude Code CLI for review comment", {
    worktree: worktreePath,
    thread: threadIndex,
    file: locationStr,
  });

  return runClaudeProcess(
    [
      "claude",
      "-p",
      promptPath,
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ],
    worktreePath,
    logPath,
    5 * 60 * 1000,
    abortSignal,
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
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<ClaudeResult> {
  const [bin, ...rest] = args;
  log.info("Spawning Claude", { bin, args: rest.join(" ").slice(0, 200) });

  return new Promise((resolve) => {
    const child = spawn(bin, rest, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const logStream = createWriteStream(logPath, { encoding: "utf-8" });
    const textChunks: string[] = [];
    let lineBuf = "";
    let receivedOutput = false;

    // Metrics captured from stream-json events
    let resultModel: string | undefined;
    let resultInputTokens: number | undefined;
    let resultOutputTokens: number | undefined;
    let resultDurationMs: number | undefined;
    let resultDurationApiMs: number | undefined;
    let resultNumTurns: number | undefined;
    let resultCostUsd: number | undefined;

    // Heartbeat: log every 10s while waiting for first output
    const heartbeat = setInterval(() => {
      if (!receivedOutput) {
        log.info("Claude is working...", {
          pid: child.pid,
          elapsed: `${Math.round((Date.now() - startTime) / 1000)}s`,
        });
      }
    }, 10_000);
    const startTime = Date.now();

    function processLine(line: string) {
      if (!line.trim()) return;
      logStream.write(`${line}\n`);
      try {
        const obj = JSON.parse(line);

        if (obj.type === "system") {
          // Init event — show model info
          if (obj.subtype === "init") {
            if (obj.model) resultModel = obj.model;
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
          const preview =
            typeof content === "string"
              ? content.slice(0, 300)
              : JSON.stringify(content).slice(0, 300);
          if (preview) {
            process.stdout.write(`   → ${preview.split("\n")[0]}\n`);
          }
        } else if (obj.type === "result") {
          // Final result with metadata
          if (obj.result) {
            process.stdout.write("\n--- Claude Result ---\n");
            process.stdout.write(`${obj.result}\n`);
            textChunks.push(obj.result);
          }
          // Capture metrics from result event
          if (obj.model) resultModel = obj.model;
          if (obj.duration_ms != null) resultDurationMs = obj.duration_ms;
          if (obj.duration_api_ms != null) resultDurationApiMs = obj.duration_api_ms;
          if (obj.num_turns != null) resultNumTurns = obj.num_turns;
          if (obj.total_cost_usd != null) resultCostUsd = obj.total_cost_usd;
          else if (obj.cost_usd != null) resultCostUsd = obj.cost_usd;
          // Usage may be nested under a usage object or at top level
          const usage = obj.usage || obj;
          if (usage.input_tokens != null) resultInputTokens = usage.input_tokens;
          if (usage.output_tokens != null) resultOutputTokens = usage.output_tokens;
        }
      } catch {
        // Not JSON — print raw
        process.stdout.write(`${line}\n`);
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
      log.warn("Claude process timed out, killing", { pid: child.pid, timeoutMs });
      child.kill("SIGTERM");
    }, timeoutMs);

    // Kill subprocess if lease is lost / server unreachable
    const onAbort = () => {
      log.warn("Aborting Claude process due to lease loss", { pid: child.pid });
      child.kill("SIGTERM");
    };
    if (abortSignal) {
      if (abortSignal.aborted) {
        child.kill("SIGTERM");
      } else {
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.on("close", (code) => {
      abortSignal?.removeEventListener("abort", onAbort);
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

      resolve({
        success,
        summary,
        logPath,
        model: resultModel,
        input_tokens: resultInputTokens,
        output_tokens: resultOutputTokens,
        duration_ms: resultDurationMs ?? Date.now() - startTime,
        duration_api_ms: resultDurationApiMs,
        num_turns: resultNumTurns,
        cost_usd: resultCostUsd,
      });
    });
  });
}
