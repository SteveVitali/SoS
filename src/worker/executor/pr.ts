import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createLogger } from "../../shared/logger.js";
import type { RepoEntry } from "./repoRegistry.js";

const log = createLogger("worker:pr");

function exec(cmd: string, cwd: string): string {
  log.info("exec", { cmd, cwd });
  return execSync(cmd, { cwd, encoding: "utf-8", timeout: 60_000 }).trim();
}

export interface PrCreateResult {
  url: string;
}

export function detectExistingPr(worktreePath: string, branch: string): string | null {
  try {
    const url = exec(`gh pr view ${branch} --json url -q .url`, worktreePath);
    if (url && url.startsWith("http")) {
      log.info("Detected existing PR for branch", { branch, url });
      return url;
    }
    return null;
  } catch {
    return null;
  }
}

export function createPr(
  worktreePath: string,
  repo: RepoEntry,
  branch: string,
  taskId: string,
  taskText: string,
  checksSummary: string,
  slackPermalink?: string,
  reviewers?: string[],
): PrCreateResult {
  const title = `sos: ${taskText.slice(0, 72)}`;

  const bodyLines: string[] = [];
  bodyLines.push(`## Son of Steve — task \`${taskId}\``);
  bodyLines.push("");
  bodyLines.push(`**Task:** ${taskText}`);
  bodyLines.push("");
  if (slackPermalink) {
    bodyLines.push(`**Slack thread:** ${slackPermalink}`);
    bodyLines.push("");
  }
  if (checksSummary) {
    bodyLines.push("### Local Checks");
    bodyLines.push("```");
    bodyLines.push(checksSummary.slice(0, 2000));
    bodyLines.push("```");
    bodyLines.push("");
  }
  bodyLines.push("---");
  bodyLines.push("_Created by Son of Steve 🤖_");

  const body = bodyLines.join("\n");

  // Write body to a temp file to avoid shell escaping issues
  const bodyFile = `/tmp/sos-pr-body-${taskId}.md`;
  writeFileSync(bodyFile, body, "utf-8");

  const prUrl = exec(
    `gh pr create --title "${title.replace(/"/g, '\\"')}" --body-file "${bodyFile}" --head "${branch}" --base "${repo.default_branch}"`,
    worktreePath,
  );

  log.info("PR created", { url: prUrl });

  // Add reviewers if specified
  const allReviewers = [...(reviewers || []), ...(repo.pr?.reviewers_default || [])];
  const uniqueReviewers = [...new Set(allReviewers)].filter(Boolean);

  if (uniqueReviewers.length > 0) {
    try {
      exec(`gh pr edit "${prUrl}" --add-reviewer ${uniqueReviewers.join(",")}`, worktreePath);
      log.info("Reviewers added", { reviewers: uniqueReviewers });
    } catch (err: any) {
      log.warn("Failed to add reviewers", { error: err.message });
    }
  }

  return { url: prUrl };
}
