import { getDiffStats } from "./git.js";

/** Strip lines that duplicate the PR URL already shown in the Slack header. */
export function stripPrLines(text: string): string {
  return text
    .split("\n")
    .filter((l) => !/^\*{0,2}PR\*{0,2}\s*:\s*https?:\/\//i.test(l.trim()))
    .join("\n")
    .trim();
}

export function buildResultSummary(
  worktreePath: string,
  claudeSummary: string,
  checksSummary: string,
  _prUrl?: string,
): string {
  const lines: string[] = [];

  // PR URL is intentionally omitted here — the Slack "Done" message
  // already shows it via job.pr_urls, so including it in the summary
  // would duplicate the link.

  const diff = getDiffStats(worktreePath);
  if (diff) {
    lines.push("Changes:");
    lines.push(diff.slice(0, 500));
  }

  if (checksSummary) {
    lines.push(`Local checks: ${checksSummary.slice(0, 300)}`);
  }

  if (claudeSummary) {
    const cleaned = stripPrLines(claudeSummary);
    if (cleaned) {
      lines.push(`Claude summary: ${cleaned.slice(0, 500)}`);
    }
  }

  return lines.join("\n").slice(0, 3000);
}
