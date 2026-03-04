/**
 * Predefined research strategy profiles.
 * Each profile balances quality vs cost vs latency.
 */

import type { ResearchConfig, ResearchStrategy } from "../../../shared/researchTypes.js";

export const STRATEGY_PROFILES: Record<ResearchStrategy, ResearchConfig> = {
  simple: {
    strategy: "simple",
    max_iterations: 1,
    max_llm_calls: 3,
    max_retrieval_calls: 10,
    max_wall_time_ms: 10_000,
    enable_decomposition: false,
    enable_hyde: true,
    enable_step_back: false,
    enable_crag: true,
    enable_ircot: false,
    max_chunks_per_query: 5,
    min_similarity_score: 0.3,
    dedup_threshold: 0.92,
  },

  deep: {
    strategy: "deep",
    max_iterations: 3,
    max_llm_calls: 10,
    max_retrieval_calls: 20,
    max_wall_time_ms: 30_000,
    enable_decomposition: true,
    enable_hyde: true,
    enable_step_back: true,
    enable_crag: true,
    enable_ircot: true,
    max_chunks_per_query: 8,
    min_similarity_score: 0.25,
    dedup_threshold: 0.9,
  },

  agent: {
    strategy: "agent",
    max_iterations: 8,
    max_llm_calls: 20,
    max_retrieval_calls: 30,
    max_wall_time_ms: 60_000,
    enable_decomposition: true,
    enable_hyde: true,
    enable_step_back: true,
    enable_crag: true,
    enable_ircot: true,
    max_chunks_per_query: 10,
    min_similarity_score: 0.2,
    dedup_threshold: 0.88,
  },
};

/**
 * Get a strategy config with optional overrides.
 */
export function getStrategyConfig(
  strategy: ResearchStrategy,
  overrides?: Partial<ResearchConfig>,
): ResearchConfig {
  return { ...STRATEGY_PROFILES[strategy], ...overrides, strategy };
}
