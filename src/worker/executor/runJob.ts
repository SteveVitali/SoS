import { execSync } from "child_process";
import { createLogger } from "../../shared/logger.js";
import { slugify } from "../../shared/slug.js";
import type { JobDoc } from "../../shared/types.js";
import type { WorkerConfig } from "../config.js";
import { WorkerApiClient } from "../apiClient.js";
import { EventEmitter } from "../events.js";
import { loadRegistry } from "./repoRegistry.js";
import { resolveRepo } from "./repoResolver.js";
import { ensureClone, createWorktree } from "./workspace.js";
import { runClaude, runClaudeFix } from "./claude.js";
import { hasChanges, commitAll, push } from "./git.js";
import { createPr } from "./pr.js";
import { GitHubActionsProvider } from "./ci/githubActions.js";
import type { CIProvider } from "./ci/ciProvider.js";
import { buildResultSummary } from "./summarize.js";

const log = createLogger("worker:runJob");

function runLocalChecks(
  worktreePath: string,
  commands: { lint?: string[]; test_fast?: string[]; test_full?: string[] } | undefined,
  level: "fast" | "full" | "none"
): { ok: boolean; summary: string } {
  if (level === "none" || !commands) {
    return { ok: true, summary: "Checks skipped" };
  }

  const results: string[] = [];
  let allOk = true;

  // Lint
  if (commands.lint) {
    try {
      const out = execSync(commands.lint.join(" "), {
        cwd: worktreePath,
        encoding: "utf-8",
        timeout: 120_000,
      });
      results.push(`Lint: PASS\n${out.slice(-500)}`);
    } catch (err: any) {
      allOk = false;
      results.push(`Lint: FAIL\n${(err.stdout || err.message).slice(-500)}`);
    }
  }

  // Tests
  const testCmd = level === "full" ? commands.test_full : commands.test_fast;
  if (testCmd) {
    try {
      const out = execSync(testCmd.join(" "), {
        cwd: worktreePath,
        encoding: "utf-8",
        timeout: 300_000,
      });
      results.push(`Tests (${level}): PASS\n${out.slice(-500)}`);
    } catch (err: any) {
      allOk = false;
      results.push(`Tests (${level}): FAIL\n${(err.stdout || err.message).slice(-500)}`);
    }
  }

  return { ok: allOk, summary: results.join("\n").slice(0, 3000) };
}

