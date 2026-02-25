import type { GithubQueryType } from "../../shared/types.js";
import type {
  GithubQueryResult,
  PrResult,
  RecapData,
  TeamRecapData,
  TeamReviewRequestsResult,
} from "./queries.js";

// --- Slack formatting for instant query results ---

function formatPr(pr: PrResult): string {
  const draft = pr.isDraft ? " _(draft)_" : "";
  const review = pr.reviewDecision ? ` | ${reviewDecisionEmoji(pr.reviewDecision)}` : "";
  const labels = pr.labels.length > 0 ? ` | \`${pr.labels.join("`, `")}\`` : "";
  return `• <${pr.url}|${pr.repo}#${pr.number}>${draft} — ${pr.title}${review}${labels}`;
}

function reviewDecisionEmoji(decision: string): string {
  switch (decision) {
    case "APPROVED":
      return "✅ Approved";
    case "CHANGES_REQUESTED":
      return "🔴 Changes requested";
    case "REVIEW_REQUIRED":
      return "⏳ Review required";
    default:
      return decision;
  }
}

function formatPrList(prs: PrResult[]): string {
  if (prs.length === 0) return "_None found._";
  return prs.map(formatPr).join("\n");
}

const QUERY_TITLES: Record<GithubQueryType, string> = {
  my_review_requests: "📋 PRs awaiting your review",
  my_open_prs: "📂 Your open PRs",
  my_merged_prs: "✅ Your recently merged PRs",
  team_open_prs: "👥 Team open PRs",
  team_review_requests: "👀 Team review requests",
  my_recap: "📊 Your recap",
  team_recap: "📊 Team recap",
};

function formatTeamReviews(teamReviews: TeamReviewRequestsResult[]): string {
  if (teamReviews.length === 0) return "_No outstanding review requests for the team._";

  const lines: string[] = [];
  let totalReviews = 0;
  for (const { member, prs } of teamReviews) {
    totalReviews += prs.length;
    lines.push(`\n*${member}* (${prs.length} pending):`);
    for (const pr of prs) {
      lines.push(formatPr(pr));
    }
  }
  lines.unshift(`_${totalReviews} total outstanding reviews across ${teamReviews.length} members_`);
  return lines.join("\n");
}

export function formatInstantQueryResult(result: GithubQueryResult): string {
  const title = QUERY_TITLES[result.queryType] || result.queryType;
  let body: string;

  if (result.queryType === "team_review_requests" && result.teamReviews) {
    body = formatTeamReviews(result.teamReviews);
  } else if (result.prs) {
    body = formatPrList(result.prs);
    if (result.prs.length > 0) {
      body = `_${result.prs.length} result${result.prs.length === 1 ? "" : "s"}_\n${body}`;
    }
  } else {
    body = "_No results._";
  }

  return `*${title}*\n\n${body}`;
}

// --- Prompt building for LLM recap summaries ---

function prToSummaryLine(pr: PrResult): string {
  const stats = pr.additions != null ? ` (+${pr.additions}/-${pr.deletions || 0})` : "";
  const labels = pr.labels.length > 0 ? ` [${pr.labels.join(", ")}]` : "";
  return `- ${pr.repo}#${pr.number}: ${pr.title}${stats}${labels} (merged ${pr.mergedAt || "unknown"})`;
}

export function buildMyRecapPrompt(data: RecapData, timeRange?: string): string {
  const range = timeRange || "7d";
  const lines: string[] = [];
  lines.push(
    `Generate a concise, well-written recap summary for the following developer activity over the past ${range}.`,
  );
  lines.push("");
  lines.push("## Stats");
  lines.push(`- PRs merged: ${data.mergedPrs.length}`);
  lines.push(`- Lines added: ${data.totalAdditions}`);
  lines.push(`- Lines removed: ${data.totalDeletions}`);
  lines.push(`- Repos touched: ${data.reposTouched.join(", ") || "none"}`);
  lines.push(`- PRs reviewed (by others, merged in range): ${data.reviewsCompleted.length}`);
  lines.push("");

  if (data.mergedPrs.length > 0) {
    lines.push("## Merged PRs");
    for (const pr of data.mergedPrs) {
      lines.push(prToSummaryLine(pr));
    }
    lines.push("");
  }

  if (data.reviewsCompleted.length > 0) {
    lines.push("## Reviews completed");
    for (const pr of data.reviewsCompleted) {
      lines.push(`- ${pr.repo}#${pr.number}: ${pr.title} (by ${pr.author})`);
    }
    lines.push("");
  }

  lines.push("## Instructions");
  lines.push("Write a concise recap suitable for a Slack message. Include:");
  lines.push("- A brief narrative of what was accomplished (group related PRs together)");
  lines.push("- Key stats (PRs merged, lines changed, repos)");
  lines.push("- Review contributions");
  lines.push(
    "- Keep it under 500 words. Use Slack markdown (bold with *, code with `, links with <url|text>).",
  );
  lines.push(
    "- Tone: professional but personable, like a staff engineer writing their own standup.",
  );

  return lines.join("\n");
}

export function buildTeamRecapPrompt(data: TeamRecapData, timeRange?: string): string {
  const range = timeRange || "7d";
  const lines: string[] = [];
  lines.push(
    `Generate a team recap summary for the following team activity over the past ${range}.`,
  );
  lines.push("");
  lines.push("## Team Stats");
  lines.push(`- Total PRs merged: ${data.totalPrsMerged}`);
  lines.push(`- Total lines added: ${data.totalAdditions}`);
  lines.push(`- Total lines removed: ${data.totalDeletions}`);
  lines.push(`- Active repos: ${data.reposActive.join(", ") || "none"}`);
  lines.push(`- Contributors: ${data.members.map((m) => m.username).join(", ")}`);
  lines.push("");

  for (const { username, recap } of data.members) {
    lines.push(`## ${username}`);
    lines.push(
      `PRs merged: ${recap.mergedPrs.length} | +${recap.totalAdditions}/-${recap.totalDeletions} | Reviews: ${recap.reviewsCompleted.length}`,
    );
    for (const pr of recap.mergedPrs) {
      lines.push(prToSummaryLine(pr));
    }
    lines.push("");
  }

  lines.push("## Instructions");
  lines.push("Write a team recap suitable for a Slack message. Include:");
  lines.push("- High-level team narrative (themes, major features, areas of focus)");
  lines.push("- Per-member highlights (1-2 sentences each, focus on impact not just listing PRs)");
  lines.push("- Team-level stats");
  lines.push(
    "- Keep it under 800 words. Use Slack markdown (bold with *, code with `, links with <url|text>).",
  );
  lines.push("- Tone: like a tech lead summarizing the sprint for stakeholders.");

  return lines.join("\n");
}

// --- Format the final LLM-generated recap for Slack ---

export function formatRecapResult(
  queryType: "my_recap" | "team_recap",
  llmSummary: string,
  timeRange?: string,
): string {
  const range = timeRange || "7d";
  const title =
    queryType === "my_recap" ? `📊 *Your recap (${range})*` : `📊 *Team recap (${range})*`;

  return `${title}\n\n${llmSummary}`;
}
