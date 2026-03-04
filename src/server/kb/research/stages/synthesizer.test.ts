import { describe, expect, it, vi } from "vitest";
import type { KBSearchResult } from "../../../../shared/kbTypes.js";
import type { ResearchConfig } from "../../../../shared/researchTypes.js";
import { AuditEmitter } from "../auditLog.js";
import type { LLMClient, LLMResponse } from "../llmClient.js";
import { runSynthesizer, synthesizeForUser } from "./synthesizer.js";

function makeConfig(overrides: Partial<ResearchConfig> = {}): ResearchConfig {
  return {
    strategy: "simple",
    max_iterations: 1,
    max_llm_calls: 5,
    max_retrieval_calls: 10,
    max_wall_time_ms: 30000,
    enable_decomposition: false,
    enable_hyde: true,
    enable_step_back: false,
    enable_crag: false,
    enable_ircot: false,
    max_chunks_per_query: 5,
    min_similarity_score: 0.3,
    dedup_threshold: 0.9,
    ...overrides,
  };
}

function makeChunk(overrides: Partial<KBSearchResult> = {}): KBSearchResult {
  return {
    content: "Test chunk content about TypeScript patterns.",
    source_file: "docs/patterns.md",
    kb_name: "Design Docs",
    kb_id: "kb-1",
    score: 0.85,
    metadata: { section: "Introduction" },
    ...overrides,
  };
}

describe("synthesizer", () => {
  it("returns empty context for no chunks", () => {
    const config = makeConfig();
    const audit = new AuditEmitter("q", ["chat"], config);
    const recorder = audit.startStep("synthesis", 0);

    const result = runSynthesizer("test query", [], "", config, recorder);
    expect(result.context).toBe("");
    expect(result.chunks_used).toEqual([]);
  });

  it("formats chunks with numbered citations", () => {
    const config = makeConfig();
    const audit = new AuditEmitter("q", ["chat"], config);
    const recorder = audit.startStep("synthesis", 0);
    const chunks = [
      makeChunk({ score: 0.9, content: "First chunk" }),
      makeChunk({ score: 0.8, content: "Second chunk", source_file: "other.md", metadata: {} }),
    ];

    const result = runSynthesizer("test query", chunks, "", config, recorder);
    expect(result.context).toContain("[1]");
    expect(result.context).toContain("[2]");
    expect(result.context).toContain("First chunk");
    expect(result.context).toContain("Second chunk");
    expect(result.context).toContain("Design Docs");
    expect(result.chunks_used).toHaveLength(2);
  });

  it("includes reasoning trace for deep strategy", () => {
    const config = makeConfig({ strategy: "deep" });
    const audit = new AuditEmitter("q", ["chat"], config);
    const recorder = audit.startStep("synthesis", 0);
    const chunks = [makeChunk()];

    const result = runSynthesizer("q", chunks, "Deep reasoning here", config, recorder);
    expect(result.context).toContain("Research Reasoning");
    expect(result.context).toContain("Deep reasoning here");
    expect(result.reasoning_trace).toBe("Deep reasoning here");
  });

  it("omits reasoning trace for simple strategy", () => {
    const config = makeConfig({ strategy: "simple" });
    const audit = new AuditEmitter("q", ["chat"], config);
    const recorder = audit.startStep("synthesis", 0);
    const chunks = [makeChunk()];

    const result = runSynthesizer("q", chunks, "Reasoning text", config, recorder);
    expect(result.context).not.toContain("Research Reasoning");
  });

  it("respects max_chunks_per_query limit", () => {
    const config = makeConfig({ max_chunks_per_query: 2 });
    const audit = new AuditEmitter("q", ["chat"], config);
    const recorder = audit.startStep("synthesis", 0);
    const chunks = [
      makeChunk({ score: 0.9 }),
      makeChunk({ score: 0.8 }),
      makeChunk({ score: 0.7 }),
      makeChunk({ score: 0.6 }),
    ];

    const result = runSynthesizer("q", chunks, "", config, recorder);
    expect(result.chunks_used).toHaveLength(2);
  });

  it("includes strategy name in context", () => {
    const config = makeConfig({ strategy: "deep" });
    const audit = new AuditEmitter("q", ["chat"], config);
    const recorder = audit.startStep("synthesis", 0);
    const chunks = [makeChunk()];

    const result = runSynthesizer("q", chunks, "", config, recorder);
    expect(result.context).toContain("deep");
  });
});

