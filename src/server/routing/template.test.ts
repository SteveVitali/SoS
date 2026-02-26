import { describe, expect, it } from "vitest";
import { renderTemplate } from "./template.js";

describe("renderTemplate", () => {
  it("interpolates simple variables", () => {
    expect(renderTemplate("Hello {{name}}", { name: "Steve" })).toBe("Hello Steve");
  });

  it("interpolates nested variables (args.field)", () => {
    expect(renderTemplate("Task: {{args.task_text}}", { args: { task_text: "Fix the bug" } })).toBe(
      "Task: Fix the bug",
    );
  });

  it("interpolates with slice ({{var:start:end}})", () => {
    expect(renderTemplate("`{{task_id:0:8}}…`", { task_id: "abcdef1234567890" })).toBe(
      "`abcdef12…`",
    );
  });

  it("handles conditional blocks — truthy", () => {
    expect(
      renderTemplate("Status{{?claimed_by}} (worker: {{claimed_by}}){{/claimed_by}}", {
        claimed_by: "node-1",
      }),
    ).toBe("Status (worker: node-1)");
  });

  it("handles conditional blocks — falsy", () => {
    expect(
      renderTemplate("Status{{?claimed_by}} (worker: {{claimed_by}}){{/claimed_by}}", {}),
    ).toBe("Status");
  });

  it("handles conditional blocks — empty array", () => {
    expect(renderTemplate("{{?pr_urls}}PRs: {{pr_urls}}{{/pr_urls}}", { pr_urls: [] })).toBe("");
  });

  it("handles conditional blocks — non-empty array", () => {
    expect(
      renderTemplate("{{?pr_urls}}PRs: {{pr_urls}}{{/pr_urls}}", {
        pr_urls: ["https://github.com/org/repo/pull/1"],
      }),
    ).toBe("PRs: https://github.com/org/repo/pull/1");
  });

  it("handles default values", () => {
    expect(renderTemplate('Range: {{time_range | default:"7d"}}', {})).toBe("Range: 7d");
  });

  it("uses actual value over default", () => {
    expect(renderTemplate('Range: {{time_range | default:"7d"}}', { time_range: "30d" })).toBe(
      "Range: 30d",
    );
  });

  it("returns empty string for null/undefined variables", () => {
    expect(renderTemplate("{{missing}}", {})).toBe("");
  });

  it("stringifies arrays as comma-separated", () => {
    expect(renderTemplate("{{items}}", { items: ["a", "b", "c"] })).toBe("a, b, c");
  });

  it("handles empty template", () => {
    expect(renderTemplate("", { name: "Steve" })).toBe("");
  });

  it("handles template with no variables", () => {
    expect(renderTemplate("Just plain text", {})).toBe("Just plain text");
  });

  it("handles multiple variables in one template", () => {
    expect(
      renderTemplate("`{{task_id:0:8}}…` — {{status}}", {
        task_id: "abcdef1234567890",
        status: "RUNNING",
      }),
    ).toBe("`abcdef12…` — RUNNING");
  });

  it("handles deeply nested paths", () => {
    expect(
      renderTemplate("{{ctx.github_username}}", {
        ctx: { github_username: "svitali" },
      }),
    ).toBe("svitali");
  });
});
