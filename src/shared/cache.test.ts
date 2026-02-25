import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TtlCache } from "./cache.js";

describe("TtlCache", () => {
  let cache: TtlCache<string>;

  beforeEach(() => {
    cache = new TtlCache<string>({ ttlMs: 1000, label: "test" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns undefined for missing keys", () => {
    expect(cache.get("nope")).toBeUndefined();
  });

  it("stores and retrieves values", () => {
    cache.set("a", "hello");
    expect(cache.get("a")).toBe("hello");
  });

  it("has() returns true for fresh entries", () => {
    cache.set("a", "hello");
    expect(cache.has("a")).toBe(true);
  });

  it("has() returns false for missing entries", () => {
    expect(cache.has("nope")).toBe(false);
  });

  it("expires entries after TTL", () => {
    cache.set("a", "hello");
    // Advance time past TTL
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1500);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.has("a")).toBe(false);
  });

  it("getOrSet returns cached value on hit", () => {
    cache.set("a", "cached");
    const fn = vi.fn(() => "fresh");
    const result = cache.getOrSet("a", fn);
    expect(result).toBe("cached");
    expect(fn).not.toHaveBeenCalled();
  });

  it("getOrSet computes and caches on miss", () => {
    const fn = vi.fn(() => "computed");
    const result = cache.getOrSet("a", fn);
    expect(result).toBe("computed");
    expect(fn).toHaveBeenCalledOnce();
    // Second call should be cached
    const result2 = cache.getOrSet("a", fn);
    expect(result2).toBe("computed");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("getOrSetAsync returns cached value on hit", async () => {
    cache.set("a", "cached");
    const fn = vi.fn(async () => "fresh");
    const result = await cache.getOrSetAsync("a", fn);
    expect(result).toBe("cached");
    expect(fn).not.toHaveBeenCalled();
  });

  it("getOrSetAsync computes and caches on miss", async () => {
    const fn = vi.fn(async () => "computed");
    const result = await cache.getOrSetAsync("a", fn);
    expect(result).toBe("computed");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("delete removes an entry", () => {
    cache.set("a", "hello");
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
  });

  it("clear removes all entries", () => {
    cache.set("a", "1");
    cache.set("b", "2");
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("prune removes only expired entries", () => {
    const now = Date.now();
    cache.set("fresh", "yes");
    // Manually insert an expired entry
    cache.set("stale", "no");
    // Move time forward so 'stale' expires but we also set 'fresh' again
    vi.spyOn(Date, "now").mockReturnValue(now + 1500);
    cache.set("fresh2", "yes");
    cache.prune();
    expect(cache.has("fresh")).toBe(false); // expired
    expect(cache.has("stale")).toBe(false); // expired
    expect(cache.has("fresh2")).toBe(true); // still fresh
  });

  it("size reflects current entries including expired (until accessed)", () => {
    cache.set("a", "1");
    cache.set("b", "2");
    expect(cache.size).toBe(2);
  });

  it("getOrSet propagates exceptions from fn without caching", () => {
    const fn = vi.fn(() => {
      throw new Error("boom");
    });
    expect(() => cache.getOrSet("a", fn)).toThrow("boom");
    expect(cache.has("a")).toBe(false);
  });
});
