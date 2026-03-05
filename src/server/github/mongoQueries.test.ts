import { describe, expect, it } from "vitest";
import { parseTimeRange } from "./mongoQueries.js";

describe("parseTimeRange", () => {
  it("defaults to 7 days when no input", () => {
    const result = parseTimeRange();
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    expect(result.getTime()).toBeCloseTo(sevenDaysAgo, -3);
  });

  it("defaults to 7 days for invalid input", () => {
    const result = parseTimeRange("foobar");
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    expect(result.getTime()).toBeCloseTo(sevenDaysAgo, -3);
  });

  it("parses days", () => {
    const result = parseTimeRange("14d");
    const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    expect(result.getTime()).toBeCloseTo(fourteenDaysAgo, -3);
  });

  it("parses weeks", () => {
    const result = parseTimeRange("2w");
    const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    expect(result.getTime()).toBeCloseTo(fourteenDaysAgo, -3);
  });

  it("parses months", () => {
    const result = parseTimeRange("3m");
    const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
    expect(result.getTime()).toBeCloseTo(ninetyDaysAgo, -3);
  });

  it("falls back to 7d for unsupported formats", () => {
    const result = parseTimeRange("2025-06-01..2025-07-01");
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    expect(result.getTime()).toBeCloseTo(sevenDaysAgo, -3);
  });

  it("handles single digit values", () => {
    const result = parseTimeRange("1d");
    const oneDayAgo = Date.now() - 1 * 24 * 60 * 60 * 1000;
    expect(result.getTime()).toBeCloseTo(oneDayAgo, -3);
  });
});
