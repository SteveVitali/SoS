import { describe, expect, it } from "vitest";
import { getStrategyConfig, STRATEGY_PROFILES } from "./strategies.js";

describe("strategies", () => {
  describe("STRATEGY_PROFILES", () => {
    it("defines simple, deep, and agent profiles", () => {
      expect(STRATEGY_PROFILES.simple).toBeDefined();
      expect(STRATEGY_PROFILES.deep).toBeDefined();
      expect(STRATEGY_PROFILES.agent).toBeDefined();
    });

    it("simple has lowest budget", () => {
      const s = STRATEGY_PROFILES.simple;
      expect(s.max_iterations).toBe(1);
      expect(s.max_llm_calls).toBeLessThanOrEqual(5);
      expect(s.enable_ircot).toBe(false);
      expect(s.enable_decomposition).toBe(false);
    });

    it("deep has IRCoT and CRAG enabled", () => {
      const d = STRATEGY_PROFILES.deep;
      expect(d.max_iterations).toBeGreaterThan(1);
      expect(d.enable_ircot).toBe(true);
      expect(d.enable_crag).toBe(true);
    });

    it("agent has highest budget", () => {
      const a = STRATEGY_PROFILES.agent;
      expect(a.max_llm_calls).toBeGreaterThanOrEqual(STRATEGY_PROFILES.deep.max_llm_calls);
      expect(a.max_wall_time_ms).toBeGreaterThanOrEqual(STRATEGY_PROFILES.deep.max_wall_time_ms);
    });
  });

  describe("getStrategyConfig", () => {
    it("returns profile for known strategy", () => {
      const config = getStrategyConfig("simple");
      expect(config.strategy).toBe("simple");
      expect(config.max_iterations).toBe(1);
    });

    it("applies overrides", () => {
      const config = getStrategyConfig("deep", { max_iterations: 10, max_llm_calls: 50 });
      expect(config.strategy).toBe("deep");
      expect(config.max_iterations).toBe(10);
      expect(config.max_llm_calls).toBe(50);
      // Non-overridden values remain
      expect(config.enable_ircot).toBe(true);
    });

    it("preserves strategy name even with overrides", () => {
      const config = getStrategyConfig("agent", { max_iterations: 1 });
      expect(config.strategy).toBe("agent");
      expect(config.max_iterations).toBe(1);
    });
  });
});