// ─── synthesizeForUser tests ────────────────────────────────────

function makeMockLLM(content = "A well-structured answer with [1] citations."): LLMClient {
  const mockResponse: LLMResponse = {
    content,
    model: "test-model",
    prompt_tokens: 100,
    completion_tokens: 50,
    duration_ms: 500,
    tool_calls: [],
  };
  return {
    chat: vi.fn().mockResolvedValue(mockResponse),
    chatWithTools: vi.fn().mockResolvedValue(mockResponse),
    toAuditRecord: vi.fn(),
    config: {
      model: "test-model",
      api_key: "test-key",
      base_url: "http://localhost",
      temperature: 0,
      max_tokens: 2048,
    },
  };
}

describe("synthesizeForUser", () => {
  it("returns empty answer for no chunks", async () => {
    const config = makeConfig();
    const llm = makeMockLLM();

    const result = await synthesizeForUser("test query", [], "", config, llm);
    expect(result.answer).toBe("");
    expect(result.chunks_used).toEqual([]);
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("calls LLM and returns synthesized answer", async () => {
    const config = makeConfig();
    const llm = makeMockLLM(
      "The venue woe lifecycle involves [1] proposal, [2] voting, and resolution.",
    );
    const chunks = [makeChunk({ content: "Proposal step" }), makeChunk({ content: "Voting step" })];

    const result = await synthesizeForUser("lifecycle of venue woe", chunks, "", config, llm);

    expect(result.answer).toContain("venue woe lifecycle");
    expect(result.chunks_used).toHaveLength(2);
    expect(llm.chat).toHaveBeenCalledTimes(1);

    // Verify the prompt includes the query and chunk content
    const callArgs = vi.mocked(llm.chat).mock.calls[0];
    const systemMsg = callArgs[0][0];
    const userMsg = callArgs[0][1];
    expect(systemMsg.role).toBe("system");
    expect(systemMsg.content).toContain("knowledgeable assistant");
    expect(userMsg.content).toContain("lifecycle of venue woe");
    expect(userMsg.content).toContain("Proposal step");
    expect(userMsg.content).toContain("Voting step");
  });

  it("includes reasoning trace in prompt when provided", async () => {
    const config = makeConfig();
    const llm = makeMockLLM();
    const chunks = [makeChunk()];

    await synthesizeForUser("test", chunks, "Deep reasoning about the topic", config, llm);

    const userMsg = vi.mocked(llm.chat).mock.calls[0][0][1];
    expect(userMsg.content).toContain("Deep reasoning about the topic");
  });

  it("falls back to raw chunk dump when LLM fails", async () => {
    const config = makeConfig();
    const llm = makeMockLLM();
    vi.mocked(llm.chat).mockRejectedValue(new Error("API timeout"));
    const chunks = [
      makeChunk({ content: "Chunk A content" }),
      makeChunk({ content: "Chunk B content" }),
    ];

    const result = await synthesizeForUser("test", chunks, "", config, llm);

    expect(result.answer).toContain("[1] Chunk A content");
    expect(result.answer).toContain("[2] Chunk B content");
    expect(result.chunks_used).toHaveLength(2);
  });

  it("respects max_chunks_per_query limit", async () => {
    const config = makeConfig({ max_chunks_per_query: 2 });
    const llm = makeMockLLM();
    const chunks = [
      makeChunk({ score: 0.9, content: "A" }),
      makeChunk({ score: 0.8, content: "B" }),
      makeChunk({ score: 0.7, content: "C" }),
    ];

    const result = await synthesizeForUser("test", chunks, "", config, llm);

    expect(result.chunks_used).toHaveLength(2);
    // Verify only 2 chunks appear in the prompt
    const userMsg = vi.mocked(llm.chat).mock.calls[0][0][1];
    expect(userMsg.content).not.toContain("[3]");
  });
});
