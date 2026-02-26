import { describe, expect, it } from "vitest";
import type { RoutingConfig } from "./routingTypes.js";
import { buildActionsPromptSection, buildToolsFromConfig } from "./toolBuilder.js";

function makeConfig(overrides?: Partial<RoutingConfig>): RoutingConfig {
  return {
    system_prompt: "Test prompt",
    actions: {
      create_job: {
        enabled: true,
        description: "Create a new coding task",
        routing_hint: "The user wants code written.",
        parameters: {
          task_text: { type: "string", required: true, description: "Task description" },
          repo_hint: { type: "string", description: "Repo hint" },
          test_level: { type: "string", enum: ["fast", "full", "none"], description: "Test level" },
          reviewers: { type: "array", items: { type: "string" }, description: "Reviewers" },
        },
        execution: { type: "create_job" },
      },
      chat: {
        enabled: true,
        description: "Respond conversationally",
        parameters: {
          response: { type: "string", required: true, description: "Response text" },
        },
        execution: { type: "reply" },
      },
      disabled_action: {
        enabled: false,
        description: "This should not appear",
        parameters: {},
        execution: { type: "reply" },
      },
    },
    custom_actions: {
      deploy: {
        enabled: true,
        description: "Deploy a service",
        routing_hint: "User wants to deploy.",
        parameters: {
          service: { type: "string", required: true, description: "Service name" },
          env: { type: "string", enum: ["staging", "production"], description: "Environment" },
        },
        execution: {
          type: "agent_task",
          instructions: "Deploy {{args.service}} to {{args.env}}",
        },
      },
    },
    ...overrides,
  };
}

describe("buildToolsFromConfig", () => {
  it("builds tools from enabled actions", () => {
    const tools = buildToolsFromConfig(makeConfig());
    const names = tools.map((t) => t.name);
    expect(names).toContain("create_job");
    expect(names).toContain("chat");
    expect(names).toContain("deploy");
    expect(names).not.toContain("disabled_action");
  });

  it("converts parameters to JSON schema", () => {
    const tools = buildToolsFromConfig(makeConfig());
    const createJob = tools.find((t) => t.name === "create_job")!;
    expect(createJob.parameters.type).toBe("object");
    expect(createJob.parameters.properties).toHaveProperty("task_text");
    expect(createJob.parameters.properties).toHaveProperty("repo_hint");
    expect(createJob.parameters.required).toEqual(["task_text"]);
  });

  it("includes enum in parameter schema", () => {
    const tools = buildToolsFromConfig(makeConfig());
    const createJob = tools.find((t) => t.name === "create_job")!;
    const testLevel = createJob.parameters.properties.test_level as any;
    expect(testLevel.enum).toEqual(["fast", "full", "none"]);
  });

  it("includes items for array parameters", () => {
    const tools = buildToolsFromConfig(makeConfig());
    const createJob = tools.find((t) => t.name === "create_job")!;
    const reviewers = createJob.parameters.properties.reviewers as any;
    expect(reviewers.type).toBe("array");
    expect(reviewers.items).toEqual({ type: "string" });
  });

  it("appends routing_hint to description", () => {
    const tools = buildToolsFromConfig(makeConfig());
    const createJob = tools.find((t) => t.name === "create_job")!;
    expect(createJob.description).toContain("Create a new coding task");
    expect(createJob.description).toContain("The user wants code written.");
  });

  it("includes custom actions", () => {
    const tools = buildToolsFromConfig(makeConfig());
    const deploy = tools.find((t) => t.name === "deploy")!;
    expect(deploy).toBeDefined();
    expect(deploy.parameters.required).toEqual(["service"]);
  });

  it("handles empty config gracefully", () => {
    const tools = buildToolsFromConfig({
      system_prompt: "",
      actions: {},
      custom_actions: {},
    });
    expect(tools).toEqual([]);
  });
});

describe("buildActionsPromptSection", () => {
  it("generates action list for the system prompt", () => {
    const section = buildActionsPromptSection(makeConfig());
    expect(section).toContain("## Available Actions");
    expect(section).toContain("**create_job**");
    expect(section).toContain("**chat**");
    expect(section).toContain("**deploy**");
    expect(section).not.toContain("**disabled_action**");
  });
});
