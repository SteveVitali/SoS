import { describe, expect, it } from "vitest";
import { addSeconds, isExpired, relativeTime } from "./time.js";

describe("addSeconds", () => {
  it("adds positive seconds", () => {
    const base = new Date("2025-01-01T00:00:00Z");
    const result = addSeconds(base, 60);
    expect(result.getTime()).toBe(base.getTime() + 60_000);
  });

  it("handles negative seconds (subtraction)", () => {
    const base = new Date("2025-01-01T00:01:00Z");
    const result = addSeconds(base, -30);
    expect(result.toISOString()).toBe("2025-01-01T00:00:30.000Z");
  });
});

describe("isExpired", () => {
  it("returns true for undefined", () => {
    expect(isExpired(undefined)).toBe(true);
  });

  it("returns true for a date in the past", () => {
    const past = new Date(Date.now() - 10_000);
    expect(isExpired(past)).toBe(true);
  });

  it("returns false for a date in the future", () => {
    const future = new Date(Date.now() + 60_000);
    expect(isExpired(future)).toBe(false);
  });
});

describe("relativeTime", () => {
  it("formats seconds", () => {
    const date = new Date(Date.now() - 30_000);
    expect(relativeTime(date)).toBe("30s ago");
  });

  it("formats minutes", () => {
    const date = new Date(Date.now() - 5 * 60_000);
    expect(relativeTime(date)).toBe("5m ago");
  });

  it("formats hours", () => {
    const date = new Date(Date.now() - 3 * 3_600_000);
    expect(relativeTime(date)).toBe("3h ago");
  });

  it("formats days", () => {
    const date = new Date(Date.now() - 2 * 86_400_000);
    expect(relativeTime(date)).toBe("2d ago");
  });
});
