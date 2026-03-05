import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../slack/commandExecutor.js";
import type { RoutedAction } from "../slack/messageRouter.js";
import type { GenerateImageExecution } from "./routingTypes.js";

// Mock dependencies
vi.mock("../../shared/modelConfig.js", () => ({
  getModelForRole: vi.fn(() => "gpt-image-1"),
}));

const mockStoreGeneratedImage = vi.fn();
vi.mock("../chat/imageStore.js", () => ({
  storeGeneratedImage: (...args: unknown[]) => mockStoreGeneratedImage(...args),
}));

const mockSearchKnowledgeBases = vi.fn();
vi.mock("../kb/kbService.js", () => ({
  searchKnowledgeBases: (...args: unknown[]) => mockSearchKnowledgeBases(...args),
}));

const mockRunEvaluator = vi.fn();
vi.mock("../kb/research/stages/evaluator.js", () => ({
  runEvaluator: (...args: unknown[]) => mockRunEvaluator(...args),
}));

const mockGetResearchLLMClient = vi.fn();
vi.mock("../kb/research/llmClient.js", () => ({
  getResearchLLMClient: () => mockGetResearchLLMClient(),
}));

vi.mock("../kb/research/auditLog.js", () => ({
  StepRecorder: class MockStepRecorder {
    recordInput = vi.fn();
    recordOutput = vi.fn();
    recordLLMCall = vi.fn();
    recordRetrieval = vi.fn();
    finish = vi.fn();
  },
}));

// Mock the LLM provider module-level variable via the initExecutorLLM function
// We need to import and call initExecutorLLM to set the provider
import { initExecutorLLM } from "./executors.js";

// Also need to mock all the heavy dependencies that executors.ts imports
vi.mock("../jobs/jobService.js", () => ({
  cancel: vi.fn(),
  confirmJob: vi.fn(),
  createJobFromSlack: vi.fn(),
  createJobFromWeb: vi.fn(),
  createRespondToCommentsJob: vi.fn(),
  findJobByTaskId: vi.fn(),
  promotePr: vi.fn(),
  queryJobs: vi.fn().mockResolvedValue({ jobs: [] }),
  retry: vi.fn(),
}));

vi.mock("../github/mongoFormatting.js", () => ({
  formatInstantQueryFromMongo: vi.fn(),
}));

vi.mock("../github/mongoQueries.js", () => ({
  executeInstantQueryFromMongo: vi.fn(),
}));

vi.mock("../github/recapService.js", () => ({
  executeRecapInline: vi.fn(),
}));

vi.mock("./researchExecutor.js", () => ({
  executeResearch: vi.fn(),
}));

vi.mock("./routingConfig.js", () => ({
  getRoutingConfig: vi.fn(() => ({ actions: {}, custom_actions: {} })),
  initRoutingConfig: vi.fn(),
}));

import { executeAction } from "./executors.js";

// --- Helpers ---

function makeAction(args: Record<string, unknown> = {}, reply = ""): RoutedAction {
  return { command: "generate_image", args, reply };
}

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    userId: "U123",
    ownerId: "owner1",
    source: "web",
    eventId: "evt1",
    web: { conversationId: "conv-abc" },
    ...overrides,
  };
}

const baseExecDef: GenerateImageExecution = {
  type: "generate_image",
  default_size: "auto",
  default_quality: "auto",
  reply_error: "⚠️ Image generation failed: {{error}}",
  reply_unsupported: "⚠️ Image gen not available.",
};

// --- Tests ---

