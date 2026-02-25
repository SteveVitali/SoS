import { describe, expect, it } from "vitest";
import { parseTimeRange } from "./queries.js";

describe("parseTimeRange", () => {
  it("defaults to 7 days when no input given", () => {
    const result = parseTimeRange();
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    // Allow 1 second tolerance
    expect(Math.abs(result.getTime() - sevenDaysAgo)).toBeLessThan(1000);
  });

  it("parses relative days (7d)", () => {
    const result = parseTimeRange("7d");
    const expected = Date.now() - 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(result.getTime() - expected)).toBeLessThan(1000);
  });

  it("parses relative weeks (2w)", () => {
    const result = parseTimeRange("2w");
    const expected = Date.now() - 14 * 24 * 60 * 60 * 1000;
    expect(Math.abs(result.getTime() - expected)).toBeLessThan(1000);
  });

  it("parses relative months (1m)", () => {
    const result = parseTimeRange("1m");
    const expected = Date.now() - 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(result.getTime() - expected)).toBeLessThan(1000);
  });

  it("parses absolute range (YYYY-MM-DD..YYYY-MM-DD) using start date", () => {
    const result = parseTimeRange("2025-01-15..2025-02-15");
    expect(result.toISOString().startsWith("2025-01-15")).toBe(true);
  });

  it("parses a single ISO date", () => {
    const result = parseTimeRange("2025-03-01");
    expect(result.toISOString().startsWith("2025-03-01")).toBe(true);
  });

  it("falls back to 7 days for unparseable input", () => {
    const result = parseTimeRange("not-a-date");
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(result.getTime() - sevenDaysAgo)).toBeLessThan(1000);
  });

  it("is case-insensitive for units", () => {
    const lower = parseTimeRange("14d");
    const upper = parseTimeRange("14D");
    expect(Math.abs(lower.getTime() - upper.getTime())).toBeLessThan(1000);
  });
});
