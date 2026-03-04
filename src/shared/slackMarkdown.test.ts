import { describe, expect, it } from "vitest";
import { markdownToSlack, slackToMarkdown } from "./slackMarkdown.js";

describe("slackToMarkdown", () => {
  it("converts Slack bold *text* to markdown **text**", () => {
    expect(slackToMarkdown("Hello *world*")).toBe("Hello **world**");
  });

  it("does not double-convert already-markdown **text**", () => {
    expect(slackToMarkdown("Hello **world**")).toBe("Hello **world**");
  });

  it("converts multiple bold segments", () => {
    expect(slackToMarkdown("*foo* bar *baz*")).toBe("**foo** bar **baz**");
  });

  it("converts Slack links <url|label> to markdown [label](url)", () => {
    expect(slackToMarkdown("<https://example.com|Example>")).toBe("[Example](https://example.com)");
  });

  it("converts bare Slack links <url> to markdown links", () => {
    expect(slackToMarkdown("<https://example.com>")).toBe(
      "[https://example.com](https://example.com)",
    );
  });

  it("does not convert non-http angle bracket content", () => {
    expect(slackToMarkdown("<@U12345>")).toBe("<@U12345>");
  });

  it("handles mixed formatting", () => {
    const input = "*Team PRs* — <https://github.com/org/repo/pull/1|org/repo#1>";
    const expected = "**Team PRs** — [org/repo#1](https://github.com/org/repo/pull/1)";
    expect(slackToMarkdown(input)).toBe(expected);
  });

  it("does not convert asterisks inside words", () => {
    expect(slackToMarkdown("file*name*here")).toBe("file*name*here");
  });

  it("preserves text without Slack formatting", () => {
    expect(slackToMarkdown("plain text")).toBe("plain text");
  });

  it("handles emoji before bold", () => {
    expect(slackToMarkdown("📊 *Your recap (7d)*")).toBe("📊 **Your recap (7d)**");
  });
});

describe("markdownToSlack", () => {
  it("converts markdown headings to Slack bold", () => {
    expect(markdownToSlack("## Section Title")).toBe("*Section Title*");
    expect(markdownToSlack("# Main Title")).toBe("*Main Title*");
    expect(markdownToSlack("### Sub")).toBe("*Sub*");
  });

  it("converts markdown links to Slack links", () => {
    expect(markdownToSlack("[Example](https://example.com)")).toBe("<https://example.com|Example>");
  });

  it("converts markdown table to bullet list", () => {
    const table = [
      "| Rule | Details |",
      "|------|------|",
      "| No saves | Call service instead |",
      "| Use API | Required for all writes |",
    ].join("\n");
    const result = markdownToSlack(table);
    expect(result).toContain("•");
    expect(result).toContain("*Rule:*");
    expect(result).toContain("No saves");
    expect(result).toContain("*Details:*");
    expect(result).toContain("Call service instead");
    expect(result).toContain("—");
  });

  it("preserves plain text", () => {
    expect(markdownToSlack("just some text")).toBe("just some text");
  });

  it("preserves bullet lists", () => {
    expect(markdownToSlack("- item one\n- item two")).toBe("- item one\n- item two");
  });

  it("handles mixed content", () => {
    const input = "## Summary\n\nHere is the answer.\n\n- Point one\n- Point two";
    const result = markdownToSlack(input);
    expect(result).toBe("*Summary*\n\nHere is the answer.\n\n- Point one\n- Point two");
  });
});
