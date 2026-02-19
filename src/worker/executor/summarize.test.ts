import { describe, expect, it } from "vitest";
import { stripPrLines } from "./summarize.js";

describe("stripPrLines", () => {
  it("removes 'PR: https://...' lines", () => {
    const input = "PR: https://github.com/org/repo/pull/42\nsome other text";
    expect(stripPrLines(input)).toBe("some other text");
  });

  it("removes bold '**PR**: https://...' lines", () => {
    const input = "**PR**: https://github.com/org/repo/pull/42\nsome other text";
    expect(stripPrLines(input)).toBe("some other text");
  });

  it("removes 'pr:' case-insensitively", () => {
    const input = "pr: https://github.com/org/repo/pull/42\nkeep this";
    expect(stripPrLines(input)).toBe("keep this");
  });

  it("preserves lines that mention PR in other contexts", () => {
    const input = "Fixed the PR review comments\nUpdated PR template";
    expect(stripPrLines(input)).toBe("Fixed the PR review comments\nUpdated PR template");
  });

  it("handles empty string", () => {
    expect(stripPrLines("")).toBe("");
  });

  it("handles text with no PR lines", () => {
    const input = "All changes applied successfully.\n1 file changed.";
    expect(stripPrLines(input)).toBe("All changes applied successfully.\n1 file changed.");
  });

  it("removes multiple PR link lines", () => {
    const input =
      "PR: https://github.com/org/repo/pull/1\n**PR**: https://github.com/org/repo/pull/1\nDone.";
    expect(stripPrLines(input)).toBe("Done.");
  });

  it("handles PR line with extra whitespace", () => {
    const input = "  PR: https://github.com/org/repo/pull/42  \nkeep this";
    expect(stripPrLines(input)).toBe("keep this");
  });
});
