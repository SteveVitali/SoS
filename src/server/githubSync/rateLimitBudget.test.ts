import { describe, expect, it } from "vitest";
import { RateLimitBudget } from "./rateLimitBudget.js";

describe("RateLimitBudget", () => {
  describe("core REST budget", () => {
    it("starts with 5000 remaining by default", () => {
      const budget = new RateLimitBudget();
      const status = budget.getStatus();
      expect(status.rest.remaining).toBe(5000);
      expect(status.rest.limit).toBe(5000);
    });

    it("reserves 20% for interactive use", () => {
      const budget = new RateLimitBudget();
      expect(budget.interactiveReserve).toBe(1000);
    });

    it("background budget = remaining - reserve", () => {
      const budget = new RateLimitBudget();
      expect(budget.backgroundBudget).toBe(4000);
    });

    it("updates from response headers", () => {
      const budget = new RateLimitBudget();
      budget.updateFromHeaders({
        "x-ratelimit-remaining": "3500",
        "x-ratelimit-limit": "5000",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 1800),
        "x-ratelimit-resource": "core",
      });
      expect(budget.getStatus().rest.remaining).toBe(3500);
      expect(budget.backgroundBudget).toBe(2500);
    });

    it("canSpendRest returns false when budget exhausted", () => {
      const budget = new RateLimitBudget();
      budget.updateFromHeaders({
        "x-ratelimit-remaining": "800",
        "x-ratelimit-limit": "5000",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      });
      // Reserve is 1000, remaining is 800 → background budget = 0
      expect(budget.canSpendRest(1)).toBe(false);
    });

    it("canSpendInteractive works independently of reserve", () => {
      const budget = new RateLimitBudget();
      budget.updateFromHeaders({
        "x-ratelimit-remaining": "800",
        "x-ratelimit-limit": "5000",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      });
      expect(budget.canSpendInteractive(500)).toBe(true);
      expect(budget.canSpendInteractive(900)).toBe(false);
    });

    it("consumeRest decrements remaining", () => {
      const budget = new RateLimitBudget();
      budget.consumeRest(10);
      expect(budget.getStatus().rest.remaining).toBe(4990);
    });

    it("consumeRest does not go below zero", () => {
      const budget = new RateLimitBudget();
      budget.consumeRest(6000);
      expect(budget.getStatus().rest.remaining).toBe(0);
    });
  });

  describe("search token bucket", () => {
    it("starts with 30 search tokens", () => {
      const budget = new RateLimitBudget();
      expect(budget.getStatus().search.tokens_available).toBe(30);
    });

    it("canSearch returns true when tokens available", () => {
      const budget = new RateLimitBudget();
      expect(budget.canSearch()).toBe(true);
    });

    it("acquireSearch decrements a token", async () => {
      const budget = new RateLimitBudget();
      await budget.acquireSearch();
      expect(budget.getStatus().search.tokens_available).toBe(29);
    });

    it("acquireSearch multiple times depletes tokens", async () => {
      const budget = new RateLimitBudget();
      for (let i = 0; i < 5; i++) {
        await budget.acquireSearch();
      }
      expect(budget.getStatus().search.tokens_available).toBe(25);
    });
  });

  describe("getStatus snapshot", () => {
    it("returns all expected fields", () => {
      const budget = new RateLimitBudget();
      const status = budget.getStatus();
      expect(status).toHaveProperty("rest");
      expect(status).toHaveProperty("search");
      expect(status).toHaveProperty("backfill_budget_available");
      expect(status.rest).toHaveProperty("remaining");
      expect(status.rest).toHaveProperty("limit");
      expect(status.rest).toHaveProperty("resets_at");
      expect(status.search).toHaveProperty("tokens_available");
      expect(status.search).toHaveProperty("limit");
    });
  });

  describe("search rate limit headers are ignored for REST tracking", () => {
    it("does not update REST remaining when resource is search", () => {
      const budget = new RateLimitBudget();
      budget.updateFromHeaders({
        "x-ratelimit-remaining": "10",
        "x-ratelimit-resource": "search",
      });
      // REST remaining should still be 5000
      expect(budget.getStatus().rest.remaining).toBe(5000);
    });
  });
});
