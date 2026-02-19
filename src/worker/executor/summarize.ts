import { getDiffStats } from "./git.js";

export function buildResultSummary(
  worktreePath: string,
  claudeSummary: string,
  checksSummary: string,
  prUrl?: string,
): string {
  const lines: string[] = [];

  const diff = getDiffStats(worktreePath);
  if (diff) {
    lines.push("Changes:");
    lines.push(diff.slice(0, 500));
  }

  if (checksSummary) {
    lines.push(`Local checks: ${checksSummary.slice(0, 300)}`);
  }

  if (claudeSummary) {
    lines.push(`Claude summary: ${claudeSummary.slice(0, 500)}`);
  }

  return lines.join("\n").slice(0, 3000);
}
