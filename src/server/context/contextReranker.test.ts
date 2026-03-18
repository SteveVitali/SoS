import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextConfig } from "./contextConfig.js";
import { rerankAndEvaluate, shouldRunReranker } from "./contextReranker.js";
import type { ContextItem } from "./contextTypes.js";

function makeItem(overrides?: Partial<ContextItem>): ContextItem {
  return {
    id: "test-1",
    content: "Test content",
    source: "kb",
    raw_score: 0.85,
    metadata: {},
    ...overrides,
  };
}

const defaultConfig: ContextConfig = {
  rerankerEnabled: true,
  deepEscalationEnabled: true,
  maxTokens: 3500,
  maxCandidatesPerSource: 5,
  maxContentCharsForReranker: 800,
};

describe("shouldRunReranker", () => {
  it("returns true when both sources have results and reranker enabled", () => {
    const kb = [makeItem({ source: "kb" })];
    const mem = [makeItem({ source: "memory" })];
    expect(shouldRunReranker(kb, mem, defaultConfig)).toBe(true);
  });

  it("returns false when only KB has results", () => {
    const kb = [makeItem({ source: "kb" })];
    expect(shouldRunReranker(kb, [], defaultConfig)).toBe(false);
  });

  it("returns false when only memory has results", () => {
    const mem = [makeItem({ source: "memory" })];
    expect(shouldRunReranker([], mem, defaultConfig)).toBe(false);
  });

  it("returns false when both empty", () => {
    expect(shouldRunReranker([], [], defaultConfig)).toBe(false);
  });

  it("returns false when reranker disabled", () => {
    const kb = [makeItem({ source: "kb" })];
    const mem = [makeItem({ source: "memory" })];
    expect(shouldRunReranker(kb, mem, { ...defaultConfig, rerankerEnabled: false })).toBe(false);
  });
});

describe("rerankAndEvaluate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty result for empty items", async () => {
    const result = await rerankAndEvaluate("test query", [], defaultConfig);
    expect(result.ranked_items).toEqual([]);
    expect(result.sufficiency).toBe("not_knowledge_query");
  });

  it("falls back to raw score ordering when reranker disabled", async () => {
    const items = [
      makeItem({ id: "low", raw_score: 0.3 }),
      makeItem({ id: "high", raw_score: 0.9 }),
    ];
    const result = await rerankAndEvaluate("test", items, {
      ...defaultConfig,
      rerankerEnabled: false,
    });
    expect(result.ranked_items[0].id).toBe("high");
    expect(result.ranked_items[1].id).toBe("low");
    expect(result.sufficiency).toBe("sufficient");
  });

  it("falls back to raw score ordering when no API key", async () => {
    const origKey = process.env.OPENAI_API_KEY;
    const origContextKey = process.env.SOS_CONTEXT_LLM_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.SOS_CONTEXT_LLM_API_KEY;

    const items = [
      makeItem({ id: "low", raw_score: 0.3 }),
      makeItem({ id: "high", raw_score: 0.9 }),
    ];
    const result = await rerankAndEvaluate("test", items, defaultConfig);
    expect(result.ranked_items[0].id).toBe("high");
    expect(result.ranked_items[1].id).toBe("low");

    // Restore
    if (origKey) process.env.OPENAI_API_KEY = origKey;
    if (origContextKey) process.env.SOS_CONTEXT_LLM_API_KEY = origContextKey;
  });
});
