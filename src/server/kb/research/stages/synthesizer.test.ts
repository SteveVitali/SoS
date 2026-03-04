import { describe, expect, it, vi } from "vitest";
import type { KBSearchResult } from "../../../../shared/kbTypes.js";
import type { ResearchConfig } from "../../../../shared/researchTypes.js";
import { AuditEmitter } from "../auditLog.js";
import type { LLMClient, LLMClientConfig, LLMResponse } from "../llmClient.js";
import { runSynthesizer } from "./synthesizer.js";

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
    skip_llm_synthesis: false,
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

function makeMockLLM(
  responseContent = "Synthesized answer about TypeScript patterns [1].",
): LLMClient {
  const mockResponse: LLMResponse = {
    content: responseContent,
    model: "test-model",
    prompt_tokens: 100,
    completion_tokens: 50,
    duration_ms: 200,
    tool_calls: [],
  };
  return {
    config: {
      model: "test-model",
      api_key: "k",
      base_url: "http://x",
      temperature: 0,
      max_tokens: 1024,
    } as LLMClientConfig,
    chat: vi.fn().mockResolvedValue(mockResponse),
    chatWithTools: vi.fn().mockResolvedValue(mockResponse),
    toAuditRecord: vi.fn().mockReturnValue({
      call_id: "test",
      stage: "synthesis",
      purpose: "llm_synthesis",
      model: "test-model",
      prompt_tokens: 100,
      completion_tokens: 50,
      duration_ms: 200,
      input_preview: "",
      output_preview: "",
    }),
  };
}

