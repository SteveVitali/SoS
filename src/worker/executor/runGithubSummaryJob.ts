import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildMyRecapPrompt,
  buildTeamRecapPrompt,
  fetchRecapData,
  fetchTeamRecapData,
  formatRecapResult,
  type RecapData,
  type TeamRecapData,
} from "../../server/github/index.js";
import { getAuthenticatedUser } from "../../server/github/teamCache.js";
import { createLogger } from "../../shared/logger.js";
import type { ClaudeSession, JobDoc, JobMetrics } from "../../shared/types.js";
import type { WorkerApiClient } from "../apiClient.js";
import type { WorkerConfig } from "../config.js";
import { EventEmitter } from "../events.js";
import { LeaseAbortedError } from "./errors.js";

const log = createLogger("worker:runGithubSummary");

function cleanupTmpDir(dir: string | undefined): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Runs a GitHub summary job (my_recap or team_recap).
 * 1. Fetches GH data via `gh` CLI
 * 2. Builds a prompt with the data
 * 3. Runs Claude CLI to generate a narrative summary
 * 4. Completes the job with the formatted result
 *
 * No repo checkout or worktree needed.
 */
export async function runGithubSummaryJob(
  job: JobDoc,
  workerId: string,
  _config: WorkerConfig,
  api: WorkerApiClient,
  leaseSignal?: AbortSignal,
): Promise<void> {
  const events = new EventEmitter(api, workerId, job.task_id);
  const startTime = Date.now();

  const claudeSessions: ClaudeSession[] = [];
  const tmpDir = path.join(os.tmpdir(), `sos-github-summary-${job.task_id.slice(0, 8)}`);

  function checkLeaseAborted() {
    if (leaseSignal?.aborted) {
      throw new LeaseAbortedError(String(leaseSignal.reason || ""));
    }
  }

  try {
    const query = job.github_query;
    if (!query) {
      throw new Error("Job is missing github_query configuration");
    }

    const { query_type, time_range, org, team_slug } = query;
    await events.emit("PHASE_STARTED", { phase: "github_fetch_data" });

    // Resolve GitHub username (prefer persisted value from job, fall back to auto-detect)
    const githubUsername = query.github_username || getAuthenticatedUser();

    // Fetch the data
    let prompt: string;
    let recapData: RecapData | TeamRecapData;

    if (query_type === "my_recap") {
      log.info("Fetching personal recap data", { user: githubUsername, time_range });
      recapData = fetchRecapData(githubUsername, time_range);
      prompt = buildMyRecapPrompt(recapData, time_range);
    } else if (query_type === "team_recap") {
      if (!org || !team_slug) {
        throw new Error(
          "GitHub org and team slug are required for team_recap. Set SOS_GITHUB_ORG and SOS_GITHUB_TEAM_SLUG.",
        );
      }
      log.info("Fetching team recap data", { org, team_slug, time_range });
      recapData = fetchTeamRecapData(org, team_slug, time_range);
      prompt = buildTeamRecapPrompt(recapData, time_range);
    } else {
      throw new Error(`Unsupported summary query type: ${query_type}`);
    }

    const fetchDurationMs = Date.now() - startTime;
    log.info("GitHub data fetched", {
      query_type,
      duration_ms: fetchDurationMs,
    });

    // Write prompt to a temp file
    checkLeaseAborted();
    await events.emit("PHASE_STARTED", { phase: "github_generate_summary" });

    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    const promptPath = path.join(tmpDir, "prompt.md");
    writeFileSync(promptPath, prompt, "utf-8");

    // Run Claude CLI to generate the summary (no tools needed, text output)
    const claudeStart = Date.now();
    let llmSummary: string;
    try {
      llmSummary = execSync(`claude -p "${promptPath}" --output-format text`, {
        encoding: "utf-8",
        timeout: 120_000, // 2 minute timeout
        cwd: tmpDir,
      }).trim();
    } catch (err: unknown) {
      log.error("Claude CLI failed for summary generation", { error: (err as Error).message });
      throw new Error(`Failed to generate summary: ${(err as Error).message?.slice(0, 500)}`);
    }
    const claudeDurationMs = Date.now() - claudeStart;

    const session: ClaudeSession = {
      phase: "summary",
      duration_ms: claudeDurationMs,
    };
    claudeSessions.push(session);

    log.info("Summary generated", {
      query_type,
      summary_len: llmSummary.length,
      claude_duration_ms: claudeDurationMs,
    });

    // Format the final result
    const formatted = formatRecapResult(
      query_type as "my_recap" | "team_recap",
      llmSummary,
      time_range,
    );

    // Build metrics
    const durations = {
      total_ms: Date.now() - startTime,
      github_fetch_ms: fetchDurationMs,
      claude_code_ms: claudeDurationMs,
    };
    const metrics: JobMetrics = {
      durations,
      claude: {
        sessions: claudeSessions,
      },
    };

    // Complete the job
    await api.complete(job.task_id, workerId, {
      result_summary: formatted,
      metrics,
    });

    cleanupTmpDir(tmpDir);
    log.info("GitHub summary job completed", { task_id: job.task_id, query_type });
  } catch (err: unknown) {
    if (err instanceof LeaseAbortedError) {
      log.warn("GitHub summary job aborted due to lease loss", { task_id: job.task_id });
      return;
    }

    log.error("GitHub summary job failed", { task_id: job.task_id, error: (err as Error).message });
    try {
      await events.emit("FAILED", { error: (err as Error).message });
    } catch {
      /* best-effort */
    }

    try {
      const metrics: JobMetrics = {
        durations: { total_ms: Date.now() - startTime },
        claude: { sessions: claudeSessions },
      };
      await api.fail(job.task_id, workerId, {
        error: {
          code: (err as { code?: string }).code || "GITHUB_SUMMARY_ERROR",
          message: (err as Error).message,
          details: (err as Error).stack?.slice(0, 2000),
        },
        metrics,
      });
      // biome-ignore lint/suspicious/noExplicitAny: error handling
    } catch (failErr: any) {
      log.error("Failed to report github summary failure", {
        task_id: job.task_id,
        error: failErr.message,
      });
    }
    cleanupTmpDir(tmpDir);
  }
}
