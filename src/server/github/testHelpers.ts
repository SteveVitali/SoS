import type { GitHubPrDoc } from "../../shared/githubTypes.js";

/** Create a test GitHubPrDoc with sensible defaults and optional overrides. */
export function makePr(overrides: Partial<GitHubPrDoc> = {}): GitHubPrDoc {
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