describe("synthesizer", () => {
  // ─── Raw chunk-dump format (skip_llm_synthesis or no LLM) ──────

  it("returns empty context for no chunks", async () => {
    const config = makeConfig();
    const audit = new AuditEmitter("q", ["chat"], config);
    const recorder = audit.startStep("synthesis", 0);

    const result = await runSynthesizer("test query", [], "", config, recorder);
    expect(result.context).toBe("");
    expect(result.chunks_used).toEqual([]);
  });

  it("formats chunks with numbered citations when no LLM provided", async () => {
    const config = makeConfig();
    const audit = new AuditEmitter("q", ["chat"], config);
    const recorder = audit.startStep("synthesis", 0);
    const chunks = [
      makeChunk({ score: 0.9, content: "First chunk" }),
      makeChunk({ score: 0.8, content: "Second chunk", source_file: "other.md", metadata: {} }),
    ];

    const result = await runSynthesizer("test query", chunks, "", config, recorder);
    expect(result.context).toContain("[1]");
    expect(result.context).toContain("[2]");
    expect(result.context).toContain("First chunk");
    expect(result.context).toContain("Second chunk");
    expect(result.context).toContain("Design Docs");
    expect(result.chunks_used).toHaveLength(2);
  });

  it("includes reasoning trace for deep strategy in raw format", async () => {
    const config = makeConfig({ strategy: "deep", skip_llm_synthesis: true });
    const audit = new AuditEmitter("q", ["chat"], config);
    const recorder = audit.startStep("synthesis", 0);
    const chunks = [makeChunk()];

    const result = await runSynthesizer("q", chunks, "Deep reasoning here", config, recorder);
    expect(result.context).toContain("Research Reasoning");
    expect(result.context).toContain("Deep reasoning here");
    expect(result.reasoning_trace).toBe("Deep reasoning here");
  });

  it("omits reasoning trace for simple strategy in raw format", async () => {
    const config = makeConfig({ strategy: "simple", skip_llm_synthesis: true });
    const audit = new AuditEmitter("q", ["chat"], config);
    const recorder = audit.startStep("synthesis", 0);
    const chunks = [makeChunk()];

    const result = await runSynthesizer("q", chunks, "Reasoning text", config, recorder);
    expect(result.context).not.toContain("Research Reasoning");
  });

  it("respects max_chunks_per_query limit", async () => {
    const config = makeConfig({ max_chunks_per_query: 2 });
    const audit = new AuditEmitter("q", ["chat"], config);
    const recorder = audit.startStep("synthesis", 0);
    const chunks = [
      makeChunk({ score: 0.9 }),
      makeChunk({ score: 0.8 }),
      makeChunk({ score: 0.7 }),
      makeChunk({ score: 0.6 }),
    ];

    const result = await runSynthesizer("q", chunks, "", config, recorder);
    expect(result.chunks_used).toHaveLength(2);
  });

  it("includes strategy name in raw context", async () => {
    const config = makeConfig({ strategy: "deep", skip_llm_synthesis: true });
    const audit = new AuditEmitter("q", ["chat"], config);
    const recorder = audit.startStep("synthesis", 0);
    const chunks = [makeChunk()];

    const result = await runSynthesizer("q", chunks, "", config, recorder);
    expect(result.context).toContain("deep");
  });

  it("uses raw format when skip_llm_synthesis is true even with LLM", async () => {
    const config = makeConfig({ skip_llm_synthesis: true });
    const llm = makeMockLLM();
    const audit = new AuditEmitter("q", ["chat"], config);
    const recorder = audit.startStep("synthesis", 0);
    const chunks = [makeChunk()];

    const result = await runSynthesizer("q", chunks, "", config, recorder, llm);
    // Should use raw format, NOT call the LLM
    expect(llm.chat).not.toHaveBeenCalled();
    expect(result.context).toContain("Retrieved Context");
    expect(result.context).toContain("[1]");
  });

  // ─── LLM synthesis path ────────────────────────────────────────

  it("calls LLM for synthesis when enabled and LLM provided", async () => {
    const config = makeConfig({ skip_llm_synthesis: false });
    const llm = makeMockLLM("TypeScript uses structural typing [1].");
    const audit = new AuditEmitter("q", ["chat"], config);
    const recorder = audit.startStep("synthesis", 0);
    const chunks = [makeChunk()];

    const result = await runSynthesizer("q", chunks, "", config, recorder, llm);
    expect(llm.chat).toHaveBeenCalledOnce();
    expect(result.context).toContain("TypeScript uses structural typing [1].");
    expect(result.context).toContain("Source Index");
    expect(result.context).toContain("Design Docs");
    expect(result.chunks_used).toHaveLength(1);
  });

  it("records LLM call in audit log", async () => {
    const config = makeConfig({ skip_llm_synthesis: false });
    const llm = makeMockLLM();
    const audit = new AuditEmitter("q", ["chat"], config);
    const recorder = audit.startStep("synthesis", 0);
    const chunks = [makeChunk()];

    await runSynthesizer("q", chunks, "", config, recorder, llm);
    expect(llm.toAuditRecord).toHaveBeenCalledOnce();
  });

  it("falls back to raw format on LLM failure", async () => {
    const config = makeConfig({ skip_llm_synthesis: false });
    const llm = makeMockLLM();
    (llm.chat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("LLM down"));
    const audit = new AuditEmitter("q", ["chat"], config);
    const recorder = audit.startStep("synthesis", 0);
    const chunks = [makeChunk()];

    const result = await runSynthesizer("q", chunks, "", config, recorder, llm);
    // Should fall back to raw chunk format
    expect(result.context).toContain("Retrieved Context");
    expect(result.context).toContain("[1]");
    expect(result.chunks_used).toHaveLength(1);
  });

  it("passes source index and excerpts to LLM prompt", async () => {
    const config = makeConfig({ skip_llm_synthesis: false });
    const llm = makeMockLLM();
    const audit = new AuditEmitter("q", ["chat"], config);
    const recorder = audit.startStep("synthesis", 0);
    const chunks = [
      makeChunk({ score: 0.9, content: "Alpha content" }),
      makeChunk({ score: 0.8, content: "Beta content", source_file: "beta.md" }),
    ];

    await runSynthesizer("my question", chunks, "", config, recorder, llm);

    const chatCall = (llm.chat as ReturnType<typeof vi.fn>).mock.calls[0];
    const messages = chatCall[0];
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("my question");
    expect(messages[1].content).toContain("Alpha content");
    expect(messages[1].content).toContain("Beta content");
    expect(messages[1].content).toContain("Excerpt [1]");
    expect(messages[1].content).toContain("Excerpt [2]");
  });
});