async function waitForCI(
  provider: CIProvider,
  worktreePath: string,
  branch: string,
  timeoutMs: number
): Promise<{ success: boolean; summary: string; url?: string }> {
  const start = Date.now();
  const pollInterval = 30_000; // 30s

  // Initial wait for CI to start
  await sleep(15_000);

  while (Date.now() - start < timeoutMs) {
    const result = await provider.pollChecks(worktreePath, branch);

    if (result.status === "completed") {
      if (result.conclusion === "success" || result.conclusion === "neutral") {
        return { success: true, summary: "CI passed", url: result.url };
      }
      return {
        success: false,
        summary: result.summary || "CI failed",
        url: result.url,
      };
    }

    await sleep(pollInterval);
  }

  return { success: false, summary: "CI timed out" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runJob(
  job: JobDoc,
  workerId: string,
  config: WorkerConfig,
  api: WorkerApiClient
): Promise<void> {
  const events = new EventEmitter(api, workerId, job.task_id);
  const startTime = Date.now();
  const maxRuntimeMs = config.maxRuntimeMinutes * 60 * 1000;

  function checkTimeout() {
    if (Date.now() - startTime > maxRuntimeMs) {
      throw new Error(`Job exceeded max runtime of ${config.maxRuntimeMinutes} minutes`);
    }
  }

  try {
    // 1) Resolve repo
    await events.emit("PHASE_STARTED", { phase: "resolve_repo" });
    const registry = loadRegistry(config.repoRegistryPath);
    const resolved = resolveRepo(registry, job.task_text, job.repo_hint);

    if (!resolved) {
      throw new Error(
        "Could not resolve a repository. Please specify repo=<id> in your request. " +
          `Available repos: ${[...registry.repos.keys()].join(", ")}`
      );
    }

    const repo = resolved.repo;
    await events.emit("REPO_RESOLVED", {
      repoId: repo.id,
      method: resolved.method,
      warning: resolved.warning,
    });
    checkTimeout();

    // 2) Prepare workspace
    await events.emit("PHASE_STARTED", { phase: "prepare_workspace" });
    const clonePath = ensureClone(config.workspaceRoot, repo);
    const branch = `sos/${job.task_id.slice(0, 8)}-${slugify(job.task_text, 30)}`;
    const workspace = createWorktree(
      config.workspaceRoot,
      workerId,
      job.task_id,
      repo,
      branch,
      clonePath
    );
    await events.emit("WORKTREE_READY", { path: workspace.worktreePath, branch });
    checkTimeout();

    // 3) Fetch Slack thread context (optional)
    let threadContext: string | undefined;
    if (job.slack?.channel_id && job.slack?.thread_ts) {
      try {
        const messages = await api.fetchSlackThread(job.slack.channel_id, job.slack.thread_ts);
        if (messages.length > 0) {
          threadContext = messages
            .map((m: any) => `[${m.user}]: ${m.text}`)
            .join("\n")
            .slice(0, 5000);
        }
      } catch {
        // Non-fatal
      }
    }

    // 4) Run Claude Code CLI
    await events.emit("CLAUDE_STARTED", {});
    const claudeResult = await runClaude(workspace.worktreePath, job.task_text, repo, threadContext);
    await events.emit("CLAUDE_FINISHED", {
      summary: claudeResult.summary.slice(0, 1000),
    });
    checkTimeout();

    if (!claudeResult.success) {
      throw new Error(`Claude Code failed: ${claudeResult.summary.slice(0, 500)}`);
    }

    // 5) Check for changes
    if (!hasChanges(workspace.worktreePath)) {
      throw new Error("Claude Code produced no changes. Task may already be done or was not actionable.");
    }

    // 6) Run local checks
    const testLevel = job.test_level || config.testLevelDefault;
    await events.emit("LOCAL_CHECKS_STARTED", { level: testLevel });
    let checks = runLocalChecks(workspace.worktreePath, repo.commands, testLevel);
    await events.emit("LOCAL_CHECKS_FINISHED", { ok: checks.ok, summary: checks.summary.slice(0, 500) });
    checkTimeout();

    if (!checks.ok && config.requireLocalTestsBeforePr) {
      // One local fix attempt with Claude
      log.info("Local checks failed, attempting fix", { task_id: job.task_id });
      const fixResult = await runClaude(
        workspace.worktreePath,
        `Fix the following failures:\n${checks.summary}`,
        repo
      );
      if (fixResult.success) {
        checks = runLocalChecks(workspace.worktreePath, repo.commands, testLevel);
      }
      if (!checks.ok) {
        throw new Error(`Local checks failed after fix attempt:\n${checks.summary.slice(0, 1000)}`);
      }
    }

    // 7) Commit + push
    await events.emit("PHASE_STARTED", { phase: "commit_push" });
    const shortSummary = claudeResult.summary.split("\n")[0]?.slice(0, 60) || "automated changes";
    const sha = commitAll(
      workspace.worktreePath,
      `sos: ${shortSummary} (task ${job.task_id.slice(0, 8)})`
    );
    await events.emit("COMMIT_CREATED", { sha, message: shortSummary });
    checkTimeout();

    push(workspace.worktreePath, branch);
    await events.emit("BRANCH_PUSHED", { branch });
    checkTimeout();

    // 8) Create PR
    await events.emit("PHASE_STARTED", { phase: "create_pr" });
    const prResult = createPr(
      workspace.worktreePath,
      repo,
      branch,
      job.task_id,
      job.task_text,
      checks.summary,
      job.slack?.permalink,
      job.reviewers
    );
    await events.emit("PR_CREATED", { url: prResult.url });
    checkTimeout();

    // 9) CI monitoring + fix loop
    const ciFixEnabled = job.ci_fix_enabled ?? true;
    const ciProvider: CIProvider = new GitHubActionsProvider();
    let ciAttempt = 0;
    let ciPassed = false;

    // Wait for CI
    const ciResult = await waitForCI(
      ciProvider,
      workspace.worktreePath,
      branch,
      10 * 60 * 1000 // 10 min CI timeout
    );
    await events.emit("CI_STATUS", {
      status: ciResult.success ? "success" : "failure",
      conclusion: ciResult.success ? "success" : "failure",
      url: ciResult.url,
    });

    if (ciResult.success) {
      ciPassed = true;
    } else if (ciFixEnabled) {
      // CI fix loop
      while (ciAttempt < config.maxCiFixAttempts && !ciPassed) {
        checkTimeout();
        ciAttempt++;
        await events.emit("CI_FAILED", {
          attempt: ciAttempt,
          summary: ciResult.summary.slice(0, 500),
        });
        await events.emit("CI_FIX_STARTED", { attempt: ciAttempt });

        // Get failure details
        const failureSummary = await ciProvider.getFailureSummary(workspace.worktreePath, branch);

        // Run Claude fix
        const fixResult = await runClaudeFix(workspace.worktreePath, repo, failureSummary);
        await events.emit("CI_FIX_FINISHED", {
          attempt: ciAttempt,
          summary: fixResult.summary.slice(0, 500),
        });

        if (fixResult.success && hasChanges(workspace.worktreePath)) {
          // Re-run local checks
          const fixChecks = runLocalChecks(workspace.worktreePath, repo.commands, testLevel);
          if (fixChecks.ok || !config.requireLocalTestsBeforePr) {
            commitAll(
              workspace.worktreePath,
              `sos: CI fix attempt ${ciAttempt} (task ${job.task_id.slice(0, 8)})`
            );
            push(workspace.worktreePath, branch);

            // Wait for CI again
            const retryResult = await waitForCI(
              ciProvider,
              workspace.worktreePath,
              branch,
              10 * 60 * 1000
            );
            await events.emit("CI_STATUS", {
              status: retryResult.success ? "success" : "failure",
              conclusion: retryResult.success ? "success" : "failure",
              url: retryResult.url,
            });

            if (retryResult.success) {
              ciPassed = true;
            }
          }
        }
      }
    }

    // 10) Complete or fail
    const resultSummary = buildResultSummary(
      workspace.worktreePath,
      claudeResult.summary,
      checks.summary,
      prResult.url
    );

    if (!ciPassed && ciFixEnabled && ciAttempt > 0) {
      // CI still failing after attempts, but PR exists — complete with warning
      await api.complete(job.task_id, workerId, {
        result_summary: `${resultSummary}\n\n⚠️ CI still failing after ${ciAttempt} fix attempts.`,
        pr_urls: [prResult.url],
        ci: { provider: ciProvider.name },
      });
    } else {
      await api.complete(job.task_id, workerId, {
        result_summary: resultSummary,
        pr_urls: [prResult.url],
        ci: { provider: ciProvider.name },
      });
    }
  } catch (err: any) {
    log.error("Job failed", { task_id: job.task_id, error: err.message });
    await events.emit("FAILED", { error: err.message });

    await api.fail(job.task_id, workerId, {
      error: {
        code: err.code || "EXECUTION_ERROR",
        message: err.message,
        details: err.stack?.slice(0, 2000),
      },
    });
  }
}
