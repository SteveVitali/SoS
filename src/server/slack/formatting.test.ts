import { describe, expect, it } from "vitest";
import type { JobDoc } from "../../shared/types.js";
import {
  fmtCanceled,
  fmtCiFailed,
  fmtCiFixing,
  fmtCiGreen,
  fmtClaimed,
  fmtDone,
  fmtEvent,
  fmtFailed,
  fmtPrCreated,
  fmtQueued,
} from "./formatting.js";

function makeJob(overrides: Partial<JobDoc> = {}): JobDoc {
  return {
    task_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    source: { type: "slack_app_mention" },
    requested_by: "U_OWNER",
    status: "QUEUED",
    created_at: new Date(),
    updated_at: new Date(),
    task_text: "fix the login bug",
    events: [],
    ...overrides,
  };
}

describe("fmtQueued", () => {
  it("includes task_id and slack_requester mention", () => {
    const job = makeJob({ slack_requester: "U123" });
    const result = fmtQueued(job);
    expect(result).toContain("Queued");
    expect(result).toContain("task_id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(result).toContain("<@U123>");
  });

  it("falls back to requested_by when slack_requester is absent", () => {
    const job = makeJob({ slack_requester: undefined });
    expect(fmtQueued(job)).toContain("<@U_OWNER>");
  });

  it("includes parent_task_id when present", () => {
    const job = makeJob({ parent_task_id: "parent-1234" });
    expect(fmtQueued(job)).toContain("Retry of `parent-1234`");
  });

  it("omits parent line when not a retry", () => {
    const job = makeJob();
    expect(fmtQueued(job)).not.toContain("Retry");
  });
});

describe("fmtClaimed", () => {
  it("includes worker node and attempt", () => {
    const job = makeJob({ claimed_by: "worker-1", attempt: 2 });
    const result = fmtClaimed(job);
    expect(result).toContain("Claimed");
    expect(result).toContain("worker-1");
    expect(result).toContain("attempt 2");
  });

  it("defaults attempt to 1 when missing", () => {
    const job = makeJob({ claimed_by: "w1" });
    expect(fmtClaimed(job)).toContain("attempt 1");
  });
});

describe("fmtPrCreated", () => {
  it("includes PR URL", () => {
    const result = fmtPrCreated(makeJob(), "https://github.com/org/repo/pull/42");
    expect(result).toContain("PR Created");
    expect(result).toContain("https://github.com/org/repo/pull/42");
  });
});

describe("fmtCiFixing", () => {
  it("includes yellow dot, attempt, and summary", () => {
    const result = fmtCiFixing(makeJob(), { attempt: 1, summary: "lint failed" });
    expect(result).toContain("🟡");
    expect(result).toContain("fixing");
    expect(result).toContain("attempt 1");
    expect(result).toContain("lint failed");
  });

  it("handles missing payload fields", () => {
    const result = fmtCiFixing(makeJob(), {});
    expect(result).toContain("🟡");
    expect(result).toContain("attempt 1");
    expect(result).not.toContain("```");
  });
});

describe("fmtCiFailed", () => {
  it("includes red X and summary", () => {
    const result = fmtCiFailed(makeJob(), { summary: "lint failed" });
    expect(result).toContain("CI Failed");
    expect(result).toContain("❌");
    expect(result).toContain("lint failed");
  });

  it("handles missing summary", () => {
    const result = fmtCiFailed(makeJob(), {});
    expect(result).toContain("CI Failed");
    expect(result).not.toContain("```");
  });
});

describe("fmtCiGreen", () => {
  it("includes URL when present", () => {
    const result = fmtCiGreen(makeJob(), { url: "https://ci.example.com/run/1" });
    expect(result).toContain("CI Green");
    expect(result).toContain("https://ci.example.com/run/1");
  });

  it("works without URL", () => {
    const result = fmtCiGreen(makeJob(), {});
    expect(result).toContain("CI Green");
  });
});

describe("fmtDone", () => {
  it("includes PR URLs and summary", () => {
    const job = makeJob({
      pr_urls: ["https://github.com/org/repo/pull/1"],
      result_summary: "Fixed the bug",
    });
    const result = fmtDone(job);
    expect(result).toContain("Done");
    expect(result).toContain("https://github.com/org/repo/pull/1");
    expect(result).toContain("Fixed the bug");
  });

  it("truncates long summaries at 500 chars", () => {
    const job = makeJob({ result_summary: "x".repeat(600) });
    const result = fmtDone(job);
    expect(result).toContain("…");
    // The summary portion should be truncated
    expect(result.length).toBeLessThan(600);
  });

  it("handles missing PR URLs and summary", () => {
    const result = fmtDone(makeJob());
    expect(result).toContain("Done");
    expect(result).not.toContain("PRs:");
  });
});

describe("fmtFailed", () => {
  it("includes error message and PR URLs", () => {
    const job = makeJob({
      error: { message: "TypeError: cannot read property" },
      pr_urls: ["https://github.com/org/repo/pull/5"],
    });
    const result = fmtFailed(job);
    expect(result).toContain("Failed");
    expect(result).toContain("TypeError: cannot read property");
    expect(result).toContain("pull/5");
  });

  it("handles missing error", () => {
    const result = fmtFailed(makeJob());
    expect(result).toContain("Failed");
    expect(result).not.toContain("```");
  });
});

describe("fmtCanceled", () => {
  it("includes task_id", () => {
    expect(fmtCanceled(makeJob())).toContain("Canceled");
    expect(fmtCanceled(makeJob())).toContain("task_id=");
  });
});

describe("fmtEvent", () => {
  it("routes PR_CREATED to fmtPrCreated", () => {
    const result = fmtEvent(makeJob(), "PR_CREATED", { url: "https://pr.url" });
    expect(result).toContain("PR Created");
    expect(result).toContain("https://pr.url");
  });

  it("routes CI_STATUS with success conclusion to fmtCiGreen", () => {
    const result = fmtEvent(makeJob(), "CI_STATUS", { conclusion: "success", url: "https://ci" });
    expect(result).toContain("CI Green");
  });

  it("routes CI_STATUS without success to empty string", () => {
    const result = fmtEvent(makeJob(), "CI_STATUS", { status: "in_progress" });
    expect(result).toBe("");
  });

  it("routes CI_FIXING to fmtCiFixing", () => {
    const result = fmtEvent(makeJob(), "CI_FIXING", { attempt: 1, summary: "tests failed" });
    expect(result).toContain("🟡");
    expect(result).toContain("fixing");
  });

  it("routes DONE to fmtDone", () => {
    const result = fmtEvent(makeJob({ result_summary: "all good" }), "DONE", {});
    expect(result).toContain("Done");
  });

  it("routes FAILED to fmtFailed", () => {
    const result = fmtEvent(makeJob({ error: { message: "oops" } }), "FAILED", {});
    expect(result).toContain("Failed");
  });

  it("routes CANCELED to fmtCanceled", () => {
    expect(fmtEvent(makeJob(), "CANCELED", {})).toContain("Canceled");
  });

  it("falls back to generic for unknown event types", () => {
    const result = fmtEvent(makeJob(), "CUSTOM_EVENT", {});
    expect(result).toContain("Event `CUSTOM_EVENT`");
  });
});
