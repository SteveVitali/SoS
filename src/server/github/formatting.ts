import type { GithubQueryType } from "../../shared/types.js";
import type { GithubQueryResult, PrResult, RecapData, TeamRecapData } from "./queries.js";

// --- Slack formatting for instant query results ---

function shortDate(dateStr: string): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "";
  const mon = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return `${mon} ${d.getUTCDate()}`;
}

function prSortDate(pr: PrResult): string {
  return pr.mergedAt || pr.updatedAt || pr.createdAt || "";
}

function prDate(pr: PrResult): string {
  const s = shortDate(prSortDate(pr));
  return s ? ` _(${s})_` : "";
}

function formatPr(pr: PrResult, opts: { showAuthor?: boolean } = {}): string {
  const draft = pr.isDraft ? " _(draft)_" : "";
  const review = pr.reviewDecision ? ` ${reviewDecisionEmoji(pr.reviewDecision)}` : "";
  const labels = pr.labels.length > 0 ? ` \`${pr.labels.join("`, `")}\`` : "";
  const author = opts.showAuthor && pr.author ? ` by _${pr.author}_` : "";
  return `• <${pr.url}|${pr.repo}#${pr.number}> — ${pr.title}${draft}${review}${labels}${author}${prDate(pr)}`;
}

function reviewDecisionEmoji(decision: string): string {
  switch (decision) {
    case "APPROVED":
      return "✅";
    case "CHANGES_REQUESTED":
      return "🔴";
    case "REVIEW_REQUIRED":
      return "⏳";
    default:
      return "";
  }
}

function sortPrsDesc(prs: PrResult[]): PrResult[] {
  return [...prs].sort((a, b) => prSortDate(b).localeCompare(prSortDate(a)));
}

function formatFlatPrList(prs: PrResult[], opts: { showAuthor?: boolean } = {}): string {
  if (prs.length === 0) return "_None found._";
  return sortPrsDesc(prs)
    .map((pr) => formatPr(pr, opts))
    .join("\n");
}

function formatGroupedPrList(prs: PrResult[]): string {
  if (prs.length === 0) return "_None found._";

  // Group by author
  const byAuthor = new Map<string, PrResult[]>();
  for (const pr of prs) {
    const author = pr.author || "unknown";
    if (!byAuthor.has(author)) byAuthor.set(author, []);
    byAuthor.get(author)?.push(pr);
  }

  // Sort authors by number of PRs descending
  const sorted = [...byAuthor.entries()].sort((a, b) => b[1].length - a[1].length);

  const sections: string[] = [];
  for (const [author, authorPrs] of sorted) {
    const count = authorPrs.length;
    const header = `*${author}* — ${count} PR${count === 1 ? "" : "s"}`;
    const lines = sortPrsDesc(authorPrs).map((pr) => formatPr(pr));
    sections.push(`${header}\n${lines.join("\n")}`);
  }

  return sections.join("\n\n");
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

const TEAM_QUERY_TYPES = new Set<GithubQueryType>(["team_open_prs", "team_review_requests"]);

export function formatInstantQueryResult(result: GithubQueryResult): string {
  const title = QUERY_TITLES[result.queryType] || result.queryType;

  if (!result.prs) return `*${title}*\n\n_No results._`;
  if (result.prs.length === 0) return `*${title}*\n\n_None found._`;

  const isTeam = TEAM_QUERY_TYPES.has(result.queryType);
  const count = result.prs.length;

  if (isTeam) {
    const authors = new Set(result.prs.map((p) => p.author)).size;
    const subtitle = `_${count} PR${count === 1 ? "" : "s"} across ${authors} contributor${authors === 1 ? "" : "s"}_`;
    return `*${title}* — ${subtitle}\n\n${formatGroupedPrList(result.prs)}`;
  }

  // For review requests, show author since these are other people's PRs
  const showAuthor = result.queryType === "my_review_requests";
  const subtitle = `_${count} PR${count === 1 ? "" : "s"}_`;
  return `*${title}* — ${subtitle}\n\n${formatFlatPrList(result.prs, { showAuthor })}`;
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
