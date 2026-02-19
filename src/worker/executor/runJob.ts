import { execSync } from "node:child_process";
import { createLogger } from "../../shared/logger.js";
import { slugify } from "../../shared/slug.js";
import type { JobDoc } from "../../shared/types.js";
import type { WorkerApiClient } from "../apiClient.js";
import type { WorkerConfig } from "../config.js";
import { EventEmitter } from "../events.js";
import type { CIProvider } from "./ci/ciProvider.js";
import { createCIProvider } from "./ci/index.js";
import { runClaude, runClaudeFix, runClaudeReview } from "./claude.js";
import { commitAll, getDiff, hasChanges, hasNewCommits, hasUnpushedCommits, push } from "./git.js";
import { createPr, detectExistingPr } from "./pr.js";
import { loadRegistry } from "./repoRegistry.js";
import { resolveRepo } from "./repoResolver.js";
import { buildResultSummary } from "./summarize.js";
import { ensureClone } from "./workspace.js";
import { type WorktreeSlot, worktreePool } from "./worktreePool.js";

const log = createLogger("worker:runJob");

function runLocalChecks(
  worktreePath: string,
  commands: { lint?: string[]; test_fast?: string[]; test_full?: string[] } | undefined,
  level: "fast" | "full" | "none",
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
  timeoutMs: number,
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

/** Sentinel error to signal the job should be requeued, not failed. */
class RequeueError extends Error {
  constructor(public reason: string) {
    super(reason);
    this.name = "RequeueError";
  }
}

export async function runJob(
  job: JobDoc,
  workerId: string,
  config: WorkerConfig,
  api: WorkerApiClient,
): Promise<void> {
  const events = new EventEmitter(api, workerId, job.task_id);
  const startTime = Date.now();
  const maxRuntimeMs = config.maxRuntimeMinutes * 60 * 1000;

  let acquiredSlot: WorktreeSlot | null = null;
  let resolvedRepoId: string | undefined;

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
          `Available repos: ${[...registry.repos.keys()].join(", ")}`,
      );
    }

    const repo = resolved.repo;
    resolvedRepoId = repo.id;
    await events.emit("REPO_RESOLVED", {
      repoId: repo.id,
      method: resolved.method,
      warning: resolved.warning,
    });
    checkTimeout();

    // 2) Prepare workspace via worktree pool
    await events.emit("PHASE_STARTED", { phase: "prepare_workspace" });
    const clonePath = ensureClone(config.workspaceRoot, repo);
    const branch = `sos/${job.task_id.slice(0, 8)}-${slugify(job.task_text, 30)}`;

    acquiredSlot = worktreePool.acquire(repo, clonePath, job.task_id, branch);
    if (!acquiredSlot) {
      throw new RequeueError(
        `No worktree slots available for ${repo.id} (max: ${repo.max_worktrees})`,
      );
    }

    const worktreePath = acquiredSlot.worktreePath;
    await events.emit("WORKTREE_READY", {
      path: worktreePath,
      branch,
      worktree_slot: acquiredSlot.slotName,
    });
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
    const claudeResult = await runClaude(
      worktreePath,
      job.task_text,
      repo,
      threadContext,
      job.attachments,
    );
    await events.emit("CLAUDE_FINISHED", {
      summary: claudeResult.summary.slice(0, 1000),
    });
    checkTimeout();

    if (!claudeResult.success) {
      throw new Error(`Claude Code failed: ${claudeResult.summary.slice(0, 500)}`);
    }

    // 5) Check for changes (uncommitted, committed, or pushed by Claude)
    const uncommitted = hasChanges(worktreePath);
    const newCommits = hasNewCommits(worktreePath, repo.default_branch);
    const claudeCreatedPr = detectExistingPr(worktreePath, branch);
    const claudeHandledEverything = !uncommitted && !newCommits && !!claudeCreatedPr;

    if (!uncommitted && !newCommits && !claudeCreatedPr) {
      // Genuinely no changes anywhere — complete gracefully, don't fail
      log.warn("No changes detected after Claude", { task_id: job.task_id });
      await api.complete(job.task_id, workerId, {
        result_summary:
          "Claude Code completed but produced no changes. Task may already be done or was not actionable.",
      });
      return;
    }
    log.info("Post-Claude change detection", {
      uncommitted,
      newCommits,
      claudeCreatedPr: !!claudeCreatedPr,
    });

    // If Claude already committed, pushed, and created a PR — skip to CI monitoring
    let prUrl: string;
    let checks = { ok: true, summary: "Checks skipped" };

    if (claudeHandledEverything) {
      log.info("Claude already committed, pushed, and created PR — skipping to CI", {
        pr: claudeCreatedPr,
      });
      prUrl = claudeCreatedPr;
      await events.emit("PR_CREATED", { url: prUrl, claude_created: true });
    } else {
      // 6) Run local checks (only if there are uncommitted changes to validate)
      const testLevel = job.test_level || config.testLevelDefault;
      if (uncommitted) {
        await events.emit("LOCAL_CHECKS_STARTED", { level: testLevel });
        checks = runLocalChecks(worktreePath, repo.commands, testLevel);
        await events.emit("LOCAL_CHECKS_FINISHED", {
          ok: checks.ok,
          summary: checks.summary.slice(0, 500),
        });
        checkTimeout();

        if (!checks.ok && config.requireLocalTestsBeforePr) {
          // One local fix attempt with Claude
          log.info("Local checks failed, attempting fix", { task_id: job.task_id });
          const fixResult = await runClaude(
            worktreePath,
            `Fix the following failures:\n${checks.summary}`,
            repo,
          );
          if (fixResult.success) {
            checks = runLocalChecks(worktreePath, repo.commands, testLevel);
          }
          if (!checks.ok) {
            throw new Error(
              `Local checks failed after fix attempt:\n${checks.summary.slice(0, 1000)}`,
            );
          }
        }
      }

      // 7) Self-review (only if there are uncommitted changes to review)
      if (uncommitted || hasChanges(worktreePath)) {
        await events.emit("SELF_REVIEW_STARTED", {});
        const diff = getDiff(worktreePath);
        if (diff) {
          const reviewResult = await runClaudeReview(worktreePath, repo, diff);
          await events.emit("SELF_REVIEW_FINISHED", {
            success: reviewResult.success,
            summary: reviewResult.summary.slice(0, 1000),
          });

          // Re-run local checks after review changes
          if (reviewResult.success && hasChanges(worktreePath)) {
            const postReviewChecks = runLocalChecks(worktreePath, repo.commands, testLevel);
            if (!postReviewChecks.ok) {
              log.warn("Post-review local checks failed", {
                summary: postReviewChecks.summary.slice(0, 300),
              });
            }
          }
        } else {
          await events.emit("SELF_REVIEW_FINISHED", {
            success: true,
            summary: "No diff to review",
          });
        }
      } else {
        await events.emit("SELF_REVIEW_FINISHED", {
          success: true,
          summary: "Skipped (Claude already committed)",
        });
      }
      checkTimeout();

      // 8) Commit + push (skip steps Claude already performed)
      await events.emit("PHASE_STARTED", { phase: "commit_push" });
      const shortSummary = claudeResult.summary.split("\n")[0]?.slice(0, 60) || "automated changes";
      if (hasChanges(worktreePath)) {
        const sha = commitAll(
          worktreePath,
          `sos: ${shortSummary} (task ${job.task_id.slice(0, 8)})`,
        );
        await events.emit("COMMIT_CREATED", { sha, message: shortSummary });
      } else {
        log.info("Skipping commit — Claude already committed all changes");
      }
      checkTimeout();

      // Re-check: if changes were reverted during self-review, there may be nothing to ship
      if (!hasChanges(worktreePath) && !hasNewCommits(worktreePath, repo.default_branch)) {
        log.warn("No changes remain after self-review", { task_id: job.task_id });
        await api.complete(job.task_id, workerId, {
          result_summary:
            "Claude Code completed but all changes were reverted during self-review. Task may already be done or was not actionable.",
        });
        return;
      }

      if (hasUnpushedCommits(worktreePath, branch)) {
        push(worktreePath, branch);
        await events.emit("BRANCH_PUSHED", { branch });
      } else {
        log.info("Skipping push — branch already up to date with remote");
      }
      checkTimeout();

      // 9) Create PR (detect if Claude already created one)
      await events.emit("PHASE_STARTED", { phase: "create_pr" });
      const existingPr = detectExistingPr(worktreePath, branch);
      if (existingPr) {
        prUrl = existingPr;
        log.info("Using existing PR created by Claude", { url: prUrl });
        await events.emit("PR_CREATED", { url: prUrl, claude_created: true });
      } else {
        const prResult = createPr(
          worktreePath,
          repo,
          branch,
          job.task_id,
          job.task_text,
          checks.summary,
          job.slack?.permalink,
          job.reviewers,
        );
        prUrl = prResult.url;
        await events.emit("PR_CREATED", { url: prUrl });
      }
    }
    checkTimeout();

    // 10) CI monitoring + fix loop
    const ciFixEnabled = job.ci_fix_enabled ?? true;
    const ciProvider = createCIProvider(repo.ci?.provider);
    let ciAttempt = 0;
    let ciPassed = false;
    const ciProviderName = ciProvider?.name || "none";
    const ciTestLevel = job.test_level || config.testLevelDefault;

    if (!ciProvider) {
      // No CI provider configured — skip monitoring entirely
      log.info("No CI provider configured, skipping CI monitoring", { repoId: repo.id });
      ciPassed = true;
    } else {
      // Wait for CI
      const ciResult = await waitForCI(
        ciProvider,
        worktreePath,
        branch,
        10 * 60 * 1000, // 10 min CI timeout
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
          const failureSummary = await ciProvider.getFailureSummary(worktreePath, branch);

          // Run Claude fix
          const fixResult = await runClaudeFix(worktreePath, repo, failureSummary);
          await events.emit("CI_FIX_FINISHED", {
            attempt: ciAttempt,
            summary: fixResult.summary.slice(0, 500),
          });

          if (fixResult.success && hasChanges(worktreePath)) {
            // Re-run local checks
            const fixChecks = runLocalChecks(worktreePath, repo.commands, ciTestLevel);
            if (fixChecks.ok || !config.requireLocalTestsBeforePr) {
              commitAll(
                worktreePath,
                `sos: CI fix attempt ${ciAttempt} (task ${job.task_id.slice(0, 8)})`,
              );
              push(worktreePath, branch);

              // Wait for CI again
              const retryResult = await waitForCI(ciProvider, worktreePath, branch, 10 * 60 * 1000);
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
    }

    // 11) Complete or fail
    const resultSummary = buildResultSummary(
      worktreePath,
      claudeResult.summary,
      checks.summary,
      prUrl,
    );

    if (!ciPassed && ciFixEnabled && ciAttempt > 0) {
      // CI still failing after attempts, but PR exists — complete with warning
      await api.complete(job.task_id, workerId, {
        result_summary: `${resultSummary}\n\n⚠️ CI still failing after ${ciAttempt} fix attempts.`,
        pr_urls: [prUrl],
        ci: { provider: ciProviderName },
      });
    } else {
      await api.complete(job.task_id, workerId, {
        result_summary: resultSummary,
        pr_urls: [prUrl],
        ci: { provider: ciProviderName },
      });
    }
  } catch (err: any) {
    if (err instanceof RequeueError) {
      log.info("Requeuing job", { task_id: job.task_id, reason: err.reason });
      try {
        await api.requeue(job.task_id, workerId, err.reason);
      } catch (reqErr: any) {
        log.error("Failed to requeue job", { task_id: job.task_id, error: reqErr.message });
      }
      return; // Don't release the slot — we never acquired one
    }

    log.error("Job failed", { task_id: job.task_id, error: err.message });
    try {
      await events.emit("FAILED", { error: err.message });
    } catch {
      /* best-effort */
    }

    try {
      await api.fail(job.task_id, workerId, {
        error: {
          code: err.code || "EXECUTION_ERROR",
          message: err.message,
          details: err.stack?.slice(0, 2000),
        },
      });
    } catch (failErr: any) {
      log.error("Failed to report job failure to server", {
        task_id: job.task_id,
        error: failErr.message,
      });
    }
  } finally {
    // Always release the worktree slot back to the pool
    if (acquiredSlot && resolvedRepoId) {
      worktreePool.release(resolvedRepoId, acquiredSlot.slotName);
    }
  }
}
