import { describe, expect, it } from "vitest";
import type { KBSearchResult } from "./kbTypes.js";
import { formatPathBreadcrumb, pathToBreadcrumb } from "./kbUtils.js";

describe("pathToBreadcrumb", () => {
  it("converts slashes to ' > '", () => {
    expect(pathToBreadcrumb("docs/api/auth.md")).toBe("docs > api > auth.md");
  });

  it("returns the filename unchanged when there are no slashes", () => {
    expect(pathToBreadcrumb("readme.md")).toBe("readme.md");
  });

  it("handles deeply nested paths", () => {
    expect(pathToBreadcrumb("a/b/c/d/e.txt")).toBe("a > b > c > d > e.txt");
  });

  it("handles empty string", () => {
    expect(pathToBreadcrumb("")).toBe("");
  });
});

describe("formatPathBreadcrumb", () => {
  function makeResult(overrides: Partial<KBSearchResult> = {}): KBSearchResult {
    return {
      content: "test",
      source_file: "fallback.md",
      kb_name: "KB",
      kb_id: "kb-1",
      score: 0.9,
      metadata: {},
      ...overrides,
    };
  }

  it("uses file_path when available", () => {
    const result = makeResult({ metadata: { file_path: "docs/api/auth.md" } });
    expect(formatPathBreadcrumb(result)).toBe("docs > api > auth.md");
  });

  it("falls back to source_file when file_path is undefined", () => {
    const result = makeResult({ source_file: "notes.md", metadata: {} });
    expect(formatPathBreadcrumb(result)).toBe("notes.md");
  });

  it("falls back to source_file when file_path is empty string", () => {
    const result = makeResult({ source_file: "notes.md", metadata: { file_path: "" } });
    expect(formatPathBreadcrumb(result)).toBe("notes.md");
  });
});
