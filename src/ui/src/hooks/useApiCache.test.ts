import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCacheKey,
  getCached,
  invalidateCache,
  invalidateNamespace,
  setCache,
} from "./useApiCache.js";

describe("useApiCache", () => {
  beforeEach(() => {
    // Clear module-level cache between tests by invalidating known namespaces
    invalidateNamespace("test");
    invalidateNamespace("github-prs");
    invalidateNamespace("github-contributions");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("buildCacheKey", () => {
    it("produces deterministic keys regardless of param order", () => {
      const a = buildCacheKey("ns", { scope: "team", state: "open", limit: 30 });
      const b = buildCacheKey("ns", { limit: 30, state: "open", scope: "team" });
      expect(a).toBe(b);
    });

    it("includes namespace prefix", () => {
      const key = buildCacheKey("github-prs", { scope: "me" });
      expect(key.startsWith("github-prs?")).toBe(true);
    });

    it("handles undefined values", () => {
      const key = buildCacheKey("test", { a: undefined, b: "x" });
      expect(key).toBe("test?a=&b=x");
    });
  });

  describe("getCached / setCache", () => {
    it("returns undefined for missing keys", () => {
      expect(getCached("test?missing=true")).toBeUndefined();
    });

    it("returns cached data within TTL", () => {
      const key = "test?a=1";
      setCache(key, { hello: "world" });
      expect(getCached(key)).toEqual({ hello: "world" });
    });

    it("returns undefined after TTL expires", () => {
      vi.useFakeTimers();
      const key = "test?ttl=expire";
      setCache(key, { data: 42 });
      expect(getCached(key, 1000)).toEqual({ data: 42 });

      vi.advanceTimersByTime(1001);
      expect(getCached(key, 1000)).toBeUndefined();
    });

    it("uses default 1-hour TTL", () => {
      vi.useFakeTimers();
      const key = "test?default-ttl=true";
      setCache(key, "value");

      // 59 minutes: still valid
      vi.advanceTimersByTime(59 * 60 * 1000);
      expect(getCached(key)).toBe("value");

      // 61 minutes: expired
      vi.advanceTimersByTime(2 * 60 * 1000);
      expect(getCached(key)).toBeUndefined();
    });
  });

  describe("invalidateCache", () => {
    it("removes a single entry", () => {
      const key = "test?single=true";
      setCache(key, "data");
      expect(getCached(key)).toBe("data");

      invalidateCache(key);
      expect(getCached(key)).toBeUndefined();
    });
  });

  describe("invalidateNamespace", () => {
    it("removes all entries in a namespace", () => {
      setCache("test?a=1", "one");
      setCache("test?a=2", "two");
      setCache("github-prs?scope=me", "prs");

      invalidateNamespace("test");

      expect(getCached("test?a=1")).toBeUndefined();
      expect(getCached("test?a=2")).toBeUndefined();
      expect(getCached("github-prs?scope=me")).toBe("prs");
    });
  });
});
