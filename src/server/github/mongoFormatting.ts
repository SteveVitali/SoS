/**
 * Formatting for MongoDB-backed GitHub query results.
 *
 * Replaces the old formatting.ts which consumed PrResult objects from the
 * gh CLI. This module formats GitHubPrDoc objects with richer data:
 * size stats, review status, comment thread counts, and sync status notes.
 */

import type { GitHubPrDoc } from "../../shared/githubTypes.js";
import type { InstantQueryResult } from "./mongoQueries.js";

// --- Query display titles ---

const QUERY_TITLES: Record<string, string> = {
  my_review_requests: "📋 PRs Awaiting Your Review",
  my_open_prs: "📂 Your Open PRs",
  my_merged_prs: "✅ Your Recently Merged PRs",
  team_open_prs: "👥 Team Open PRs",
  team_review_requests: "👥 Team Outstanding Reviews",
};

const TEAM_QUERIES = new Set(["team_open_prs", "team_review_requests"]);

// --- Main formatter ---

export function formatInstantQueryFromMongo(result: InstantQueryResult): string {
  const title = QUERY_TITLES[result.queryType] || result.queryType;
  const prs = result.prs;

  if (prs.length === 0) {
    const syncNote = !result.syncStatus.hasPrData
      ? "\n_ℹ️ GitHub sync hasn't completed yet — data will appear shortly._"
      : "";
    return `*${title}*\n\n_None found._${syncNote}`;
  }

  const showAuthor =
    result.queryType === "my_review_requests" || TEAM_QUERIES.has(result.queryType);

  let body: string;
  if (TEAM_QUERIES.has(result.queryType)) {
    body = formatGroupedByAuthor(prs);
  } else {
    body = prs.map((pr) => formatPrLine(pr, { showAuthor })).join("\n");
  }

  const count = prs.length;
  const subtitle = `_${count} PR${count === 1 ? "" : "s"}_`;

  let syncNote = "";
  if (result.syncStatus.backfillPercent < 100 && result.syncStatus.backfillPercent > 0) {
    syncNote = `\n_ℹ️ Backfill ${result.syncStatus.backfillPercent}% — some older data may be missing._`;
  }

  return `*${title}* — ${subtitle}\n\n${body}${syncNote}`;
}

// --- PR line formatting ---

export function formatPrLine(pr: GitHubPrDoc, opts: { showAuthor?: boolean } = {}): string {
  const url = `https://github.com/${pr.repo}/pull/${pr.number}`;
  const draft = pr.is_draft ? " _(draft)_" : "";
  const review = pr.review_decision ? ` ${reviewEmoji(pr.review_decision)}` : "";
  const author = opts.showAuthor && pr.author ? ` by _${pr.author}_` : "";

  const size = pr.additions > 0 || pr.deletions > 0 ? ` (+${pr.additions}/-${pr.deletions})` : "";

  const comments = pr.comment_stats?.unresolved_threads
    ? ` 💬${pr.comment_stats.unresolved_threads}`
    : "";

  return `• <${url}|${pr.repo}#${pr.number}> — ${pr.title}${draft}${review}${size}${comments}${author}`;
}

// --- Grouped formatting (team queries) ---

function formatGroupedByAuthor(prs: GitHubPrDoc[]): string {
  const groups = new Map<string, GitHubPrDoc[]>();
  for (const pr of prs) {
    if (!groups.has(pr.author)) groups.set(pr.author, []);
    groups.get(pr.author)?.push(pr);
  }

  const sections: string[] = [];
  for (const [author, authorPrs] of groups) {
    sections.push(`*${author}* (${authorPrs.length}):`);
    for (const pr of authorPrs) {
      sections.push(formatPrLine(pr, { showAuthor: false }));
    }
  }
  return sections.join("\n");
}

// --- Helpers ---

function reviewEmoji(decision: string): string {
  switch (decision) {
    case "APPROVED":
      return "✅";
    case "CHANGES_REQUESTED":
      return "🔴";
    default:
      return "";
  }
}
