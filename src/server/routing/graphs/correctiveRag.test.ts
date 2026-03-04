import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KBSearchResult } from "../../../shared/kbTypes.js";
import type { LLMProvider, LLMResponse } from "../../llm/llmProvider.js";
import { runCorrectiveRAG } from "./correctiveRag.js";
import type { RAGGraphConfig } from "./types.js";

// Mock the KB search service
vi.mock("../../kb/kbService.js", () => ({
  searchKnowledgeBases: vi.fn(),
}));

import { searchKnowledgeBases } from "../../kb/kbService.js";

const mockSearch = vi.mocked(searchKnowledgeBases);

// --- Helpers ---

function makeChunks(count: number, score = 0.8): KBSearchResult[] {
  return Array.from({ length: count }, (_, i) => ({
    content: `Chunk ${i + 1} content about the topic.`,
    source_file: `doc${i + 1}.md`,
    kb_name: "Test KB",
    kb_id: `kb-${i}`,
    score,
    metadata: { section: `Section ${i + 1}` },
  }));
}

/**
 * Build a mock LLM provider that responds based on the system prompt content.
 * - Grading calls (system prompt contains "relevance grading") → returns the grade
 * - Reformulation calls (system prompt contains "search query optimizer") → returns new query
 * - Answer calls (system prompt contains "helpful assistant") → returns the answer
 */
function makeMockProvider(opts: {
  grades?: string[];
  reformulations?: string[];
  answer?: string;
}): LLMProvider {
  const grades = [...(opts.grades ?? ["sufficient"])];
  const reformulations = [...(opts.reformulations ?? ["reformulated query"])];
  const answer = opts.answer ?? "Here is the answer based on the context.";

  return {
    chat: vi.fn(async (params: { system: string }): Promise<LLMResponse> => {
      if (params.system.includes("relevance grading")) {
        return { text: grades.shift() ?? "sufficient", toolCalls: [] };
      }
      if (params.system.includes("search query optimizer")) {
        return { text: reformulations.shift() ?? "another query", toolCalls: [] };
      }
      if (params.system.includes("helpful assistant")) {
        return { text: answer, toolCalls: [] };
      }
      return { text: "unexpected call", toolCalls: [] };
    }),
  };
}

const baseConfig: RAGGraphConfig = {
  scopes: ["chat", "all"],
  max_retrievals: 3,
  max_chunks: 5,
  min_score: 0.3,
  model: "test-model",
  max_answer_tokens: 512,
};

