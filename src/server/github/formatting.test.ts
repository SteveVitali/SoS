import { describe, expect, it } from "vitest";
import {
  buildMyRecapPrompt,
  buildTeamRecapPrompt,
  formatInstantQueryResult,
  formatRecapResult,
} from "./formatting.js";
import type { GithubQueryResult, PrResult, RecapData } from "./queries.js";

function makePr(overrides: Partial<PrResult> = {}): PrResult {
  return {
    title: "Fix bug in auth",
    url: "https://github.com/org/repo/pull/42",
    repo: "org/repo",
    author: "alice",
    number: 42,
    state: "OPEN",
    createdAt: "2025-02-20T00:00:00Z",
    updatedAt: "2025-02-21T00:00:00Z",
    labels: [],
    ...overrides,
  };
}

describe("formatInstantQueryResult", () => {
  it("formats my_review_requests with PRs", () => {
    const result: GithubQueryResult = {
      queryType: "my_review_requests",
      prs: [makePr(), makePr({ number: 43, title: "Add tests" })],
    };
    const output = formatInstantQueryResult(result);
    expect(output).toContain("PRs awaiting your review");
    expect(output).toContain("2 results");
    expect(output).toContain("org/repo#42");
    expect(output).toContain("org/repo#43");
  });

  it("formats empty PR list", () => {
    const result: GithubQueryResult = { queryType: "my_open_prs", prs: [] };
    const output = formatInstantQueryResult(result);
    expect(output).toContain("Your open PRs");
    expect(output).toContain("None found.");
  });

  it("includes draft indicator", () => {
    const result: GithubQueryResult = {
      queryType: "my_open_prs",
      prs: [makePr({ isDraft: true })],
    };
    const output = formatInstantQueryResult(result);
    expect(output).toContain("_(draft)_");
  });

  it("includes review decision emoji", () => {
    const result: GithubQueryResult = {
      queryType: "my_open_prs",
      prs: [makePr({ reviewDecision: "APPROVED" })],
    };
    const output = formatInstantQueryResult(result);
    expect(output).toContain("✅ Approved");
  });

  it("includes labels", () => {
    const result: GithubQueryResult = {
      queryType: "my_open_prs",
      prs: [makePr({ labels: ["bug", "urgent"] })],
    };
    const output = formatInstantQueryResult(result);
    expect(output).toContain("`bug`");
    expect(output).toContain("`urgent`");
  });

  it("formats team_review_requests as flat PR list", () => {
    const prs = [
      makePr({ number: 42 }),
      makePr({ number: 43, title: "Add tests" }),
      makePr({ number: 44, title: "Fix auth" }),
    ];
    const result: GithubQueryResult = { queryType: "team_review_requests", prs };
    const output = formatInstantQueryResult(result);
    expect(output).toContain("Team review requests");
    expect(output).toContain("3 results");
    expect(output).toContain("org/repo#42");
    expect(output).toContain("org/repo#43");
  });

  it("handles empty team reviews", () => {
    const result: GithubQueryResult = { queryType: "team_review_requests", prs: [] };
    const output = formatInstantQueryResult(result);
    expect(output).toContain("None found.");
  });

  it("handles missing data gracefully", () => {
    const result: GithubQueryResult = { queryType: "my_merged_prs" };
    const output = formatInstantQueryResult(result);
    expect(output).toContain("No results.");
  });
});

describe("buildMyRecapPrompt", () => {
  it("includes stats and PR details", () => {
    const data: RecapData = {
      mergedPrs: [makePr({ additions: 100, deletions: 20, mergedAt: "2025-02-21" })],
      reviewsCompleted: [makePr({ number: 99, author: "bob" })],
      totalAdditions: 100,
      totalDeletions: 20,
      reposTouched: ["org/repo"],
    };
    const prompt = buildMyRecapPrompt(data, "7d");
    expect(prompt).toContain("PRs merged: 1");
    expect(prompt).toContain("Lines added: 100");
    expect(prompt).toContain("Lines removed: 20");
    expect(prompt).toContain("org/repo");
    expect(prompt).toContain("PRs reviewed (by others, merged in range): 1");
    expect(prompt).toContain("## Merged PRs");
    expect(prompt).toContain("## Reviews completed");
    expect(prompt).toContain("## Instructions");
  });

  it("omits sections when empty", () => {
    const data: RecapData = {
      mergedPrs: [],
      reviewsCompleted: [],
      totalAdditions: 0,
      totalDeletions: 0,
      reposTouched: [],
    };
    const prompt = buildMyRecapPrompt(data);
    expect(prompt).not.toContain("## Merged PRs");
    expect(prompt).not.toContain("## Reviews completed");
    expect(prompt).toContain("PRs merged: 0");
  });
});

describe("buildTeamRecapPrompt", () => {
  it("includes team stats and per-member breakdowns", () => {
    const data = {
      members: [
        {
          username: "alice",
          recap: {
            mergedPrs: [makePr({ additions: 50, deletions: 10, mergedAt: "2025-02-21" })],
            reviewsCompleted: [],
            totalAdditions: 50,
            totalDeletions: 10,
            reposTouched: ["org/repo"],
          },
        },
      ],
      totalPrsMerged: 1,
      totalAdditions: 50,
      totalDeletions: 10,
      reposActive: ["org/repo"],
    };
    const prompt = buildTeamRecapPrompt(data, "14d");
    expect(prompt).toContain("Total PRs merged: 1");
    expect(prompt).toContain("## alice");
    expect(prompt).toContain("Contributors: alice");
    expect(prompt).toContain("past 14d");
  });
});

describe("formatRecapResult", () => {
  it("formats my_recap with title and summary", () => {
    const output = formatRecapResult("my_recap", "You shipped 3 PRs.", "7d");
    expect(output).toContain("📊 *Your recap (7d)*");
    expect(output).toContain("You shipped 3 PRs.");
  });

  it("formats team_recap with title and summary", () => {
    const output = formatRecapResult("team_recap", "The team shipped 10 PRs.", "2w");
    expect(output).toContain("📊 *Team recap (2w)*");
    expect(output).toContain("The team shipped 10 PRs.");
  });

  it("defaults time range to 7d", () => {
    const output = formatRecapResult("my_recap", "Summary text.");
    expect(output).toContain("(7d)");
  });
});
