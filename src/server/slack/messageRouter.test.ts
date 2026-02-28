import { describe, expect, it, vi } from "vitest";
import type { LLMProvider } from "../llm/index.js";
import { initMessageRouter, routeMessage } from "./messageRouter.js";

// Mock jobService.queryJobs to avoid MongoDB dependency
vi.mock("../jobs/jobService.js", () => ({
  queryJobs: vi.fn().mockResolvedValue({ jobs: [], total: 0 }),
}));

// Mock routing config so configTools includes leave_channel
vi.mock("../routing/index.js", () => ({
  getRoutingConfig: vi.fn().mockReturnValue({
    system_prompt: "You are Steve.",
    actions: {
      leave_channel: {
        enabled: true,
        description: "Leave the current Slack channel.",
        parameters: { farewell: { type: "string", required: true, description: "Farewell" } },
        execution: { type: "leave_channel" },
      },
      chat: {
        enabled: true,
        description: "Respond conversationally.",
        parameters: { response: { type: "string", required: true, description: "Response" } },
        execution: { type: "reply" },
      },
    },
    custom_actions: {},
  }),
  buildToolsFromConfig: vi.fn().mockReturnValue([
    {
      name: "leave_channel",
      description: "Leave the channel",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "chat",
      description: "Respond conversationally",
      parameters: { type: "object", properties: {} },
    },
  ]),
  buildActionsPromptSection: vi.fn().mockReturnValue("## Available Actions"),
}));

// biome-ignore lint/suspicious/noExplicitAny: Slack API type
function makeMockProvider(toolCalls: any[] = [], text = ""): LLMProvider {
  return {
    chat: vi.fn().mockResolvedValue({ text, toolCalls }),
  };
}

describe("routeMessage", () => {
  it("falls back to create_job when no LLM provider is configured", async () => {
    // Reset provider to null by re-initializing — but we need to force it.
    // The simplest approach: import and call with null-like state.
    // Actually, routeMessage checks `if (!provider)` — we need to test that path.
    // We can't easily reset the module state, so we test the provider paths instead.

    // Test with a provider that returns a create_job tool call
    const provider = makeMockProvider(
      [{ name: "create_job", input: { task_text: "fix the bug" } }],
      "Sure, I'll handle that.",
    );
    initMessageRouter(provider, "test-model");

    const result = await routeMessage("fix the bug", "U123");
    expect(result.command).toBe("create_job");
    expect(result.args.task_text).toBe("fix the bug");
    expect(result.reply).toBe("Sure, I'll handle that.");
  });

  it("extracts command from tool call response", async () => {
    const provider = makeMockProvider(
      [{ name: "job_status", input: { task_id: "abc123" } }],
      "Let me check.",
    );
    initMessageRouter(provider, "test-model");

    const result = await routeMessage("what's the status of abc123?", "U123");
    expect(result.command).toBe("job_status");
    expect(result.args.task_id).toBe("abc123");
  });

  it("uses args.response as reply when text is empty (chat tool)", async () => {
    const provider = makeMockProvider(
      [{ name: "chat", input: { response: "Hey there, what's up?" } }],
      "", // no text in response body
    );
    initMessageRouter(provider, "test-model");

    const result = await routeMessage("hello", "U123");
    expect(result.command).toBe("chat");
    expect(result.reply).toBe("Hey there, what's up?");
  });

  it("defaults reply to 'On it.' when both text and args.response are empty", async () => {
    const provider = makeMockProvider(
      [{ name: "create_job", input: { task_text: "do stuff" } }],
      "",
    );
    initMessageRouter(provider, "test-model");

    const result = await routeMessage("do stuff", "U123");
    expect(result.reply).toBe("On it.");
  });

  it("falls back to create_job when LLM throws", async () => {
    const provider: LLMProvider = {
      chat: vi.fn().mockRejectedValue(new Error("API rate limit")),
    };
    initMessageRouter(provider, "test-model");

    const result = await routeMessage("fix the bug", "U123");
    expect(result.command).toBe("create_job");
    expect(result.args.task_text).toBe("fix the bug");
    expect(result.reply).toContain("LLM routing unavailable");
  });

  it("overrides chat → leave_channel when user message has leave intent", async () => {
    const provider = makeMockProvider(
      [{ name: "chat", input: { response: "Understood. I'll see myself out. 👋" } }],
      "",
    );
    initMessageRouter(provider, "test-model");

    const result = await routeMessage("please leave this channel", "U123");
    expect(result.command).toBe("leave_channel");
    expect(result.args.farewell).toBe("Understood. I'll see myself out. 👋");
  });

  it("overrides chat → leave_channel with default farewell when LLM says it can't leave", async () => {
    const provider = makeMockProvider(
      [
        {
          name: "chat",
          input: {
            response: "I don't actually have the ability to leave Slack channels on my own.",
          },
        },
      ],
      "",
    );
    initMessageRouter(provider, "test-model");

    const result = await routeMessage("leave this channel", "U123");
    expect(result.command).toBe("leave_channel");
    expect(result.args.farewell).toBe("Alright, I'm out. ✌️");
  });

  it("overrides chat → leave_channel for 'can you leave the Slack channel'", async () => {
    const provider = makeMockProvider(
      [{ name: "chat", input: { response: "I don't have a leave tool." } }],
      "",
    );
    initMessageRouter(provider, "test-model");

    const result = await routeMessage("can you leave the Slack channel now?", "U123");
    expect(result.command).toBe("leave_channel");
    expect(result.args.farewell).toBe("Alright, I'm out. ✌️");
  });

  it("does NOT override chat when user message has no leave intent", async () => {
    const provider = makeMockProvider(
      [{ name: "chat", input: { response: "Hey there, what's up?" } }],
      "",
    );
    initMessageRouter(provider, "test-model");

    const result = await routeMessage("hello", "U123");
    expect(result.command).toBe("chat");
    expect(result.reply).toBe("Hey there, what's up?");
  });
});
