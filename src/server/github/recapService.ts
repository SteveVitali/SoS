/**
 * Inline recap execution service.
 *
 * Fetches PR data from MongoDB and generates narrative summaries via the
 * LLM provider. Replaces the old github_summary background job type which
 * used gh CLI + claude CLI.
 */

import type { GitHubPrDoc } from "../../shared/githubTypes.js";
import { createLogger } from "../../shared/logger.js";
import { getModelForRole } from "../../shared/modelConfig.js";
import { resolveGitHubConfig } from "../githubSync/githubConfig.js";
import { getOrgMembersCollection, getPrsCollection } from "../githubSync/githubRepo.js";
import type { LLMProvider } from "../llm/llmProvider.js";
import { parseTimeRange } from "./mongoQueries.js";

const log = createLogger("server:github:recapService");

// --- Public types ---

export interface RecapData {
  mergedPrs: GitHubPrDoc[];
  reviewedPrs: GitHubPrDoc[];
  totalAdditions: number;
  totalDeletions: number;
  reposTouched: string[];
}

export interface TeamRecapData {
  members: Array<{ username: string; recap: RecapData }>;
  totalPrsMerged: number;
  totalAdditions: number;
  totalDeletions: number;
  reposActive: string[];
}

// --- Data Fetchers (MongoDB only) ---

export async function fetchMyRecapData(
  org: string,
  username: string,
  since: Date,
): Promise<RecapData> {
  const prsCol = getPrsCollection();
  const userLower = username.toLowerCase();

  const mergedPrs = await prsCol
    .find({
      org,
      author: userLower,
      state: "merged",
      merged_at: { $gte: since },
    })
    .sort({ merged_at: -1 })
    .toArray();

  const reviewedPrs = await prsCol
    .find({
      org,
      state: "merged",
      merged_at: { $gte: since },
      "reviews.author": userLower,
      author: { $ne: userLower },
    })
    .sort({ merged_at: -1 })
    .limit(200)
    .toArray();

  return {
    mergedPrs,
    reviewedPrs,
    totalAdditions: mergedPrs.reduce((s, pr) => s + (pr.additions || 0), 0),
    totalDeletions: mergedPrs.reduce((s, pr) => s + (pr.deletions || 0), 0),
    reposTouched: [...new Set(mergedPrs.map((pr) => pr.repo))],
  };
}

export async function fetchTeamRecapData(
  org: string,
  teamSlug: string,
  since: Date,
): Promise<TeamRecapData> {
  const members = await getOrgMembersCollection()
    .find({ org, teams: teamSlug })
    .project<{ _id: string }>({ _id: 1 })
    .toArray();

  // Fetch in batches of 10 to limit concurrent MongoDB connections
  const BATCH_SIZE = 10;
  const allRecaps: Array<{ username: string; recap: RecapData }> = [];
  for (let i = 0; i < members.length; i += BATCH_SIZE) {
    const batch = members.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (member) => {
        const recap = await fetchMyRecapData(org, member._id, since);
        return { username: member._id, recap };
      }),
    );
    allRecaps.push(...results);
  }
  const memberRecaps = allRecaps.filter(
    (m) => m.recap.mergedPrs.length > 0 || m.recap.reviewedPrs.length > 0,
  );
  memberRecaps.sort((a, b) => b.recap.mergedPrs.length - a.recap.mergedPrs.length);

  return {
    members: memberRecaps,
    totalPrsMerged: memberRecaps.reduce((s, m) => s + m.recap.mergedPrs.length, 0),
    totalAdditions: memberRecaps.reduce((s, m) => s + m.recap.totalAdditions, 0),
    totalDeletions: memberRecaps.reduce((s, m) => s + m.recap.totalDeletions, 0),
    reposActive: [...new Set(memberRecaps.flatMap((m) => m.recap.reposTouched))],
  };
}

// --- Prompt Builders ---

function prToPromptLine(pr: GitHubPrDoc, bodyMaxChars: number): string {
  const desc = pr.body ? `\n  Description: ${pr.body.slice(0, bodyMaxChars)}` : "";
  return `- ${pr.repo}#${pr.number}: ${pr.title} (+${pr.additions || 0}/-${pr.deletions || 0})${desc}`;
}