describe("executeGenerateImage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns unsupported when provider has no generateImage method", async () => {
    // Init with a provider that has no generateImage
    const mockProvider = {
      chat: vi.fn(),
    };
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    initExecutorLLM(mockProvider as any);

    const result = await executeAction(makeAction({ prompt: "a cat" }), makeCtx(), baseExecDef);
    expect(result.actionTaken).toBe("generate_image: unsupported");
    expect(result.reply).toContain("not available");
  });

  it("returns error when prompt is empty", async () => {
    const mockProvider = {
      chat: vi.fn(),
      generateImage: vi.fn(),
    };
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    initExecutorLLM(mockProvider as any);

    const result = await executeAction(makeAction({ prompt: "" }), makeCtx(), baseExecDef);
    expect(result.actionTaken).toBe("generate_image: missing prompt");
    expect(result.reply).toContain("need a description");
  });

  it("returns error when prompt is missing", async () => {
    const mockProvider = {
      chat: vi.fn(),
      generateImage: vi.fn(),
    };
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    initExecutorLLM(mockProvider as any);

    const result = await executeAction(makeAction({}), makeCtx(), baseExecDef);
    expect(result.actionTaken).toBe("generate_image: missing prompt");
  });

  it("generates image successfully and returns image ref", async () => {
    const mockProvider = {
      chat: vi.fn(),
      generateImage: vi.fn().mockResolvedValue([
        {
          base64: "iVBORw0KGgo=",
          mediaType: "image/png",
          revisedPrompt: "A fluffy cartoon cat",
        },
      ]),
    };
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    initExecutorLLM(mockProvider as any);

    mockStoreGeneratedImage.mockResolvedValue({
      url: "/api/web/images/img-123",
      alt: "A fluffy cartoon cat",
    });

    const result = await executeAction(
      makeAction({ prompt: "a cartoon cat" }, "Here's your image!"),
      makeCtx(),
      baseExecDef,
    );

    expect(result.actionTaken).toBe("generate_image");
    expect(result.reply).toBe("Here's your image!");
    expect(result.images).toHaveLength(1);
    expect(result.images![0].url).toBe("/api/web/images/img-123");
    expect(result.images![0].alt).toBe("A fluffy cartoon cat");

    // Verify generateImage was called with correct params
    // size/quality come from execDef defaults ("auto")
    expect(mockProvider.generateImage).toHaveBeenCalledWith({
      model: "gpt-image-1",
      prompt: "a cartoon cat",
      size: "auto",
      quality: "auto",
    });

    // Verify storeGeneratedImage was called
    expect(mockStoreGeneratedImage).toHaveBeenCalledWith({
      base64: "iVBORw0KGgo=",
      mediaType: "image/png",
      prompt: "a cartoon cat",
      revisedPrompt: "A fluffy cartoon cat",
      model: "gpt-image-1",
      createdBy: "owner1",
      conversationId: "conv-abc",
    });
  });

  it("uses revised prompt as reply text when action.reply is empty", async () => {
    const mockProvider = {
      chat: vi.fn(),
      generateImage: vi.fn().mockResolvedValue([
        {
          base64: "AAAA",
          mediaType: "image/png",
          revisedPrompt: "A majestic mountain landscape",
        },
      ]),
    };
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    initExecutorLLM(mockProvider as any);

    mockStoreGeneratedImage.mockResolvedValue({
      url: "/api/web/images/img-456",
      alt: "A majestic mountain landscape",
    });

    const result = await executeAction(
      makeAction({ prompt: "mountains" }, ""),
      makeCtx(),
      baseExecDef,
    );

    expect(result.reply).toBe("A majestic mountain landscape");
  });

  it("falls back to 'Here you go.' when no reply or revised prompt", async () => {
    const mockProvider = {
      chat: vi.fn(),
      generateImage: vi.fn().mockResolvedValue([
        {
          base64: "AAAA",
          mediaType: "image/png",
        },
      ]),
    };
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    initExecutorLLM(mockProvider as any);

    mockStoreGeneratedImage.mockResolvedValue({
      url: "/api/web/images/img-789",
      alt: "mountains",
    });

    const result = await executeAction(
      makeAction({ prompt: "mountains" }, ""),
      makeCtx(),
      baseExecDef,
    );

    expect(result.reply).toBe("Here you go.");
  });

  it("passes size and quality args through to provider", async () => {
    const mockProvider = {
      chat: vi.fn(),
      generateImage: vi.fn().mockResolvedValue([{ base64: "AAAA", mediaType: "image/png" }]),
    };
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    initExecutorLLM(mockProvider as any);

    mockStoreGeneratedImage.mockResolvedValue({
      url: "/api/web/images/img-sz",
      alt: "test",
    });

    await executeAction(
      makeAction({ prompt: "test", size: "1024x1536", quality: "high" }),
      makeCtx(),
      baseExecDef,
    );

    expect(mockProvider.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        size: "1024x1536",
        quality: "high",
      }),
    );
  });

  it("handles API errors gracefully", async () => {
    const mockProvider = {
      chat: vi.fn(),
      generateImage: vi.fn().mockRejectedValue(new Error("API rate limit exceeded")),
    };
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    initExecutorLLM(mockProvider as any);

    const result = await executeAction(makeAction({ prompt: "a cat" }), makeCtx(), baseExecDef);

    expect(result.actionTaken).toBe("generate_image: failed");
    expect(result.reply).toContain("Image generation failed");
    expect(result.reply).toContain("API rate limit exceeded");
  });

  it("handles empty image results", async () => {
    const mockProvider = {
      chat: vi.fn(),
      generateImage: vi.fn().mockResolvedValue([]),
    };
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    initExecutorLLM(mockProvider as any);

    const result = await executeAction(makeAction({ prompt: "something" }), makeCtx(), baseExecDef);

    expect(result.actionTaken).toBe("generate_image: empty");
    expect(result.reply).toContain("no results");
  });
});

