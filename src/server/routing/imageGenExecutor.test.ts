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
