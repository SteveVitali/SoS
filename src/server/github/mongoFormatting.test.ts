import { describe, expect, it } from "vitest";
import type { GitHubPrDoc } from "../../shared/githubTypes.js";
import { formatInstantQueryFromMongo, formatPrLine } from "./mongoFormatting.js";
import type { InstantQueryResult } from "./mongoQueries.js";

function makePr(overrides: Partial<GitHubPrDoc> = {}): GitHubPrDoc {
  return {
    _id: "org/repo#1",
    org: "org",
    repo: "org/repo",
    number: 1,
    title: "Fix bug",
    author: "alice",
    state: "open",
    is_draft: false,
    head_ref: "fix-bug",
    base_ref: "main",
    additions: 10,
    deletions: 3,
    changed_files: 2,
    labels: [],
    created_at: new Date("2026-01-01"),
    updated_at: new Date("2026-01-02"),
    requested_reviewers: [],
    reviews: [],
    synced_at: new Date(),
    ...overrides,
  };
}

const fullSync = { hasPrData: true, hasTeamData: true, backfillPercent: 100 };
const noSync = { hasPrData: false, hasTeamData: false, backfillPercent: 0 };
const partialSync = { hasPrData: true, hasTeamData: true, backfillPercent: 75 };

describe("formatPrLine", () => {
  it("formats a basic PR line with size stats", () => {
    const line = formatPrLine(makePr());
    expect(line).toContain("org/repo#1");
    expect(line).toContain("Fix bug");
    expect(line).toContain("+10/-3");
  });

  it("shows draft indicator", () => {
    const line = formatPrLine(makePr({ is_draft: true }));
    expect(line).toContain("_(draft)_");
  });

  it("shows review decision emoji", () => {
    const approved = formatPrLine(makePr({ review_decision: "APPROVED" }));
    expect(approved).toContain("✅");

    const changes = formatPrLine(makePr({ review_decision: "CHANGES_REQUESTED" }));
    expect(changes).toContain("🔴");
  });

  it("shows unresolved comment count", () => {
    const line = formatPrLine(
      makePr({
        comment_stats: {
          total_threads: 5,
          total_comments: 8,
          unresolved_threads: 3,
          unaddressed_threads: 2,
        },
      }),
    );
    expect(line).toContain("💬3");
  });

  it("shows author when requested", () => {
    const line = formatPrLine(makePr(), { showAuthor: true });
    expect(line).toContain("by _alice_");
  });

  it("omits size stats when both are zero", () => {
    const line = formatPrLine(makePr({ additions: 0, deletions: 0 }));
    expect(line).not.toContain("+0/-0");
  });
});

describe("formatInstantQueryFromMongo", () => {
  it("formats empty results with none-found message", () => {
    const result: InstantQueryResult = {
      queryType: "my_open_prs",
      prs: [],
      syncStatus: fullSync,
    };
    const output = formatInstantQueryFromMongo(result);
    expect(output).toContain("Your Open PRs");
    expect(output).toContain("None found.");
  });

  it("shows sync-not-ready message when no PR data", () => {
    const result: InstantQueryResult = {
      queryType: "my_open_prs",
      prs: [],
      syncStatus: noSync,
    };
    const output = formatInstantQueryFromMongo(result);
    expect(output).toContain("GitHub sync hasn't completed yet");
  });

  it("shows backfill percentage when incomplete", () => {
    const result: InstantQueryResult = {
      queryType: "my_open_prs",
      prs: [makePr()],
      syncStatus: partialSync,
    };
    const output = formatInstantQueryFromMongo(result);
    expect(output).toContain("Backfill 75%");
  });

  it("does not show backfill note when complete", () => {
    const result: InstantQueryResult = {
      queryType: "my_open_prs",
      prs: [makePr()],
      syncStatus: fullSync,
    };
    const output = formatInstantQueryFromMongo(result);
    expect(output).not.toContain("Backfill");
  });

  it("formats PR count correctly for single PR", () => {
    const result: InstantQueryResult = {
      queryType: "my_open_prs",
      prs: [makePr()],
      syncStatus: fullSync,
    };
    const output = formatInstantQueryFromMongo(result);
    expect(output).toContain("_1 PR_");
  });

  it("formats PR count correctly for multiple PRs", () => {
    const result: InstantQueryResult = {
      queryType: "my_open_prs",
      prs: [makePr(), makePr({ _id: "org/repo#2", number: 2, title: "Add feature" })],
      syncStatus: fullSync,
    };
    const output = formatInstantQueryFromMongo(result);
    expect(output).toContain("_2 PRs_");
  });

  it("groups team queries by author", () => {
    const result: InstantQueryResult = {
      queryType: "team_open_prs",
      prs: [
        makePr({ author: "alice" }),
        makePr({ _id: "org/repo#2", number: 2, author: "bob", title: "Bob's PR" }),
      ],
      syncStatus: fullSync,
    };
    const output = formatInstantQueryFromMongo(result);
    expect(output).toContain("*alice* (1):");
    expect(output).toContain("*bob* (1):");
  });

  it("uses correct title for each query type", () => {
    const types = [
      { type: "my_review_requests", expected: "PRs Awaiting Your Review" },
      { type: "my_open_prs", expected: "Your Open PRs" },
      { type: "my_merged_prs", expected: "Your Recently Merged PRs" },
      { type: "team_open_prs", expected: "Team Open PRs" },
      { type: "team_review_requests", expected: "Team Outstanding Reviews" },
    ] as const;

    for (const { type, expected } of types) {
      const result: InstantQueryResult = {
        queryType: type,
        prs: [],
        syncStatus: fullSync,
      };
      const output = formatInstantQueryFromMongo(result);
      expect(output).toContain(expected);
    }
  });
});
