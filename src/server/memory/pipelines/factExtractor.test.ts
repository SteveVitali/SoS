import { afterEach, describe, expect, it, vi } from "vitest";
import type { InteractionEpisode, MemoryConfig } from "../../../shared/memoryTypes.js";
import { shouldExtract } from "./factExtractor.js";

// Mock all external dependencies
vi.mock("../episodeRepo.js", () => ({
  findEpisode: vi.fn(),
  listEpisodes: vi.fn(),
  updateExtractionStatus: vi.fn(),
}));

vi.mock("../memoryRepo.js", () => ({
  findMemory: vi.fn(),
  insertMemory: vi.fn(),
  invalidateMemory: vi.fn(),
  updateMemory: vi.fn(),
}));

vi.mock("../memoryVectorStore.js", () => ({
  addToMemoryTable: vi.fn(),
  searchMemoryTable: vi.fn(),
}));

vi.mock("../memoryFtsStore.js", () => ({
  addToMemoryFTS: vi.fn(),
  deleteFromMemoryFTS: vi.fn(),
}));

vi.mock("../../kb/embeddings.js", () => ({
  getEmbeddingProvider: vi.fn(() => ({
    embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    dimensions: 1536,
    modelName: "text-embedding-3-small",
  })),
}));

vi.mock("../../kb/research/llmClient.js", () => ({
  createResearchLLMClient: vi.fn(() => ({
    chat: vi.fn(),
    chatWithTools: vi.fn(),
    toAuditRecord: vi.fn(),
    config: {
      model: "gpt-4.1-mini",
      api_key: "test",
      base_url: "http://test",
      temperature: 0,
      max_tokens: 2048,
    },
  })),
}));

vi.mock("../../../shared/modelConfig.js", () => ({
  getModelForRole: vi.fn(() => "gpt-4.1-mini"),
}));

vi.mock("../memoryUtils.js", () => ({
  buildEmbeddingText: vi.fn(
    (content: string, context: string, keywords: string[]) =>
      `${content} ${context} ${keywords.join(" ")}`,
  ),
  createMemoryLLMClient: vi.fn(() => ({
    chat: vi.fn(),
    chatWithTools: vi.fn(),
    toAuditRecord: vi.fn(),
    config: {
      model: "gpt-4.1-mini",
      api_key: "test",
      base_url: "http://test",
      temperature: 0,
      max_tokens: 2048,
    },
  })),
  distanceToSimilarity: vi.fn((d: number) => 1 / (1 + d)),
}));

vi.mock("./memoryEvolver.js", () => ({
  evolveMemory: vi.fn().mockResolvedValue({ links_created: 0, neighbors_evolved: 0 }),
}));

import { findEpisode, listEpisodes, updateExtractionStatus } from "../episodeRepo.js";
import { findMemory, insertMemory, invalidateMemory, updateMemory } from "../memoryRepo.js";
import { createMemoryLLMClient } from "../memoryUtils.js";
import { addToMemoryTable, searchMemoryTable } from "../memoryVectorStore.js";
import { extractFactsFromEpisode } from "./factExtractor.js";
import { evolveMemory } from "./memoryEvolver.js";

const mockFindEpisode = vi.mocked(findEpisode);
const mockListEpisodes = vi.mocked(listEpisodes);
const mockUpdateExtractionStatus = vi.mocked(updateExtractionStatus);
const mockSearchMemoryTable = vi.mocked(searchMemoryTable);
const mockFindMemory = vi.mocked(findMemory);
const mockInsertMemory = vi.mocked(insertMemory);
const mockInvalidateMemory = vi.mocked(invalidateMemory);
const mockUpdateMemory = vi.mocked(updateMemory);
const mockAddToMemoryTable = vi.mocked(addToMemoryTable);
const mockCreateMemoryLLMClient = vi.mocked(createMemoryLLMClient);
const mockEvolveMemory = vi.mocked(evolveMemory);

