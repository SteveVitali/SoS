import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KBSearchResult } from "../../shared/kbTypes.js";
import type { ResearchResult } from "../../shared/researchTypes.js";
import type { CommandContext } from "../slack/commandExecutor.js";
import type { RoutedAction } from "../slack/messageRouter.js";
import { executeResearch } from "./researchExecutor.js";
import type { ResearchExecution } from "./routingTypes.js";

// Mock the research pipeline entry point
vi.mock("../kb/kbService.js", () => ({
  researchKnowledgeBases: vi.fn(),
}));

// Mock the LLM synthesis layer
vi.mock("../kb/research/llmClient.js", () => ({
  getResearchLLMClient: vi.fn(() => ({ chat: vi.fn() })),
}));

vi.mock("../kb/research/stages/synthesizer.js", () => ({
  synthesizeForUser: vi.fn(),
}));

vi.mock("../kb/research/strategies.js", () => ({
  getStrategyConfig: vi.fn(() => ({
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
  })),
}));

import { researchKnowledgeBases } from "../kb/kbService.js";
import { synthesizeForUser } from "../kb/research/stages/synthesizer.js";

const mockResearch = vi.mocked(researchKnowledgeBases);
const mockSynthesize = vi.mocked(synthesizeForUser);

// --- Helpers ---

function makeAction(args: Record<string, unknown> = {}, reply = "On it."): RoutedAction {
  return { command: "kb_search", args, reply };
}

function makeCtx(): CommandContext {
  return {
    userId: "U123",
    ownerId: "owner1",
    source: "slack",
    eventId: "evt1",
    slack: { channelId: "C123", threadTs: "1234.5678", messageTs: "1234.5679" },
  };
}

const baseExecDef: ResearchExecution = {
  type: "research",
  scopes: ["chat", "all"],
  default_strategy: "simple",
  show_trace: true,
};

function makeChunk(content = "chunk content"): KBSearchResult {
  return {
    content,
    source_file: "docs/test.md",
    kb_name: "Test KB",
    kb_id: "kb-1",
    score: 0.85,
    metadata: { section: "Intro" },
  };
}

function makeResearchResult(overrides?: Partial<ResearchResult>): ResearchResult {
  return {
    session_id: "sess-abc",
    strategy: "simple",
    original_query: "test query",
    context: "Raw context from the pipeline.",
    chunks: [makeChunk()],
    reasoning_trace: "",
    metrics: {
      total_duration_ms: 2100,
      iterations: 1,
      llm_calls: 2,
      retrieval_calls: 3,
      chunks_retrieved: 8,
      chunks_used: 4,
      prompt_tokens: 500,
      completion_tokens: 200,
      estimated_cost_usd: 0.001,
    },
    audit: {} as ResearchResult["audit"],
    ...overrides,
  };
}

