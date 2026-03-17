/**
 * Tests for memoryConfig.ts — default values, env var overrides, skip action parsing.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMemoryConfig } from "./memoryConfig.js";

describe("loadMemoryConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all SOS_MEMORY_* env vars before each test
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("SOS_MEMORY")) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("SOS_MEMORY")) {
        delete process.env[key];
      }
    }
    for (const [key, val] of Object.entries(originalEnv)) {
      if (key.startsWith("SOS_MEMORY") && val !== undefined) {
        process.env[key] = val;
      }
    }
  });

  // ─── Default Values ──────────────────────────────────────────

  it("returns correct defaults when no env vars are set", () => {
    const config = loadMemoryConfig();

    expect(config.enabled).toBe(true);
    expect(config.extraction_model).toBe("gpt-4.1-mini");
    expect(config.extraction_min_turns).toBe(1);
    expect(config.extraction_skip_actions).toEqual(["no_op"]);
    expect(config.extraction_max_facts_per_call).toBe(5);

    expect(config.retrieval_max_memories).toBe(8);
    expect(config.retrieval_max_tokens).toBe(1500);
    expect(config.retrieval_min_score).toBe(0.3);
    expect(config.retrieval_recency_halflife_days).toBe(30);

    expect(config.weight_similarity).toBe(0.45);
    expect(config.weight_recency).toBe(0.2);
    expect(config.weight_importance).toBe(0.2);
    expect(config.weight_access).toBe(0.15);

    expect(config.evolution_enabled).toBe(true);
    expect(config.evolution_max_neighbors).toBe(5);
    expect(config.evolution_link_threshold).toBe(0.6);

    expect(config.reflection_enabled).toBe(true);
    expect(config.reflection_interval_hours).toBe(24);
    expect(config.reflection_min_episodes).toBe(10);

    expect(config.signal_delay_ms).toBe(300000);
    expect(config.signal_no_response_timeout_ms).toBe(1800000);
  });

  it("default scoring weights sum to 1.0", () => {
    const config = loadMemoryConfig();
    const sum =
      config.weight_similarity +
      config.weight_recency +
      config.weight_importance +
      config.weight_access;
    expect(sum).toBeCloseTo(1.0, 10);
  });

  // ─── Env Var Overrides ───────────────────────────────────────

  it("respects SOS_MEMORY_ENABLED=false", () => {
    process.env.SOS_MEMORY_ENABLED = "false";
    const config = loadMemoryConfig();
    expect(config.enabled).toBe(false);
  });

  it("respects SOS_MEMORY_MODEL override", () => {
    process.env.SOS_MEMORY_MODEL = "gpt-4o";
    const config = loadMemoryConfig();
    expect(config.extraction_model).toBe("gpt-4o");
  });

  it("respects integer env var overrides", () => {
    process.env.SOS_MEMORY_RETRIEVAL_MAX_MEMORIES = "16";
    process.env.SOS_MEMORY_RETRIEVAL_MAX_TOKENS = "3000";
    process.env.SOS_MEMORY_EXTRACTION_MIN_TURNS = "3";
    process.env.SOS_MEMORY_EXTRACTION_MAX_FACTS = "10";
    process.env.SOS_MEMORY_RECENCY_HALFLIFE_DAYS = "60";
    process.env.SOS_MEMORY_EVOLUTION_MAX_NEIGHBORS = "10";
    process.env.SOS_MEMORY_REFLECTION_INTERVAL_HOURS = "48";
    process.env.SOS_MEMORY_REFLECTION_MIN_EPISODES = "20";
    process.env.SOS_MEMORY_SIGNAL_DELAY_MS = "600000";
    process.env.SOS_MEMORY_SIGNAL_NO_RESPONSE_TIMEOUT_MS = "3600000";

    const config = loadMemoryConfig();

    expect(config.retrieval_max_memories).toBe(16);
    expect(config.retrieval_max_tokens).toBe(3000);
    expect(config.extraction_min_turns).toBe(3);
    expect(config.extraction_max_facts_per_call).toBe(10);
    expect(config.retrieval_recency_halflife_days).toBe(60);
    expect(config.evolution_max_neighbors).toBe(10);
    expect(config.reflection_interval_hours).toBe(48);
    expect(config.reflection_min_episodes).toBe(20);
    expect(config.signal_delay_ms).toBe(600000);
    expect(config.signal_no_response_timeout_ms).toBe(3600000);
  });

  it("respects float env var overrides", () => {
    process.env.SOS_MEMORY_RETRIEVAL_MIN_SCORE = "0.5";
    process.env.SOS_MEMORY_WEIGHT_SIMILARITY = "0.5";
    process.env.SOS_MEMORY_WEIGHT_RECENCY = "0.2";
    process.env.SOS_MEMORY_WEIGHT_IMPORTANCE = "0.2";
    process.env.SOS_MEMORY_WEIGHT_ACCESS = "0.1";
    process.env.SOS_MEMORY_EVOLUTION_LINK_THRESHOLD = "0.75";

    const config = loadMemoryConfig();

    expect(config.retrieval_min_score).toBe(0.5);
    expect(config.weight_similarity).toBe(0.5);
    expect(config.weight_recency).toBe(0.2);
    expect(config.weight_importance).toBe(0.2);
    expect(config.weight_access).toBe(0.1);
    expect(config.evolution_link_threshold).toBe(0.75);
  });

  it("respects boolean env var overrides", () => {
    process.env.SOS_MEMORY_EVOLUTION_ENABLED = "false";
    process.env.SOS_MEMORY_REFLECTION_ENABLED = "false";

    const config = loadMemoryConfig();

    expect(config.evolution_enabled).toBe(false);
    expect(config.reflection_enabled).toBe(false);
  });

  // ─── Skip Actions Parsing ────────────────────────────────────

  it("parses comma-separated skip actions", () => {
    process.env.SOS_MEMORY_EXTRACTION_SKIP_ACTIONS = "no_op,leave_channel,job_status";
    const config = loadMemoryConfig();
    expect(config.extraction_skip_actions).toEqual(["no_op", "leave_channel", "job_status"]);
  });

  it("trims whitespace from skip actions", () => {
    process.env.SOS_MEMORY_EXTRACTION_SKIP_ACTIONS = " no_op , leave_channel ";
    const config = loadMemoryConfig();
    expect(config.extraction_skip_actions).toEqual(["no_op", "leave_channel"]);
  });

  it("filters empty skip action entries", () => {
    process.env.SOS_MEMORY_EXTRACTION_SKIP_ACTIONS = "no_op,,leave_channel,";
    const config = loadMemoryConfig();
    expect(config.extraction_skip_actions).toEqual(["no_op", "leave_channel"]);
  });
});
