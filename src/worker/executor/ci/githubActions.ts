import { execSync } from "node:child_process";
import { createLogger } from "../../../shared/logger.js";
import type { CICheckResult, CIProvider } from "./ciProvider.js";

const log = createLogger("worker:ci:github");

function exec(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8", timeout: 30_000 }).trim();
}

export class GitHubActionsProvider implements CIProvider {
  name = "github_actions";

  async pollChecks(worktreePath: string, _branch: string): Promise<CICheckResult> {
    try {
      const raw = exec("gh pr checks --json name,state,bucket,link", worktreePath);
      if (!raw) {
        return { status: "pending" };
      }

      const checks = JSON.parse(raw) as Array<{
        name: string;
        state: string;
        bucket: string;
        link: string;
      }>;

      if (checks.length === 0) {
        return { status: "pending" };
      }

      const hasPending = checks.some(
        (c) => c.bucket === "pending" || c.state === "PENDING" || c.state === "QUEUED",
      );
      const hasFailed = checks.some((c) => c.bucket === "fail");
      const allSuccess = checks.every((c) => c.bucket === "pass" || c.bucket === "skipping");

      const url = checks[0]?.link;

      if (hasPending) {
        return { status: "in_progress", url };
      }
      if (allSuccess) {
        return { status: "completed", conclusion: "success", url };
      }
      if (hasFailed) {
        const failedNames = checks
          .filter((c) => c.bucket === "fail")
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
    } catch (err: unknown) {
      log.warn("Failed to poll CI checks", { error: (err as Error).message });
      return { status: "pending" };
    }
  }

  async getFailureSummary(worktreePath: string, _branch: string): Promise<string> {
    try {
      const raw = exec("gh pr checks --json name,state,bucket,link", worktreePath);
      const checks = JSON.parse(raw) as Array<{
        name: string;
        state: string;
        bucket: string;
        link: string;
      }>;

      const failed = checks.filter((c) => c.bucket === "fail");
      if (failed.length === 0) return "No failed checks found.";

      const lines = failed.map((c) => `- ${c.name}: ${c.bucket} (${c.link})`);
      return `Failed CI checks:\n${lines.join("\n")}`;
    } catch (err: unknown) {
      log.warn("Failed to get CI failure summary", { error: (err as Error).message });
      return `Failed to retrieve CI failure details: ${(err as Error).message}`;
    }
  }
}