describe("executeResearch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: synthesizeForUser returns a coherent answer
    mockSynthesize.mockResolvedValue({
      answer: "The synthesized answer from the LLM.",
      chunks_used: [makeChunk()],
    });
  });

  it("returns helpful error when no query is provided", async () => {
    const action = makeAction({}, "");
    const result = await executeResearch(action, makeCtx(), baseExecDef);

    expect(result.actionTaken).toBe("research: no query");
    expect(result.reply).toContain("I need a question");
    expect(mockResearch).not.toHaveBeenCalled();
  });

  it("runs research pipeline and synthesizes a user-facing answer", async () => {
    mockResearch.mockResolvedValue(makeResearchResult());

    const action = makeAction({ query: "how does X work?" });
    const result = await executeResearch(action, makeCtx(), baseExecDef);

    expect(result.reply).toContain("The synthesized answer from the LLM.");
    expect(result.actionTaken).toContain("research:simple");
    expect(result.actionTaken).toContain("sess-abc");
    expect(mockResearch).toHaveBeenCalledTimes(1);
    expect(mockSynthesize).toHaveBeenCalledTimes(1);
    expect(mockResearch).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "how does X work?",
        strategy: "simple",
        scopes: ["chat", "all"],
      }),
    );
  });

  it("falls back to raw context when synthesis fails", async () => {
    mockResearch.mockResolvedValue(makeResearchResult());
    mockSynthesize.mockRejectedValue(new Error("LLM unavailable"));

    const action = makeAction({ query: "test" });
    const execDef: ResearchExecution = { ...baseExecDef, show_trace: false };
    const result = await executeResearch(action, makeCtx(), execDef);

    expect(result.reply).toContain("Raw context from the pipeline.");
  });

  it("skips synthesis when no chunks are returned", async () => {
    mockResearch.mockResolvedValue(makeResearchResult({ chunks: [], context: "" }));

    const action = makeAction({ query: "test" });
    const execDef: ResearchExecution = { ...baseExecDef, show_trace: false };
    const result = await executeResearch(action, makeCtx(), execDef);

    expect(mockSynthesize).not.toHaveBeenCalled();
    expect(result.reply).toContain("couldn't find any relevant information");
  });

  it("uses LLM-selected strategy from action args", async () => {
    mockResearch.mockResolvedValue(makeResearchResult({ strategy: "deep" }));

    const action = makeAction({ query: "complex question", strategy: "deep" });
    const result = await executeResearch(action, makeCtx(), baseExecDef);

    expect(mockResearch).toHaveBeenCalledWith(expect.objectContaining({ strategy: "deep" }));
    expect(result.actionTaken).toContain("research:deep");
  });

  it("falls back to default_strategy when args.strategy is invalid", async () => {
    mockResearch.mockResolvedValue(makeResearchResult());

    const action = makeAction({ query: "test", strategy: "turbo" });
    const result = await executeResearch(action, makeCtx(), baseExecDef);

    expect(mockResearch).toHaveBeenCalledWith(expect.objectContaining({ strategy: "simple" }));
    expect(result.actionTaken).toContain("research:simple");
  });

  it("falls back to 'simple' when no default_strategy is set and args.strategy is missing", async () => {
    mockResearch.mockResolvedValue(makeResearchResult());

    const execDef: ResearchExecution = { type: "research" };
    const action = makeAction({ query: "test" });
    await executeResearch(action, makeCtx(), execDef);

    expect(mockResearch).toHaveBeenCalledWith(expect.objectContaining({ strategy: "simple" }));
  });

  it("appends trace footer when show_trace is true", async () => {
    mockResearch.mockResolvedValue(
      makeResearchResult({
        metrics: {
          total_duration_ms: 3500,
          iterations: 2,
          llm_calls: 5,
          retrieval_calls: 4,
          chunks_retrieved: 12,
          chunks_used: 6,
          prompt_tokens: 1000,
          completion_tokens: 400,
          estimated_cost_usd: 0.003,
        },
      }),
    );

    const action = makeAction({ query: "test" });
    const result = await executeResearch(action, makeCtx(), baseExecDef);

    expect(result.reply).toContain("📎");
    expect(result.reply).toContain("strategy: simple");
    expect(result.reply).toContain("4 retrievals");
    expect(result.reply).toContain("6 chunks used");
    expect(result.reply).toContain("2 iterations");
    expect(result.reply).toContain("3.5s");
  });

  it("does not append trace footer when show_trace is false", async () => {
    mockResearch.mockResolvedValue(makeResearchResult());

    const action = makeAction({ query: "test" });
    const execDef: ResearchExecution = { ...baseExecDef, show_trace: false };
    const result = await executeResearch(action, makeCtx(), execDef);

    expect(result.reply).not.toContain("📎");
    expect(result.reply).toBe("The synthesized answer from the LLM.");
  });

  it("prepends routing reply when it is meaningful", async () => {
    mockResearch.mockResolvedValue(makeResearchResult());

    const action = makeAction({ query: "test" }, "Let me look that up for you.");
    const execDef: ResearchExecution = { ...baseExecDef, show_trace: false };
    const result = await executeResearch(action, makeCtx(), execDef);

    expect(result.reply).toMatch(/^Let me look that up for you\.\n\n/);
  });

  it("does not prepend 'On it.' as routing reply", async () => {
    mockResearch.mockResolvedValue(makeResearchResult());

    const action = makeAction({ query: "test" }, "On it.");
    const execDef: ResearchExecution = { ...baseExecDef, show_trace: false };
    const result = await executeResearch(action, makeCtx(), execDef);

    expect(result.reply).not.toContain("On it.");
  });

  it("returns error reply when research pipeline throws", async () => {
    mockResearch.mockRejectedValue(new Error("Vector store not initialized"));

    const action = makeAction({ query: "test" });
    const result = await executeResearch(action, makeCtx(), baseExecDef);

    expect(result.actionTaken).toBe("research:simple failed");
    expect(result.reply).toContain("Knowledge base search failed");
    expect(result.reply).toContain("Vector store not initialized");
  });

  it("uses reply_error template when provided", async () => {
    mockResearch.mockRejectedValue(new Error("timeout"));

    const action = makeAction({ query: "test" });
    const execDef: ResearchExecution = {
      ...baseExecDef,
      reply_error: "⚠️ Oops: {{error}}",
    };
    const result = await executeResearch(action, makeCtx(), execDef);

    expect(result.reply).toContain("⚠️ Oops: timeout");
  });

  it("does not prepend 'On it.' in error replies", async () => {
    mockResearch.mockRejectedValue(new Error("boom"));

    const action = makeAction({ query: "test" }, "On it.");
    const result = await executeResearch(action, makeCtx(), baseExecDef);

    expect(result.reply).not.toMatch(/^On it\./);
    expect(result.reply).toContain("Knowledge base search failed");
  });

  it("accepts query from args.question or args.task_text", async () => {
    mockResearch.mockResolvedValue(makeResearchResult());

    // Test args.question
    const action1 = makeAction({ question: "from question field" });
    await executeResearch(action1, makeCtx(), baseExecDef);
    expect(mockResearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: "from question field" }),
    );

    vi.clearAllMocks();

    // Test args.task_text
    const action2 = makeAction({ task_text: "from task_text field" });
    await executeResearch(action2, makeCtx(), baseExecDef);
    expect(mockResearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: "from task_text field" }),
    );
  });

  it("uses reply_template when provided", async () => {
    mockResearch.mockResolvedValue(makeResearchResult());

    const action = makeAction({ query: "test" });
    const execDef: ResearchExecution = {
      ...baseExecDef,
      show_trace: false,
      reply_template: "Found via {{strategy}}: {{answer}}",
    };
    const result = await executeResearch(action, makeCtx(), execDef);

    expect(result.reply).toBe("Found via simple: The synthesized answer from the LLM.");
  });

  it("passes agent strategy through to research pipeline", async () => {
    mockResearch.mockResolvedValue(makeResearchResult({ strategy: "agent" }));

    const action = makeAction({ query: "investigate X thoroughly", strategy: "agent" });
    await executeResearch(action, makeCtx(), baseExecDef);

    expect(mockResearch).toHaveBeenCalledWith(expect.objectContaining({ strategy: "agent" }));
  });

  it("passes consumer from context but not owner", async () => {
    mockResearch.mockResolvedValue(makeResearchResult());

    const action = makeAction({ query: "test" });
    await executeResearch(action, makeCtx(), baseExecDef);

    expect(mockResearch).toHaveBeenCalledWith(
      expect.objectContaining({
        consumer: { type: "chat", id: "routing:U123" },
      }),
    );
    // owner should NOT be passed — KBs are shared, not per-user
    expect(mockResearch).toHaveBeenCalledWith(
      expect.not.objectContaining({ owner: expect.anything() }),
    );
  });

  it("returns friendly message when context is empty", async () => {
    mockResearch.mockResolvedValue(makeResearchResult({ context: "", chunks: [] }));

    const action = makeAction({ query: "test" });
    const execDef: ResearchExecution = { ...baseExecDef, show_trace: false };
    const result = await executeResearch(action, makeCtx(), execDef);

    expect(result.reply).toContain("couldn't find any relevant information");
  });

  it("passes reasoning_trace to synthesizeForUser", async () => {
    mockResearch.mockResolvedValue(
      makeResearchResult({ reasoning_trace: "Deep analysis of the topic" }),
    );

    const action = makeAction({ query: "test" });
    await executeResearch(action, makeCtx(), baseExecDef);

    expect(mockSynthesize).toHaveBeenCalledWith(
      "test",
      expect.any(Array),
      "Deep analysis of the topic",
      expect.any(Object),
      expect.any(Object),
    );
  });
});
