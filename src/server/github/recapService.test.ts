import { describe, expect, it } from "vitest";
import type { RecapData, TeamRecapData } from "./recapService.js";
import { buildMyRecapPrompt, buildTeamRecapPrompt } from "./recapService.js";
import { makePr as _makePr } from "./testHelpers.js";

/** Wrapper that defaults state to 'merged' for recap tests. */
const makePr: typeof _makePr = (overrides = {}) =>
  _makePr({
    state: "merged",
    additions: 50,
    deletions: 10,
    changed_files: 3,
    merged_at: new Date("2026-01-02"),
    ...overrides,
  });

describe("buildMyRecapPrompt", () => {
  it("includes PR details in the prompt", () => {
    const data: RecapData = {
      mergedPrs: [makePr()],
      reviewedPrs: [],
      totalAdditions: 50,
      totalDeletions: 10,
      reposTouched: ["org/repo"],
    };
    const prompt = buildMyRecapPrompt(data, "7d");
    expect(prompt).toContain("PRs Merged (1)");
    expect(prompt).toContain("org/repo#1");
    expect(prompt).toContain("Fix bug");
    expect(prompt).toContain("+50/-10");
    expect(prompt).toContain("org/repo");
    expect(prompt).toContain("past 7d");
  });

  it("includes PR body description when available", () => {
    const data: RecapData = {
      mergedPrs: [makePr({ body: "This fixes the cache invalidation race condition" })],
      reviewedPrs: [],
      totalAdditions: 50,
      totalDeletions: 10,
      reposTouched: ["org/repo"],
    };
    const prompt = buildMyRecapPrompt(data, "7d");
    expect(prompt).toContain("Description: This fixes the cache invalidation race condition");
  });

  it("truncates body at 500 chars in prompt", () => {
    const longBody = "A".repeat(600);
    const data: RecapData = {
      mergedPrs: [makePr({ body: longBody })],
      reviewedPrs: [],
      totalAdditions: 50,
      totalDeletions: 10,
      reposTouched: ["org/repo"],
    };
    const prompt = buildMyRecapPrompt(data, "7d");
    // Body in prompt should be truncated to 500 chars
    const bodyMatch = prompt.match(/Description: (A+)/);
    expect(bodyMatch).toBeTruthy();
    expect(bodyMatch?.[1].length).toBe(500);
  });

  it("includes reviewed PRs section", () => {
    const data: RecapData = {
      mergedPrs: [],
      reviewedPrs: [makePr({ author: "bob", title: "Bob's feature" })],
      totalAdditions: 0,
      totalDeletions: 0,
      reposTouched: [],
    };
    const prompt = buildMyRecapPrompt(data, "14d");
    expect(prompt).toContain("PRs Reviewed (1)");
    expect(prompt).toContain("Bob's feature");
    expect(prompt).toContain("by bob");
  });

  it("shows (none) for empty sections", () => {
    const data: RecapData = {
      mergedPrs: [],
      reviewedPrs: [],
      totalAdditions: 0,
      totalDeletions: 0,
      reposTouched: [],
    };
    const prompt = buildMyRecapPrompt(data, "7d");
    expect(prompt).toContain("PRs Merged (0)");
    expect(prompt).toContain("(none)");
  });

  it("defaults time range to 7d", () => {
    const data: RecapData = {
      mergedPrs: [],
      reviewedPrs: [],
      totalAdditions: 0,
      totalDeletions: 0,
      reposTouched: [],
    };
    const prompt = buildMyRecapPrompt(data);
    expect(prompt).toContain("past 7d");
  });
});

describe("buildTeamRecapPrompt", () => {
  it("includes team member sections", () => {
    const data: TeamRecapData = {
      members: [
        {
          username: "alice",
          recap: {
            mergedPrs: [makePr()],
            reviewedPrs: [],
            totalAdditions: 50,
            totalDeletions: 10,
            reposTouched: ["org/repo"],
          },
        },
        {
          username: "bob",
          recap: {
            mergedPrs: [
              makePr({ _id: "org/repo#2", number: 2, author: "bob", title: "Add feature" }),
            ],
            reviewedPrs: [makePr()],
            totalAdditions: 100,
            totalDeletions: 20,
            reposTouched: ["org/repo"],
          },
        },
      ],
      totalPrsMerged: 2,
      totalAdditions: 150,
      totalDeletions: 30,
      reposActive: ["org/repo"],
    };
    const prompt = buildTeamRecapPrompt(data, "7d");
    expect(prompt).toContain("### alice (1 merged, 0 reviewed)");
    expect(prompt).toContain("### bob (1 merged, 1 reviewed)");
    expect(prompt).toContain("2 PRs merged");
    expect(prompt).toContain("1 repos");
    expect(prompt).toContain("+150 / -30");
  });

  it("truncates body at 300 chars for team recaps", () => {
    const longBody = "B".repeat(400);
    const data: TeamRecapData = {
      members: [
        {
          username: "alice",
          recap: {
            mergedPrs: [makePr({ body: longBody })],
            reviewedPrs: [],
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
    const prompt = buildTeamRecapPrompt(data, "7d");
    const bodyMatch = prompt.match(/Description: (B+)/);
    expect(bodyMatch).toBeTruthy();
    expect(bodyMatch?.[1].length).toBe(300);
  });
});