describe("runCorrectiveRAG", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers on first pass when chunks are sufficient", async () => {
    const chunks = makeChunks(3);
    mockSearch.mockResolvedValue(chunks);

    const provider = makeMockProvider({
      grades: ["sufficient"],
      answer: "The answer is 42.",
    });

    const result = await runCorrectiveRAG(provider, "what is the meaning of life?", baseConfig);

    expect(result.retrievalRounds).toBe(1);
    expect(result.answer).toBe("The answer is 42.");
    expect(result.trace).toEqual(
      expect.arrayContaining([
        expect.stringContaining("[retrieve round 1]"),
        expect.stringContaining('[grade] 3 chunks → "sufficient"'),
        expect.stringContaining("[answer]"),
      ]),
    );
    // searchKnowledgeBases called exactly once
    expect(mockSearch).toHaveBeenCalledTimes(1);
  });

  it("reformulates and retries when chunks are insufficient", async () => {
    const firstChunks = makeChunks(2, 0.5);
    const secondChunks = makeChunks(4, 0.9);
    mockSearch.mockResolvedValueOnce(firstChunks).mockResolvedValueOnce(secondChunks);

    const provider = makeMockProvider({
      grades: ["insufficient", "sufficient"],
      reformulations: ["better search query"],
      answer: "Found it after reformulation.",
    });

    const result = await runCorrectiveRAG(provider, "how does X work?", baseConfig);

    expect(result.retrievalRounds).toBe(2);
    expect(result.answer).toBe("Found it after reformulation.");
    expect(mockSearch).toHaveBeenCalledTimes(2);

    // Verify the second search used the reformulated query
    const secondCallArgs = mockSearch.mock.calls[1][0];
    expect(secondCallArgs.query).toBe("better search query");

    expect(result.trace).toEqual(
      expect.arrayContaining([
        expect.stringContaining("[retrieve round 1]"),
        expect.stringContaining('[grade] 2 chunks → "insufficient"'),
        expect.stringContaining("[reformulate]"),
        expect.stringContaining("[retrieve round 2]"),
        expect.stringContaining('[grade] 4 chunks → "sufficient"'),
        expect.stringContaining("[answer]"),
      ]),
    );
  });

  it("caps retrieval at max_retrievals and answers with what it has", async () => {
    const chunks = makeChunks(1, 0.4);
    mockSearch.mockResolvedValue(chunks);

    const config: RAGGraphConfig = { ...baseConfig, max_retrievals: 2 };

    const provider = makeMockProvider({
      grades: ["insufficient", "insufficient"],
      reformulations: ["try1", "try2"],
      answer: "Best I can do with limited context.",
    });

    const result = await runCorrectiveRAG(provider, "obscure question", config);

    expect(result.retrievalRounds).toBe(2);
    expect(result.answer).toBe("Best I can do with limited context.");
    expect(mockSearch).toHaveBeenCalledTimes(2);
  });

  it("handles empty results gracefully", async () => {
    mockSearch.mockResolvedValue([]);

    const provider = makeMockProvider({
      answer: "I couldn't find anything in the knowledge bases about this.",
    });

    const result = await runCorrectiveRAG(provider, "nonexistent topic", baseConfig);

    expect(result.retrievalRounds).toBe(1);
    expect(result.answer).toBe("I couldn't find anything in the knowledge bases about this.");
    expect(result.trace).toEqual(
      expect.arrayContaining([
        expect.stringContaining("[retrieve round 1]"),
        expect.stringContaining("[grade] no chunks retrieved → empty"),
        expect.stringContaining("[answer]"),
      ]),
    );
    // No reformulation attempted for empty results
    expect(mockSearch).toHaveBeenCalledTimes(1);
  });

  it("passes correct scopes and config to searchKnowledgeBases", async () => {
    mockSearch.mockResolvedValue(makeChunks(1));

    const provider = makeMockProvider({ grades: ["sufficient"] });
    const config: RAGGraphConfig = {
      ...baseConfig,
      scopes: ["chat"],
      max_chunks: 10,
      min_score: 0.5,
    };

    await runCorrectiveRAG(provider, "test query", config);

    expect(mockSearch).toHaveBeenCalledWith({
      query: "test query",
      scopes: ["chat"],
      max_chunks: 10,
      min_score: 0.5,
    });
  });

  it("uses original query as initial search query", async () => {
    mockSearch.mockResolvedValue(makeChunks(2));
    const provider = makeMockProvider({ grades: ["sufficient"] });

    await runCorrectiveRAG(provider, "my specific question", baseConfig);

    expect(mockSearch.mock.calls[0][0].query).toBe("my specific question");
  });

  it("handles LLM returning invalid grade gracefully (defaults to insufficient)", async () => {
    const chunks = makeChunks(2);
    mockSearch.mockResolvedValue(chunks);

    const config: RAGGraphConfig = { ...baseConfig, max_retrievals: 1 };
    const provider = makeMockProvider({
      grades: ["maybe_relevant"],
      answer: "Answering anyway.",
    });

    const result = await runCorrectiveRAG(provider, "ambiguous query", config);

    // Invalid grade treated as "insufficient", but capped at max_retrievals=1 → answers
    expect(result.retrievalRounds).toBe(1);
    expect(result.answer).toBe("Answering anyway.");
  });
});