function makeConfig(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return {
    enabled: true,
    extraction_model: "gpt-4.1-mini",
    extraction_min_turns: 1,
    extraction_skip_actions: ["no_op"],
    extraction_max_facts_per_call: 5,
    retrieval_max_memories: 8,
    retrieval_max_tokens: 1500,
    retrieval_min_score: 0.3,
    retrieval_recency_halflife_days: 30,
    weight_similarity: 0.45,
    weight_recency: 0.2,
    weight_importance: 0.2,
    weight_access: 0.15,
    evolution_enabled: true,
    evolution_max_neighbors: 5,
    evolution_link_threshold: 0.6,
    reflection_enabled: true,
    reflection_interval_hours: 24,
    reflection_min_episodes: 10,
    signal_delay_ms: 300000,
    signal_no_response_timeout_ms: 1800000,
    ...overrides,
  };
}

function makeEpisode(overrides: Partial<InteractionEpisode> = {}): InteractionEpisode {
  return {
    episode_id: "ep-test-1",
    owner: "test-owner",
    source: "slack",
    source_ref: { channel_id: "C123", thread_ts: "111.222" },
    user_message: "I prefer TypeScript strict mode for all projects",
    routed_action: "chat",
    action_args_summary: "{}",
    response_summary: "Noted your preference for TypeScript strict mode.",
    signals: [],
    timestamp: new Date("2025-03-15T10:00:00Z"),
    extraction_status: "pending",
    extracted_memory_ids: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("factExtractor", () => {
  describe("shouldExtract", () => {
    const config = makeConfig();

    it("returns false for skip actions (no_op)", () => {
      const episode = makeEpisode({ routed_action: "no_op" });
      expect(shouldExtract(episode, config)).toBe(false);
    });

    it("returns false for short messages (< 10 chars)", () => {
      const episode = makeEpisode({ user_message: "hi" });
      expect(shouldExtract(episode, config)).toBe(false);
    });

    it("returns false for mechanical actions without signals", () => {
      const episode = makeEpisode({ routed_action: "job_status" });
      expect(shouldExtract(episode, config)).toBe(false);
    });

    it("returns true for mechanical actions with correction signal", () => {
      const episode = makeEpisode({
        routed_action: "job_status",
        signals: [{ signal_type: "correction", detected_at: new Date(), strength: -0.6 }],
      });
      expect(shouldExtract(episode, config)).toBe(true);
    });

    it("returns true for mechanical actions with gratitude signal", () => {
      const episode = makeEpisode({
        routed_action: "list_jobs",
        signals: [{ signal_type: "gratitude", detected_at: new Date(), strength: 0.8 }],
      });
      expect(shouldExtract(episode, config)).toBe(true);
    });

    it("returns true for chat action", () => {
      const episode = makeEpisode({ routed_action: "chat" });
      expect(shouldExtract(episode, config)).toBe(true);
    });

    it("returns true for kb_search action", () => {
      const episode = makeEpisode({ routed_action: "kb_search" });
      expect(shouldExtract(episode, config)).toBe(true);
    });

    it("returns true for create_job action", () => {
      const episode = makeEpisode({ routed_action: "create_job" });
      expect(shouldExtract(episode, config)).toBe(true);
    });

    it("returns true for github action", () => {
      const episode = makeEpisode({ routed_action: "github" });
      expect(shouldExtract(episode, config)).toBe(true);
    });

    it("returns true for unknown actions with sufficient message length", () => {
      const episode = makeEpisode({ routed_action: "some_other_action" });
      expect(shouldExtract(episode, config)).toBe(true);
    });

    it("respects custom extraction_skip_actions", () => {
      const customConfig = makeConfig({ extraction_skip_actions: ["no_op", "chat"] });
      const episode = makeEpisode({ routed_action: "chat" });
      expect(shouldExtract(episode, customConfig)).toBe(false);
    });
  });

  describe("extractFactsFromEpisode", () => {
    const config = makeConfig();

    it("returns zeros when episode not found", async () => {
      mockFindEpisode.mockResolvedValue(null);
      const result = await extractFactsFromEpisode("non-existent", config);
      expect(result).toEqual({ extracted: 0, added: 0, updated: 0, deleted: 0, skipped: 0 });
    });

    it("skips episode that fails extraction filter", async () => {
      mockFindEpisode.mockResolvedValue(makeEpisode({ routed_action: "no_op" }));
      mockUpdateExtractionStatus.mockResolvedValue(null);

      const result = await extractFactsFromEpisode("ep-1", config);
      expect(result).toEqual({ extracted: 0, added: 0, updated: 0, deleted: 0, skipped: 0 });
      expect(mockUpdateExtractionStatus).toHaveBeenCalledWith("ep-1", "skipped");
    });

    it("executes ADD operations from LLM response", async () => {
      const episode = makeEpisode();
      mockFindEpisode.mockResolvedValue(episode);
      mockListEpisodes.mockResolvedValue({ episodes: [], total: 0 });
      mockSearchMemoryTable.mockResolvedValue([]);
      mockInsertMemory.mockResolvedValue({} as any);
      mockAddToMemoryTable.mockResolvedValue(undefined);
      mockUpdateExtractionStatus.mockResolvedValue(null);

      const llmResponse = {
        operations: [
          {
            content: "User prefers TypeScript strict mode",
            importance: 0.5,
            keywords: ["typescript", "strict"],
            tags: ["code_style"],
            operation: "ADD",
            target_memory_id: null,
            updated_content: null,
            reason: "New preference discovered",
          },
        ],
      };

      mockCreateMemoryLLMClient.mockReturnValue({
        chat: vi.fn().mockResolvedValue({
          content: JSON.stringify(llmResponse),
          model: "gpt-4.1-mini",
          prompt_tokens: 100,
          completion_tokens: 50,
          duration_ms: 500,
          tool_calls: [],
        }),
        chatWithTools: vi.fn(),
        toAuditRecord: vi.fn(),
        config: {} as any,
      });

      const result = await extractFactsFromEpisode("ep-test-1", config);
      expect(result.extracted).toBe(1);
      expect(result.added).toBe(1);
      expect(mockInsertMemory).toHaveBeenCalled();
      expect(mockUpdateExtractionStatus).toHaveBeenCalledWith(
        "ep-test-1",
        "extracted",
        expect.any(Array),
      );
    });

    it("executes UPDATE operations from LLM response", async () => {
      const episode = makeEpisode();
      mockFindEpisode.mockResolvedValue(episode);
      mockListEpisodes.mockResolvedValue({ episodes: [], total: 0 });
      mockSearchMemoryTable.mockResolvedValue([]);
      mockFindMemory.mockResolvedValue(makeEpisode() as any); // Mock finding target memory
      mockUpdateMemory.mockResolvedValue({} as any);
      mockUpdateExtractionStatus.mockResolvedValue(null);

      // Need findMemory to return a proper MemoryNote for the UPDATE target
      const existingMemory = {
        memory_id: "existing-mem",
        owner: "test-owner",
        memory_type: "fact",
        content: "Old content",
        context: "Old context",
        keywords: ["old"],
        tags: ["old_tag"],
        source_episodes: ["ep-0"],
        source_type: "slack",
        created_at: new Date(),
        updated_at: new Date(),
        valid_from: new Date(),
        linked_memory_ids: [],
        link_reasons: [],
        access_count: 1,
        importance: 0.3,
        confidence: 0.8,
        embedding_text: "Old content",
      };
      mockFindMemory.mockResolvedValue(existingMemory as any);

      const llmResponse = {
        operations: [
          {
            content: "Updated content",
            importance: 0.7,
            keywords: ["updated"],
            tags: ["new_tag"],
            operation: "UPDATE",
            target_memory_id: "existing-mem",
            updated_content: "Refined content about strict mode",
            reason: "Refining existing memory",
          },
        ],
      };

      mockCreateMemoryLLMClient.mockReturnValue({
        chat: vi.fn().mockResolvedValue({
          content: JSON.stringify(llmResponse),
          model: "gpt-4.1-mini",
          prompt_tokens: 100,
          completion_tokens: 50,
          duration_ms: 500,
          tool_calls: [],
        }),
        chatWithTools: vi.fn(),
        toAuditRecord: vi.fn(),
        config: {} as any,
      });

      const result = await extractFactsFromEpisode("ep-test-1", config);
      expect(result.extracted).toBe(1);
      expect(result.updated).toBe(1);
      expect(mockUpdateMemory).toHaveBeenCalled();
    });

    it("executes DELETE operations from LLM response", async () => {
      const episode = makeEpisode();
      mockFindEpisode.mockResolvedValue(episode);
      mockListEpisodes.mockResolvedValue({ episodes: [], total: 0 });
      mockSearchMemoryTable.mockResolvedValue([]);
      mockInvalidateMemory.mockResolvedValue({} as any);
      mockUpdateExtractionStatus.mockResolvedValue(null);

      const llmResponse = {
        operations: [
          {
            content: "Contradicting fact",
            importance: 0.5,
            keywords: [],
            tags: [],
            operation: "DELETE",
            target_memory_id: "old-mem",
            updated_content: null,
            reason: "Contradicts new information",
          },
        ],
      };

      mockCreateMemoryLLMClient.mockReturnValue({
        chat: vi.fn().mockResolvedValue({
          content: JSON.stringify(llmResponse),
          model: "gpt-4.1-mini",
          prompt_tokens: 100,
          completion_tokens: 50,
          duration_ms: 500,
          tool_calls: [],
        }),
        chatWithTools: vi.fn(),
        toAuditRecord: vi.fn(),
        config: {} as any,
      });

      const result = await extractFactsFromEpisode("ep-test-1", config);
      expect(result.extracted).toBe(1);
      expect(result.deleted).toBe(1);
      expect(mockInvalidateMemory).toHaveBeenCalledWith("old-mem");
    });

    it("handles NOOP operations", async () => {
      const episode = makeEpisode();
      mockFindEpisode.mockResolvedValue(episode);
      mockListEpisodes.mockResolvedValue({ episodes: [], total: 0 });
      mockSearchMemoryTable.mockResolvedValue([]);
      mockUpdateExtractionStatus.mockResolvedValue(null);

      const llmResponse = {
        operations: [
          {
            content: "Already known fact",
            importance: 0.5,
            keywords: [],
            tags: [],
            operation: "NOOP",
            target_memory_id: null,
            updated_content: null,
            reason: "Already stored",
          },
        ],
      };

      mockCreateMemoryLLMClient.mockReturnValue({
        chat: vi.fn().mockResolvedValue({
          content: JSON.stringify(llmResponse),
          model: "gpt-4.1-mini",
          prompt_tokens: 100,
          completion_tokens: 50,
          duration_ms: 500,
          tool_calls: [],
        }),
        chatWithTools: vi.fn(),
        toAuditRecord: vi.fn(),
        config: {} as any,
      });

      const result = await extractFactsFromEpisode("ep-test-1", config);
      expect(result.extracted).toBe(1);
      expect(result.skipped).toBe(1);
    });

    it("handles mixed operations", async () => {
      const episode = makeEpisode();
      mockFindEpisode.mockResolvedValue(episode);
      mockListEpisodes.mockResolvedValue({ episodes: [], total: 0 });
      mockSearchMemoryTable.mockResolvedValue([]);
      mockInsertMemory.mockResolvedValue({} as any);
      mockInvalidateMemory.mockResolvedValue({} as any);
      mockUpdateExtractionStatus.mockResolvedValue(null);

      const llmResponse = {
        operations: [
          {
            content: "New fact",
            importance: 0.5,
            keywords: ["new"],
            tags: ["tag"],
            operation: "ADD",
            target_memory_id: null,
            updated_content: null,
            reason: "new",
          },
          {
            content: "Known fact",
            importance: 0.3,
            keywords: [],
            tags: [],
            operation: "NOOP",
            target_memory_id: null,
            updated_content: null,
            reason: "known",
          },
          {
            content: "Old fact",
            importance: 0.5,
            keywords: [],
            tags: [],
            operation: "DELETE",
            target_memory_id: "old-mem",
            updated_content: null,
            reason: "outdated",
          },
        ],
      };

      mockCreateMemoryLLMClient.mockReturnValue({
        chat: vi.fn().mockResolvedValue({
          content: JSON.stringify(llmResponse),
          model: "gpt-4.1-mini",
          prompt_tokens: 100,
          completion_tokens: 50,
          duration_ms: 500,
          tool_calls: [],
        }),
        chatWithTools: vi.fn(),
        toAuditRecord: vi.fn(),
        config: {} as any,
      });

      const result = await extractFactsFromEpisode("ep-test-1", config);
      expect(result.extracted).toBe(3);
      expect(result.added).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.deleted).toBe(1);
    });

    it("handles empty LLM response gracefully", async () => {
      const episode = makeEpisode();
      mockFindEpisode.mockResolvedValue(episode);
      mockListEpisodes.mockResolvedValue({ episodes: [], total: 0 });
      mockSearchMemoryTable.mockResolvedValue([]);
      mockUpdateExtractionStatus.mockResolvedValue(null);

      mockCreateMemoryLLMClient.mockReturnValue({
        chat: vi.fn().mockResolvedValue({
          content: JSON.stringify({ operations: [] }),
          model: "gpt-4.1-mini",
          prompt_tokens: 50,
          completion_tokens: 10,
          duration_ms: 200,
          tool_calls: [],
        }),
        chatWithTools: vi.fn(),
        toAuditRecord: vi.fn(),
        config: {} as any,
      });

      const result = await extractFactsFromEpisode("ep-test-1", config);
      expect(result.extracted).toBe(0);
      expect(mockUpdateExtractionStatus).toHaveBeenCalledWith("ep-test-1", "extracted", []);
    });

    it("handles LLM error gracefully", async () => {
      const episode = makeEpisode();
      mockFindEpisode.mockResolvedValue(episode);
      mockListEpisodes.mockResolvedValue({ episodes: [], total: 0 });
      mockSearchMemoryTable.mockResolvedValue([]);
      mockUpdateExtractionStatus.mockResolvedValue(null);

      mockCreateMemoryLLMClient.mockReturnValue({
        chat: vi.fn().mockRejectedValue(new Error("LLM API error")),
        chatWithTools: vi.fn(),
        toAuditRecord: vi.fn(),
        config: {} as any,
      });

      const result = await extractFactsFromEpisode("ep-test-1", config);
      expect(result.extracted).toBe(0);
    });

    it("triggers evolveMemory after ADD", async () => {
      const episode = makeEpisode();
      mockFindEpisode.mockResolvedValue(episode);
      mockListEpisodes.mockResolvedValue({ episodes: [], total: 0 });
      mockSearchMemoryTable.mockResolvedValue([]);
      mockInsertMemory.mockResolvedValue({} as any);
      mockAddToMemoryTable.mockResolvedValue(undefined);
      mockUpdateExtractionStatus.mockResolvedValue(null);

      const llmResponse = {
        operations: [
          {
            content: "New fact",
            importance: 0.5,
            keywords: ["k1"],
            tags: ["t1"],
            operation: "ADD",
            target_memory_id: null,
            updated_content: null,
            reason: "new",
          },
        ],
      };

      mockCreateMemoryLLMClient.mockReturnValue({
        chat: vi.fn().mockResolvedValue({
          content: JSON.stringify(llmResponse),
          model: "gpt-4.1-mini",
          prompt_tokens: 100,
          completion_tokens: 50,
          duration_ms: 500,
          tool_calls: [],
        }),
        chatWithTools: vi.fn(),
        toAuditRecord: vi.fn(),
        config: {} as any,
      });

      await extractFactsFromEpisode("ep-test-1", config);

      // evolveMemory should have been called (fire-and-forget)
      // Give it a tick to resolve the promise
      await new Promise((r) => setTimeout(r, 10));
      expect(mockEvolveMemory).toHaveBeenCalled();
    });
  });
});
