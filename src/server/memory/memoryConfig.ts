/**
 * Memory system configuration.
 * Loads settings from environment variables with sensible defaults.
 */

import { createLogger } from "../../shared/logger.js";
import type { MemoryConfig } from "../../shared/memoryTypes.js";

const log = createLogger("server:memory:config");

function optionalInt(name: string, fallback: number): number {
  const val = process.env[name];
  return val ? Number.parseInt(val, 10) : fallback;
}

function optionalFloat(name: string, fallback: number): number {
  const val = process.env[name];
  return val ? Number.parseFloat(val) : fallback;
}

/**
 * Load memory configuration from environment variables with defaults from §5.
 */
export function loadMemoryConfig(): MemoryConfig {
  const config: MemoryConfig = {
    enabled: (process.env.SOS_MEMORY_ENABLED ?? "true") === "true",

    // Extraction
    extraction_model: process.env.SOS_MEMORY_MODEL || "gpt-4.1-mini",
    extraction_min_turns: optionalInt("SOS_MEMORY_EXTRACTION_MIN_TURNS", 1),
    extraction_skip_actions: (process.env.SOS_MEMORY_EXTRACTION_SKIP_ACTIONS || "no_op")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    extraction_max_facts_per_call: optionalInt("SOS_MEMORY_EXTRACTION_MAX_FACTS", 5),

    // Retrieval
    retrieval_max_memories: optionalInt("SOS_MEMORY_RETRIEVAL_MAX_MEMORIES", 8),
    retrieval_max_tokens: optionalInt("SOS_MEMORY_RETRIEVAL_MAX_TOKENS", 1500),
    retrieval_min_score: optionalFloat("SOS_MEMORY_RETRIEVAL_MIN_SCORE", 0.3),
    retrieval_recency_halflife_days: optionalInt("SOS_MEMORY_RECENCY_HALFLIFE_DAYS", 30),

    // Scoring weights (sum to 1.0)
    weight_similarity: optionalFloat("SOS_MEMORY_WEIGHT_SIMILARITY", 0.45),
    weight_recency: optionalFloat("SOS_MEMORY_WEIGHT_RECENCY", 0.2),
    weight_importance: optionalFloat("SOS_MEMORY_WEIGHT_IMPORTANCE", 0.2),
    weight_access: optionalFloat("SOS_MEMORY_WEIGHT_ACCESS", 0.15),

    // Evolution (A-MEM)
    evolution_enabled: (process.env.SOS_MEMORY_EVOLUTION_ENABLED ?? "true") === "true",
    evolution_max_neighbors: optionalInt("SOS_MEMORY_EVOLUTION_MAX_NEIGHBORS", 5),
    evolution_link_threshold: optionalFloat("SOS_MEMORY_EVOLUTION_LINK_THRESHOLD", 0.6),

    // Reflection
    reflection_enabled: (process.env.SOS_MEMORY_REFLECTION_ENABLED ?? "true") === "true",
    reflection_interval_hours: optionalInt("SOS_MEMORY_REFLECTION_INTERVAL_HOURS", 24),
    reflection_min_episodes: optionalInt("SOS_MEMORY_REFLECTION_MIN_EPISODES", 10),

    // Signals
    signal_delay_ms: optionalInt("SOS_MEMORY_SIGNAL_DELAY_MS", 300000),
    signal_no_response_timeout_ms: optionalInt("SOS_MEMORY_SIGNAL_NO_RESPONSE_TIMEOUT_MS", 1800000),
  };

  log.info("Memory config loaded", {
    enabled: config.enabled,
    model: config.extraction_model,
    max_memories: config.retrieval_max_memories,
  });

  return config;
}
