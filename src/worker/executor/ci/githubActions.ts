import { execSync } from "child_process";
import { createLogger } from "../../../shared/logger.js";
import type { CIProvider, CICheckResult } from "./ciProvider.js";

const log = createLogger("worker:ci:github");

function exec(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8", timeout: 30_000 }).trim();
}

export class GitHubActionsProvider implements CIProvider {
  name = "github_actions";

  async pollChecks(worktreePath: string, _branch: string): Promise<CICheckResult> {
    try {
      const raw = exec("gh pr checks --json name,state,conclusion,detailsUrl", worktreePath);
      if (!raw) {
        return { status: "pending" };
      }

      const checks = JSON.parse(raw) as Array<{
        name: string;
        state: string;
        conclusion: string;
        detailsUrl: string;
      }>;

      if (checks.length === 0) {
        return { status: "pending" };
      }

      const hasPending = checks.some(
        (c) => c.state === "PENDING" || c.state === "QUEUED" || c.state === "IN_PROGRESS"
      );
      const hasFailed = checks.some(
        (c) => c.conclusion === "FAILURE" || c.conclusion === "TIMED_OUT" || c.conclusion === "CANCELLED"
      );
      const allSuccess = checks.every(
        (c) => c.conclusion === "SUCCESS" || c.conclusion === "NEUTRAL" || c.conclusion === "SKIPPED"
      );

      const url = checks[0]?.detailsUrl;

      if (hasPending) {
        return { status: "in_progress", url };
      }
      if (allSuccess) {
        return { status: "completed", conclusion: "success", url };
      }
      if (hasFailed) {
        const failedNames = checks
          .filter((c) => c.conclusion === "FAILURE")
          .map((c) => c.name)
          .join(", ");
        return {
          status: "completed",
          conclusion: "failure",
          url,
          summary: `Failed checks: ${failedNames}`,
        };
      }

      return { status: "in_progress", url };
    } catch (err: any) {
      log.warn("Failed to poll CI checks", { error: err.message });
      return { status: "pending" };
    }
  }

  async getFailureSummary(worktreePath: string, _branch: string): Promise<string> {
    try {
      const raw = exec("gh pr checks --json name,state,conclusion,detailsUrl", worktreePath);
      const checks = JSON.parse(raw) as Array<{
        name: string;
        state: string;
        conclusion: string;
        detailsUrl: string;
      }>;

      const failed = checks.filter((c) => c.conclusion === "FAILURE");
      if (failed.length === 0) return "No failed checks found.";

      const lines = failed.map(
        (c) => `- ${c.name}: ${c.conclusion} (${c.detailsUrl})`
      );
      return `Failed CI checks:\n${lines.join("\n")}`;
    } catch (err: any) {
      log.warn("Failed to get CI failure summary", { error: err.message });
      return `Failed to retrieve CI failure details: ${err.message}`;
    }
  }
}
