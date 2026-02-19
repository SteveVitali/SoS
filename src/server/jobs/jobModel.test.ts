import { describe, expect, it } from "vitest";
import {
  ClaimJobSchema,
  CompleteJobSchema,
  CreateJobFromSlackSchema,
  CreateJobFromWebSchema,
  FailJobSchema,
  HeartbeatSchema,
  WorkerEventSchema,
} from "./jobModel.js";

describe("CreateJobFromSlackSchema", () => {
  const valid = {
    event_id: "evt_1",
    requested_by: "U_OWNER",
    task_text: "fix the bug",
    channel_id: "C123",
    thread_ts: "1234567890.123456",
  };

  it("accepts a valid minimal payload", () => {
    expect(CreateJobFromSlackSchema.parse(valid)).toMatchObject(valid);
  });

  it("accepts all optional fields", () => {
    const full = {
      ...valid,
      slack_requester: "U_REQ",
      message_ts: "111.222",
      repo_hint: "my-repo",
      test_level: "full",
      ci_fix_enabled: true,
      reviewers: ["alice", "bob"],
      attachments: [
        {
          file_id: "F1",
          filename: "screenshot.png",
          mimetype: "image/png",
          size_bytes: 1024,
          base64: "abc123",
        },
      ],
    };
    expect(() => CreateJobFromSlackSchema.parse(full)).not.toThrow();
  });

  it("rejects missing event_id", () => {
    const { event_id: _, ...rest } = valid;
    expect(() => CreateJobFromSlackSchema.parse(rest)).toThrow();
  });

  it("rejects missing channel_id", () => {
    const { channel_id: _, ...rest } = valid;
    expect(() => CreateJobFromSlackSchema.parse(rest)).toThrow();
  });

  it("rejects invalid test_level", () => {
    expect(() => CreateJobFromSlackSchema.parse({ ...valid, test_level: "extreme" })).toThrow();
  });
});

describe("CreateJobFromWebSchema", () => {
  it("accepts valid payload", () => {
    const result = CreateJobFromWebSchema.parse({
      requested_by: "user1",
      task_text: "implement feature X",
    });
    expect(result.requested_by).toBe("user1");
  });

  it("rejects empty requested_by", () => {
    expect(() => CreateJobFromWebSchema.parse({ requested_by: "", task_text: "test" })).toThrow();
  });

  it("rejects empty task_text", () => {
    expect(() => CreateJobFromWebSchema.parse({ requested_by: "user1", task_text: "" })).toThrow();
  });
});

describe("ClaimJobSchema", () => {
  it("accepts valid claim", () => {
    const result = ClaimJobSchema.parse({
      requested_by: "U_OWNER",
      node_id: "worker-1",
      lease_seconds: 120,
    });
    expect(result.lease_seconds).toBe(120);
  });

  it("rejects non-positive lease_seconds", () => {
    expect(() =>
      ClaimJobSchema.parse({ requested_by: "U", node_id: "w", lease_seconds: 0 }),
    ).toThrow();
  });

  it("rejects non-integer lease_seconds", () => {
    expect(() =>
      ClaimJobSchema.parse({ requested_by: "U", node_id: "w", lease_seconds: 1.5 }),
    ).toThrow();
  });
});

describe("HeartbeatSchema", () => {
  it("accepts valid heartbeat", () => {
    expect(() => HeartbeatSchema.parse({ node_id: "w1", extend_seconds: 30 })).not.toThrow();
  });

  it("rejects non-positive extend_seconds", () => {
    expect(() => HeartbeatSchema.parse({ node_id: "w1", extend_seconds: -1 })).toThrow();
  });
});

describe("CompleteJobSchema", () => {
  it("accepts minimal completion", () => {
    expect(() =>
      CompleteJobSchema.parse({ node_id: "w1", result_summary: "all good" }),
    ).not.toThrow();
  });

  it("accepts full completion with CI data", () => {
    const result = CompleteJobSchema.parse({
      node_id: "w1",
      result_summary: "done",
      pr_urls: ["https://github.com/pull/1"],
      ci: {
        provider: "github_actions",
        runs: [
          {
            url: "https://ci.example.com/run/1",
            status: "completed",
            conclusion: "success",
            updated_at: "2025-01-01T00:00:00Z",
          },
        ],
      },
    });
    // Date coercion should work
    expect(result.ci?.runs?.[0].updated_at).toBeInstanceOf(Date);
  });
});

describe("FailJobSchema", () => {
  it("accepts valid failure", () => {
    expect(() =>
      FailJobSchema.parse({
        node_id: "w1",
        error: { message: "something broke" },
      }),
    ).not.toThrow();
  });

  it("rejects missing error.message", () => {
    expect(() => FailJobSchema.parse({ node_id: "w1", error: { code: "ERR" } })).toThrow();
  });
});

describe("WorkerEventSchema", () => {
  it("accepts event with payload", () => {
    expect(() =>
      WorkerEventSchema.parse({
        node_id: "w1",
        type: "PR_CREATED",
        payload: { url: "https://github.com/pull/1" },
      }),
    ).not.toThrow();
  });

  it("accepts event without payload", () => {
    expect(() => WorkerEventSchema.parse({ node_id: "w1", type: "CLAUDE_STARTED" })).not.toThrow();
  });
});
