import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextConfig } from "./contextConfig.js";
import { parseRerankerResponse, rerankAndEvaluate, shouldRunReranker } from "./contextReranker.js";
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

describe("parseRerankerResponse", () => {
  const items = [
    makeItem({ id: "a", raw_score: 0.9 }),
    makeItem({ id: "b", raw_score: 0.7 }),
    makeItem({ id: "c", raw_score: 0.5 }),
  ];

  it("parses a valid response with correct ranking", () => {
    const raw = JSON.stringify({
      ranked_indices: [2, 0],
      dropped_indices: [1],
      sufficiency: "sufficient",
      follow_up_queries: null,
      reasoning: "C is most relevant, A is second",
    });
    const result = parseRerankerResponse(raw, items);
    expect(result.ranked_items).toHaveLength(2);
    expect(result.ranked_items[0].id).toBe("c");
    expect(result.ranked_items[1].id).toBe("a");
    expect(result.dropped_items).toHaveLength(1);
    expect(result.dropped_items[0].id).toBe("b");
    expect(result.sufficiency).toBe("sufficient");
    expect(result.follow_up_queries).toBeNull();
    expect(result.reasoning).toBe("C is most relevant, A is second");
  });

  it("falls back to raw score ordering for invalid JSON", () => {
    const result = parseRerankerResponse("not json at all", items);
    expect(result.ranked_items).toHaveLength(3);
    expect(result.ranked_items[0].id).toBe("a"); // highest raw_score
    expect(result.sufficiency).toBe("sufficient");
    expect(result.reasoning).toContain("Fallback");
  });

  it("recovers items missing from ranked_indices", () => {
    const raw = JSON.stringify({
      ranked_indices: [0],
      dropped_indices: [],
      sufficiency: "sufficient",
    });
    const result = parseRerankerResponse(raw, items);
    // Item 0 is ranked, items 1 and 2 should be appended defensively
    expect(result.ranked_items).toHaveLength(3);
    expect(result.ranked_items[0].id).toBe("a");
  });

  it("ignores out-of-range indices", () => {
    const raw = JSON.stringify({
      ranked_indices: [0, 99, -1, 1],
      dropped_indices: [],
      sufficiency: "sufficient",
    });
    const result = parseRerankerResponse(raw, items);
    // Only indices 0 and 1 are valid; item 2 appended defensively
    expect(result.ranked_items).toHaveLength(3);
    expect(result.ranked_items[0].id).toBe("a");
    expect(result.ranked_items[1].id).toBe("b");
    expect(result.ranked_items[2].id).toBe("c");
  });

  it("deduplicates repeated indices", () => {
    const raw = JSON.stringify({
      ranked_indices: [0, 0, 1, 1],
      dropped_indices: [],
      sufficiency: "sufficient",
    });
    const result = parseRerankerResponse(raw, items);
    expect(result.ranked_items).toHaveLength(3);
  });

  it("validates sufficiency to known values", () => {
    const raw = JSON.stringify({
      ranked_indices: [0, 1, 2],
      sufficiency: "bogus_value",
    });
    const result = parseRerankerResponse(raw, items);
    expect(result.sufficiency).toBe("sufficient"); // defaults to sufficient
  });

  it("parses insufficient with follow-up queries", () => {
    const raw = JSON.stringify({
      ranked_indices: [0, 1, 2],
      sufficiency: "insufficient",
      follow_up_queries: ["deployment docs", "CI config"],
      reasoning: "Missing deployment info",
    });
    const result = parseRerankerResponse(raw, items);
    expect(result.sufficiency).toBe("insufficient");
    expect(result.follow_up_queries).toEqual(["deployment docs", "CI config"]);
  });

  it("nullifies follow_up_queries when sufficiency is not insufficient", () => {
    const raw = JSON.stringify({
      ranked_indices: [0, 1, 2],
      sufficiency: "sufficient",
      follow_up_queries: ["should be ignored"],
    });
    const result = parseRerankerResponse(raw, items);
    expect(result.follow_up_queries).toBeNull();
  });

  it("handles empty ranked_indices gracefully", () => {
    const raw = JSON.stringify({
      ranked_indices: [],
      sufficiency: "not_knowledge_query",
    });
    const result = parseRerankerResponse(raw, items);
    // All items appended defensively
    expect(result.ranked_items).toHaveLength(3);
    expect(result.sufficiency).toBe("not_knowledge_query");
  });
});