// --- KB enrichment tests ---

describe("KB-enriched image prompt", () => {
  const kbExecDef: GenerateImageExecution = {
    ...baseExecDef,
    kb_scopes: ["chat", "all"],
    kb_min_score: 0.5,
  };

  function setupProvider(enrichedText = "enriched prompt") {
    const mockProvider = {
      chat: vi.fn().mockResolvedValue({ text: enrichedText, toolCalls: [] }),
      generateImage: vi
        .fn()
        .mockResolvedValue([{ base64: "AAAA", mediaType: "image/png", revisedPrompt: "revised" }]),
    };
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    initExecutorLLM(mockProvider as any);
    mockStoreGeneratedImage.mockResolvedValue({ url: "/api/web/images/img-kb", alt: "test" });
    return mockProvider;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips enrichment when no KB results found", async () => {
    const mockProvider = setupProvider();
    mockSearchKnowledgeBases.mockResolvedValue([]);

    const result = await executeAction(makeAction({ prompt: "a cat" }), makeCtx(), kbExecDef);

    expect(result.actionTaken).toBe("generate_image");
    // Should NOT call enrichment LLM — prompt passes through unchanged
    expect(mockProvider.chat).not.toHaveBeenCalled();
    expect(mockProvider.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "a cat" }),
    );
  });

  it("skips enrichment when all KB results below score threshold", async () => {
    const mockProvider = setupProvider();
    mockSearchKnowledgeBases.mockResolvedValue([
      { content: "low relevance", score: 0.3, kb_name: "kb1", source_file: "f.md", metadata: {} },
      { content: "also low", score: 0.1, kb_name: "kb1", source_file: "g.md", metadata: {} },
    ]);

    const result = await executeAction(makeAction({ prompt: "a cat" }), makeCtx(), kbExecDef);

    expect(result.actionTaken).toBe("generate_image");
    expect(mockProvider.chat).not.toHaveBeenCalled();
    expect(mockRunEvaluator).not.toHaveBeenCalled();
  });

  it("runs evaluator and enriches prompt when correct chunks found", async () => {
    const mockProvider = setupProvider("a cat with brand blue #2563EB background");
    const kbChunk = {
      content: "Brand color: #2563EB",
      score: 0.8,
      kb_name: "brand",
      kb_id: "kb1",
      source_file: "brand.md",
      metadata: {},
    };
    mockSearchKnowledgeBases.mockResolvedValue([kbChunk]);
    mockGetResearchLLMClient.mockReturnValue({ chat: vi.fn() });
    mockRunEvaluator.mockResolvedValue({
      evaluations: [{ chunk: kbChunk, relevance: "correct", score: 5, reasoning: "relevant" }],
      correct_count: 1,
      incorrect_count: 0,
      ambiguous_count: 0,
      needs_requery: false,
      reformulated_queries: [],
    });

    const result = await executeAction(makeAction({ prompt: "a cat" }), makeCtx(), kbExecDef);

    expect(result.actionTaken).toBe("generate_image");
    // Evaluator was called
    expect(mockRunEvaluator).toHaveBeenCalled();
    // Enrichment LLM was called
    expect(mockProvider.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining("image prompt writer"),
      }),
    );
    // Image was generated with enriched prompt
    expect(mockProvider.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "a cat with brand blue #2563EB background" }),
    );
  });

  it("skips enrichment when evaluator classifies all chunks as incorrect", async () => {
    const mockProvider = setupProvider();
    const kbChunk = {
      content: "Unrelated code docs",
      score: 0.6,
      kb_name: "docs",
      kb_id: "kb1",
      source_file: "api.md",
      metadata: {},
    };
    mockSearchKnowledgeBases.mockResolvedValue([kbChunk]);
    mockGetResearchLLMClient.mockReturnValue({ chat: vi.fn() });
    mockRunEvaluator.mockResolvedValue({
      evaluations: [
        { chunk: kbChunk, relevance: "incorrect", score: 1, reasoning: "not relevant" },
      ],
      correct_count: 0,
      incorrect_count: 1,
      ambiguous_count: 0,
      needs_requery: false,
      reformulated_queries: [],
    });

    await executeAction(makeAction({ prompt: "a cat" }), makeCtx(), kbExecDef);

    expect(mockRunEvaluator).toHaveBeenCalled();
    // Enrichment LLM should NOT be called — no correct chunks
    expect(mockProvider.chat).not.toHaveBeenCalled();
    // Image generated with original prompt
    expect(mockProvider.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "a cat" }),
    );
  });

  it("skips enrichment when evaluator classifies all as ambiguous", async () => {
    const mockProvider = setupProvider();
    const kbChunk = {
      content: "Maybe relevant",
      score: 0.6,
      kb_name: "docs",
      kb_id: "kb1",
      source_file: "maybe.md",
      metadata: {},
    };
    mockSearchKnowledgeBases.mockResolvedValue([kbChunk]);
    mockGetResearchLLMClient.mockReturnValue({ chat: vi.fn() });
    mockRunEvaluator.mockResolvedValue({
      evaluations: [{ chunk: kbChunk, relevance: "ambiguous", score: 3, reasoning: "unclear" }],
      correct_count: 0,
      incorrect_count: 0,
      ambiguous_count: 1,
      needs_requery: false,
      reformulated_queries: [],
    });

    await executeAction(makeAction({ prompt: "a cat" }), makeCtx(), kbExecDef);

    // Enrichment LLM should NOT be called — no correct chunks (stricter than research pipeline)
    expect(mockProvider.chat).not.toHaveBeenCalled();
  });

  it("falls back to score-filtered chunks when evaluator fails", async () => {
    const mockProvider = setupProvider("enriched from fallback");
    mockSearchKnowledgeBases.mockResolvedValue([
      {
        content: "Brand color: blue",
        score: 0.7,
        kb_name: "brand",
        kb_id: "kb1",
        source_file: "b.md",
        metadata: {},
      },
    ]);
    mockGetResearchLLMClient.mockImplementation(() => {
      throw new Error("Research LLM not configured");
    });

    const result = await executeAction(makeAction({ prompt: "a logo" }), makeCtx(), kbExecDef);

    expect(result.actionTaken).toBe("generate_image");
    // Should still enrich with score-filtered chunks as fallback
    expect(mockProvider.chat).toHaveBeenCalled();
    expect(mockProvider.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "enriched from fallback" }),
    );
  });

  it("falls back to original prompt when entire enrichment fails", async () => {
    const mockProvider = setupProvider();
    mockSearchKnowledgeBases.mockRejectedValue(new Error("DB connection lost"));

    const result = await executeAction(makeAction({ prompt: "a cat" }), makeCtx(), kbExecDef);

    expect(result.actionTaken).toBe("generate_image");
    expect(mockProvider.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "a cat" }),
    );
  });

  it("does not enrich when kb_scopes is not configured", async () => {
    const mockProvider = setupProvider();

    await executeAction(
      makeAction({ prompt: "a cat" }),
      makeCtx(),
      baseExecDef, // no kb_scopes
    );

    expect(mockSearchKnowledgeBases).not.toHaveBeenCalled();
    expect(mockProvider.chat).not.toHaveBeenCalled();
  });

  it("uses custom kb_min_score from config", async () => {
    const mockProvider = setupProvider();
    mockSearchKnowledgeBases.mockResolvedValue([
      {
        content: "Passes custom",
        score: 0.85,
        kb_name: "kb1",
        kb_id: "kb1",
        source_file: "f.md",
        metadata: {},
      },
      {
        content: "Below custom",
        score: 0.75,
        kb_name: "kb1",
        kb_id: "kb1",
        source_file: "g.md",
        metadata: {},
      },
    ]);
    mockGetResearchLLMClient.mockReturnValue({ chat: vi.fn() });
    mockRunEvaluator.mockResolvedValue({
      evaluations: [
        {
          chunk: { content: "Passes custom", score: 0.85 },
          relevance: "correct",
          score: 5,
          reasoning: "yes",
        },
      ],
      correct_count: 1,
      incorrect_count: 0,
      ambiguous_count: 0,
      needs_requery: false,
      reformulated_queries: [],
    });

    const strictExecDef: GenerateImageExecution = {
      ...baseExecDef,
      kb_scopes: ["chat"],
      kb_min_score: 0.8,
    };

    await executeAction(makeAction({ prompt: "a logo" }), makeCtx(), strictExecDef);

    // Evaluator should only receive the chunk above 0.8
    expect(mockRunEvaluator).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([expect.objectContaining({ content: "Passes custom" })]),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    // The below-threshold chunk should NOT be in the evaluator input
    const evalChunks = mockRunEvaluator.mock.calls[0][1];
    expect(evalChunks).toHaveLength(1);
  });
});
