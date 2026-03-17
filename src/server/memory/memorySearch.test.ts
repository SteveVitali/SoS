import { describe, expect, it, vi } from "vitest";
import type { MemoryConfig } from "../../shared/memoryTypes.js";
import { computeAccessScore, computeCompositeScore, computeRecencyScore } from "./memorySearch.js";

function makeConfig(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return {
    enabled: true,
    extraction_model: "gpt-4.1-mini",
    extraction_min_turns: 1,
    extraction_skip_actions: ["no_op"],
    extraction_max_facts_per_call: 5,
    retrieval_max_memories: 8,
    retrieval_max_tokens: 1500,
    retrieval_min_score: 0.3,
    retrieval_recency_halflife_days: 30,
    weight_similarity: 0.45,
    weight_recency: 0.2,
    weight_importance: 0.2,
    weight_access: 0.15,
    evolution_enabled: true,
    evolution_max_neighbors: 5,
    evolution_link_threshold: 0.6,
    reflection_enabled: true,
    reflection_interval_hours: 24,
    reflection_min_episodes: 10,
    signal_delay_ms: 300000,
    signal_no_response_timeout_ms: 1800000,
    ...overrides,
  };
}

describe("memorySearch", () => {
  describe("computeRecencyScore", () => {
    it("returns 1.0 for a memory updated right now", () => {
      const now = new Date();
      const score = computeRecencyScore(now, 30);
      expect(score).toBeCloseTo(1.0, 2);
    });

    it("returns ~0.5 for a memory updated one halflife ago", () => {
      const halflifeAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const score = computeRecencyScore(halflifeAgo, 30);
      expect(score).toBeCloseTo(0.5, 1);
    });

    it("returns ~0.25 for a memory updated two halflives ago", () => {
      const twoHalflivesAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      const score = computeRecencyScore(twoHalflivesAgo, 30);
      expect(score).toBeCloseTo(0.25, 1);
    });

    it("approaches 0 for very old memories", () => {
      const veryOld = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
      const score = computeRecencyScore(veryOld, 30);
      expect(score).toBeLessThan(0.01);
    });

    it("handles different halflife values", () => {
      const oneDay = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const score7 = computeRecencyScore(oneDay, 7);
      const score30 = computeRecencyScore(oneDay, 30);
      // Shorter halflife → faster decay → lower score
      expect(score7).toBeLessThan(score30);
    });
  });

  describe("computeAccessScore", () => {
    it("returns 0 for access_count=0", () => {
      expect(computeAccessScore(0)).toBe(0);
    });

    it("returns small value for access_count=1", () => {
      const score = computeAccessScore(1);
      // log2(2) / 5 = 1/5 = 0.2
      expect(score).toBeCloseTo(0.2, 2);
    });

    it("caps at 1.0 for very high access counts", () => {
      expect(computeAccessScore(100)).toBe(1.0);
      expect(computeAccessScore(1000)).toBe(1.0);
    });

    it("is monotonically increasing", () => {
      let prev = 0;
      for (const count of [0, 1, 2, 5, 10, 20, 50]) {
        const score = computeAccessScore(count);
        expect(score).toBeGreaterThanOrEqual(prev);
        prev = score;
      }
    });

    it("returns log2(1+access_count)/5 for moderate values", () => {
      // access_count=3: log2(4)/5 = 2/5 = 0.4
      expect(computeAccessScore(3)).toBeCloseTo(0.4, 2);
      // access_count=7: log2(8)/5 = 3/5 = 0.6
      expect(computeAccessScore(7)).toBeCloseTo(0.6, 2);
      // access_count=15: log2(16)/5 = 4/5 = 0.8
      expect(computeAccessScore(15)).toBeCloseTo(0.8, 2);
      // access_count=31: log2(32)/5 = 5/5 = 1.0
      expect(computeAccessScore(31)).toBeCloseTo(1.0, 2);
    });
  });

  describe("computeCompositeScore", () => {
    const config = makeConfig();

    it("computes weighted sum correctly", () => {
      const score = computeCompositeScore(1.0, 1.0, 1.0, 1.0, config);
      // 0.45 + 0.20 + 0.20 + 0.15 = 1.0
      expect(score).toBeCloseTo(1.0, 2);
    });

    it("returns 0 when all inputs are 0", () => {
      const score = computeCompositeScore(0, 0, 0, 0, config);
      expect(score).toBe(0);
    });

    it("weights similarity highest by default", () => {
      const simOnly = computeCompositeScore(1.0, 0, 0, 0, config);
      const recOnly = computeCompositeScore(0, 1.0, 0, 0, config);
      const impOnly = computeCompositeScore(0, 0, 1.0, 0, config);
      const accOnly = computeCompositeScore(0, 0, 0, 1.0, config);

      expect(simOnly).toBe(0.45);
      expect(recOnly).toBe(0.2);
      expect(impOnly).toBe(0.2);
      expect(accOnly).toBe(0.15);
    });

    it("respects custom weights", () => {
      const customConfig = makeConfig({
        weight_similarity: 0.25,
        weight_recency: 0.25,
        weight_importance: 0.25,
        weight_access: 0.25,
      });

      const score = computeCompositeScore(0.8, 0.6, 0.4, 0.2, customConfig);
      expect(score).toBeCloseTo(0.25 * (0.8 + 0.6 + 0.4 + 0.2), 4);
    });

    it("handles partial scores", () => {
      const score = computeCompositeScore(0.8, 0.5, 0.7, 0.3, config);
      const expected = 0.45 * 0.8 + 0.2 * 0.5 + 0.2 * 0.7 + 0.15 * 0.3;
      expect(score).toBeCloseTo(expected, 4);
    });
  });
});
