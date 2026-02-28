import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMProvider, LLMResponse } from "../../llm/llmProvider.js";
import type { CommandContext } from "../../slack/commandExecutor.js";
import type { RoutedAction } from "../../slack/messageRouter.js";
import type { LangGraphExecution } from "../routingTypes.js";
import { executeLangGraph, initGraphExecutor } from "./graphExecutor.js";

// Mock the corrective RAG runner
vi.mock("./correctiveRag.js", () => ({
  runCorrectiveRAG: vi.fn(),
}));

import { runCorrectiveRAG } from "./correctiveRag.js";

const mockRunRAG = vi.mocked(runCorrectiveRAG);

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

const baseExecDef: LangGraphExecution = {
  type: "langgraph",
  graph: "corrective_rag",
  graph_config: {
    scopes: ["chat", "all"],
    max_retrievals: 3,
    max_chunks: 8,
    min_score: 0.25,
    max_answer_tokens: 1024,
    show_trace: true,
  },
};

const mockProvider: LLMProvider = {
  chat: vi.fn(async (): Promise<LLMResponse> => ({ text: "mock", toolCalls: [] })),
};

describe("executeLangGraph", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initGraphExecutor(mockProvider, "test-model");
  });

  it("returns helpful error when no query is provided", async () => {
    const action = makeAction({}, ""); // empty reply too, so no fallback
    const result = await executeLangGraph(action, makeCtx(), baseExecDef);

    expect(result.actionTaken).toBe("langgraph: no query");
    expect(result.reply).toContain("I need a question");
    expect(mockRunRAG).not.toHaveBeenCalled();
  });

  it("runs corrective_rag graph and returns answer", async () => {
    mockRunRAG.mockResolvedValue({
      answer: "The answer from RAG.",
      trace: [
        '[retrieve round 1] query="test" → 3 chunks',
        '[grade] 3 chunks → "sufficient"',
        "[answer] generated 20 chars from 3 chunks",
      ],
      retrievalRounds: 1,
    });

    const action = makeAction({ query: "how does X work?" });
    const result = await executeLangGraph(action, makeCtx(), baseExecDef);

    expect(result.reply).toContain("The answer from RAG.");
    expect(result.actionTaken).toBe("corrective_rag: 1 rounds");
    expect(mockRunRAG).toHaveBeenCalledTimes(1);
  });

  it("appends trace footer when show_trace is true (default)", async () => {
    mockRunRAG.mockResolvedValue({
      answer: "Answer here.",
      trace: [
        '[retrieve round 1] query="q" → 5 chunks',
        '[grade] 5 chunks → "insufficient"',
        '[reformulate] "q" → "better q"',
        '[retrieve round 2] query="better q" → 3 chunks',
        '[grade] 3 chunks → "sufficient"',
        "[answer] generated 12 chars from 3 chunks",
      ],
      retrievalRounds: 2,
    });

    const action = makeAction({ query: "test" });
    const result = await executeLangGraph(action, makeCtx(), baseExecDef);

    expect(result.reply).toContain("📎");
    expect(result.reply).toContain("2 retrieval rounds");
    expect(result.reply).toContain("8 chunks graded");
    expect(result.reply).toContain("query reformulated 1×");
  });

  it("does not append trace footer when show_trace is false", async () => {
    mockRunRAG.mockResolvedValue({
      answer: "Answer.",
      trace: ['[retrieve round 1] query="q" → 2 chunks', "[answer] done"],
      retrievalRounds: 1,
    });

    const action = makeAction({ query: "test" });
    const execDef: LangGraphExecution = {
      ...baseExecDef,
      graph_config: { ...baseExecDef.graph_config, show_trace: false },
    };
    const result = await executeLangGraph(action, makeCtx(), execDef);

    expect(result.reply).not.toContain("📎");
    expect(result.reply).toBe("Answer.");
  });

  it("prepends routing reply when it is meaningful", async () => {
    mockRunRAG.mockResolvedValue({
      answer: "KB answer.",
      trace: [],
      retrievalRounds: 1,
    });

    const action = makeAction({ query: "test" }, "Let me look that up for you.");
    const result = await executeLangGraph(action, makeCtx(), baseExecDef);

    expect(result.reply).toMatch(/^Let me look that up for you\.\n\nKB answer\./);
  });

  it("does not prepend 'On it.' as routing reply", async () => {
    mockRunRAG.mockResolvedValue({
      answer: "Direct answer.",
      trace: [],
      retrievalRounds: 1,
    });

    const action = makeAction({ query: "test" }, "On it.");
    const result = await executeLangGraph(action, makeCtx(), baseExecDef);

    expect(result.reply).not.toContain("On it.");
    expect(result.reply).toContain("Direct answer.");
  });

  it("returns error reply when graph throws", async () => {
    mockRunRAG.mockRejectedValue(new Error("KB search failed"));

    const action = makeAction({ query: "test" });
    const result = await executeLangGraph(action, makeCtx(), baseExecDef);

    expect(result.actionTaken).toBe("langgraph: corrective_rag failed");
    expect(result.reply).toContain("Knowledge base search failed");
  });

  it("uses reply_error template when provided", async () => {
    mockRunRAG.mockRejectedValue(new Error("timeout"));

    const action = makeAction({ query: "test" });
    const execDef: LangGraphExecution = {
      ...baseExecDef,
      reply_error: "⚠️ Oops: {{error}}",
    };
    const result = await executeLangGraph(action, makeCtx(), execDef);

    expect(result.reply).toContain("⚠️ Oops: timeout");
  });

  it("returns error for unknown graph name", async () => {
    const action = makeAction({ query: "test" });
    const execDef: LangGraphExecution = {
      ...baseExecDef,
      graph: "nonexistent_graph",
    };
    const result = await executeLangGraph(action, makeCtx(), execDef);

    expect(result.actionTaken).toBe("langgraph: nonexistent_graph failed");
    expect(result.reply).toContain("Unknown graph: nonexistent_graph");
  });

  it("accepts query from args.question or args.task_text", async () => {
    mockRunRAG.mockResolvedValue({
      answer: "Found it.",
      trace: [],
      retrievalRounds: 1,
    });

    // Test args.question
    const action1 = makeAction({ question: "from question field" });
    await executeLangGraph(action1, makeCtx(), baseExecDef);
    expect(mockRunRAG.mock.calls[0][1]).toBe("from question field");

    vi.clearAllMocks();

    // Test args.task_text
    const action2 = makeAction({ task_text: "from task_text field" });
    await executeLangGraph(action2, makeCtx(), baseExecDef);
    expect(mockRunRAG.mock.calls[0][1]).toBe("from task_text field");
  });

  it("respects timeout_ms config", async () => {
    // Create a slow RAG that takes 200ms
    mockRunRAG.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                answer: "slow answer",
                trace: [],
                retrievalRounds: 1,
              }),
            200,
          ),
        ),
    );

    const action = makeAction({ query: "test" });
    const execDef: LangGraphExecution = {
      ...baseExecDef,
      graph_config: { ...baseExecDef.graph_config, timeout_ms: 50 },
    };

    const result = await executeLangGraph(action, makeCtx(), execDef);
    expect(result.actionTaken).toBe("langgraph: corrective_rag failed");
    expect(result.reply).toContain("timed out");
  });
});