export function buildMyRecapPrompt(data: RecapData, timeRange?: string): string {
  const range = timeRange || "7d";
  const prLines = data.mergedPrs.map((pr) => prToPromptLine(pr, 500)).join("\n");
  const reviewLines = data.reviewedPrs
    .map((pr) => `- ${pr.repo}#${pr.number}: ${pr.title} (by ${pr.author})`)
    .join("\n");

  return `Generate a concise recap of this developer's work over the past ${range}.

## PRs Merged (${data.mergedPrs.length})
${prLines || "(none)"}

## PRs Reviewed (${data.reviewedPrs.length})
${reviewLines || "(none)"}

## Stats
- Repos: ${data.reposTouched.join(", ") || "(none)"}
- Lines: +${data.totalAdditions} / -${data.totalDeletions}

Write a brief, narrative summary suitable for Slack. Use bullet points for key items. Be concise.`;
}

export function buildTeamRecapPrompt(data: TeamRecapData, timeRange?: string): string {
  const range = timeRange || "7d";
  const memberSections = data.members
    .map((m) => {
      const prLines = m.recap.mergedPrs.map((pr) => prToPromptLine(pr, 300)).join("\n");
      return `### ${m.username} (${m.recap.mergedPrs.length} merged, ${m.recap.reviewedPrs.length} reviewed)\n${prLines}`;
    })
    .join("\n\n");

  return `Generate a concise team recap for the past ${range}.

## Team Activity (${data.totalPrsMerged} PRs merged, ${data.reposActive.length} repos)
Lines: +${data.totalAdditions} / -${data.totalDeletions}

${memberSections}

Write a team summary suitable for Slack. Highlight key themes, notable contributions, and cross-team patterns. Be concise.`;
}

// --- Inline Execution ---

export async function executeRecapInline(
  queryType: "my_recap" | "team_recap",
  params: {
    org?: string;
    team_slug?: string;
    github_username?: string;
    time_range?: string;
  },
  llmProvider: LLMProvider,
): Promise<string> {
  const config = await resolveGitHubConfig();
  const org = (params.org || config.org).toLowerCase();
  const since = parseTimeRange(params.time_range);
  const range = params.time_range || "7d";

  let prompt: string;
  if (queryType === "my_recap") {
    const username = params.github_username || config.username || "";
    const data = await fetchMyRecapData(org, username, since);
    if (data.mergedPrs.length === 0 && data.reviewedPrs.length === 0) {
      return `📊 *My Recap (${range})*\n\n_No activity found for this period._`;
    }
    prompt = buildMyRecapPrompt(data, params.time_range);
    log.info("Generating my recap inline", {
      org,
      username,
      mergedPrs: data.mergedPrs.length,
      reviewedPrs: data.reviewedPrs.length,
    });
  } else {
    const teamSlug = params.team_slug || config.teamSlug;
    const data = await fetchTeamRecapData(org, teamSlug, since);
    if (data.members.length === 0) {
      return `📊 *Team Recap (${range})*\n\n_No team activity found for this period._`;
    }
    prompt = buildTeamRecapPrompt(data, params.time_range);
    log.info("Generating team recap inline", {
      org,
      teamSlug,
      members: data.members.length,
      totalPrs: data.totalPrsMerged,
    });
  }

  const model = getModelForRole("routing");
  const RECAP_TIMEOUT_MS = 30_000;
  let timeoutId: ReturnType<typeof setTimeout>;
  const result = await Promise.race([
    llmProvider
      .chat({
        system:
          "You generate concise developer activity recap summaries for Slack. " +
          "Use markdown formatting suitable for Slack (bold with *, bullets with •). " +
          "Be direct and informative — no filler.",
        messages: [{ role: "user", content: prompt }],
        tools: [],
        maxTokens: 2048,
        model,
      })
      .then((r) => {
        clearTimeout(timeoutId);
        return r;
      }),
    new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("Recap LLM call timed out")), RECAP_TIMEOUT_MS);
    }),
  ]);

  const label = queryType === "my_recap" ? "My" : "Team";
  return `📊 *${label} Recap (${range})*\n\n${result.text}`;
}
