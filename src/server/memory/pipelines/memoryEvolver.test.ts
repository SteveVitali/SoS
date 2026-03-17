import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryConfig, MemoryNote } from "../../../shared/memoryTypes.js";

// Mock all external dependencies
vi.mock("../memoryRepo.js", () => ({
  findMemory: vi.fn(),
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

import { createResearchLLMClient } from "../../kb/research/llmClient.js";
import { addToMemoryFTS, deleteFromMemoryFTS } from "../memoryFtsStore.js";
import { findMemory, updateMemory } from "../memoryRepo.js";
import { addToMemoryTable, searchMemoryTable } from "../memoryVectorStore.js";
import { evolveMemory } from "./memoryEvolver.js";

const mockFindMemory = vi.mocked(findMemory);
const mockUpdateMemory = vi.mocked(updateMemory);
const mockSearchMemoryTable = vi.mocked(searchMemoryTable);
const mockAddToMemoryTable = vi.mocked(addToMemoryTable);
const mockAddToMemoryFTS = vi.mocked(addToMemoryFTS);
const mockDeleteFromMemoryFTS = vi.mocked(deleteFromMemoryFTS);
const mockCreateLLMClient = vi.mocked(createResearchLLMClient);

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

function makeMemory(overrides: Partial<MemoryNote> = {}): MemoryNote {
  const now = new Date();
  return {
    memory_id: `mem-${Math.random().toString(36).slice(2, 8)}`,
    owner: "test-owner",
    memory_type: "fact",
    content: "Test memory content",
    context: "Test context",
    keywords: ["test"],
    tags: ["test_tag"],
    source_episodes: ["ep-1"],
    source_type: "slack",
    created_at: now,
    updated_at: now,
    valid_from: now,
    linked_memory_ids: [],
    link_reasons: [],
    access_count: 0,
    importance: 0.5,
    confidence: 0.8,
    embedding_text: "Test memory content Test context test",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("memoryEvolver", () => {
  describe("evolveMemory", () => {
    it("returns zeros when evolution is disabled", async () => {
      const config = makeConfig({ evolution_enabled: false });
      const result = await evolveMemory("mem-1", config);
      expect(result).toEqual({ links_created: 0, neighbors_evolved: 0 });
    });

    it("returns zeros when memory not found", async () => {
      mockFindMemory.mockResolvedValue(null);
      const result = await evolveMemory("non-existent", makeConfig());
      expect(result).toEqual({ links_created: 0, neighbors_evolved: 0 });
    });

    it("returns zeros when no qualifying neighbors found", async () => {
      const memory = makeMemory({ memory_id: "mem-target" });
      mockFindMemory.mockResolvedValue(memory);
      mockSearchMemoryTable.mockResolvedValue([]);

      const result = await evolveMemory("mem-target", makeConfig());
      expect(result).toEqual({ links_created: 0, neighbors_evolved: 0 });
    });

    it("returns zeros when all neighbors are below threshold", async () => {
      const memory = makeMemory({ memory_id: "mem-target" });
      mockFindMemory.mockResolvedValueOnce(memory); // For the target

      // Return a neighbor with very high distance (low similarity)
      mockSearchMemoryTable.mockResolvedValue([
        {
          id: "mem-neighbor",
          owner: "test-owner",
          content: "neighbor content",
          memory_type: "fact",
          tags: "[]",
          importance: 0.5,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          _distance: 10, // Very far → similarity = 1/(1+10) ≈ 0.09
        },
      ]);

      const result = await evolveMemory("mem-target", makeConfig());
      expect(result).toEqual({ links_created: 0, neighbors_evolved: 0 });
    });

    it("creates bidirectional links for near-duplicate neighbors (sim > 0.9)", async () => {
      const memory = makeMemory({ memory_id: "mem-target" });
      const neighbor = makeMemory({ memory_id: "mem-neighbor" });

      // First call: target memory; subsequent: neighbor lookups
      mockFindMemory.mockResolvedValueOnce(memory);
      mockFindMemory.mockResolvedValueOnce(neighbor);

      // Near-duplicate: distance = 0.05 → similarity = 1/(1+0.05) ≈ 0.952
      mockSearchMemoryTable.mockResolvedValue([
        {
          id: "mem-neighbor",
          owner: "test-owner",
          content: "near-duplicate content",
          memory_type: "fact",
          tags: "[]",
          importance: 0.5,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          _distance: 0.05,
        },
      ]);

      mockUpdateMemory.mockResolvedValue({} as any);

      const result = await evolveMemory("mem-target", makeConfig());

      expect(result.links_created).toBe(1);
      // Should have updated both the target and the neighbor with links
      expect(mockUpdateMemory).toHaveBeenCalledTimes(2);
    });

    it("calls LLM for neighbors that are not near-duplicates", async () => {
      const memory = makeMemory({ memory_id: "mem-target" });
      const neighbor = makeMemory({ memory_id: "mem-neighbor" });

      mockFindMemory.mockResolvedValueOnce(memory);
      mockFindMemory.mockResolvedValueOnce(neighbor);

      // Similar but not near-duplicate: distance = 0.4 → sim = 1/(1.4) ≈ 0.71
      mockSearchMemoryTable.mockResolvedValue([
        {
          id: "mem-neighbor",
          owner: "test-owner",
          content: "related content",
          memory_type: "fact",
          tags: "[]",
          importance: 0.5,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          _distance: 0.4,
        },
      ]);

      const llmDecisions = {
        decisions: [
          {
            memory_id: "mem-neighbor",
            create_link: true,
            link_reason: "Both about TypeScript",
            update_context: null,
            update_keywords: null,
            update_tags: null,
          },
        ],
      };

      mockCreateLLMClient.mockReturnValue({
        chat: vi.fn().mockResolvedValue({
          content: JSON.stringify(llmDecisions),
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

      mockUpdateMemory.mockResolvedValue({} as any);

      const result = await evolveMemory("mem-target", makeConfig());
      expect(result.links_created).toBe(1);
    });

    it("evolves neighbor content when LLM suggests updates", async () => {
      const memory = makeMemory({ memory_id: "mem-target" });
      const neighbor = makeMemory({
        memory_id: "mem-neighbor",
        content: "Old neighbor content",
        context: "Old context",
        keywords: ["old"],
        tags: ["old_tag"],
      });

      mockFindMemory.mockResolvedValueOnce(memory);
      mockFindMemory.mockResolvedValueOnce(neighbor);

      mockSearchMemoryTable.mockResolvedValue([
        {
          id: "mem-neighbor",
          owner: "test-owner",
          content: "related content",
          memory_type: "fact",
          tags: "[]",
          importance: 0.5,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          _distance: 0.4,
        },
      ]);

      const llmDecisions = {
        decisions: [
          {
            memory_id: "mem-neighbor",
            create_link: true,
            link_reason: "Related topics",
            update_context: "Updated context with new info",
            update_keywords: ["updated", "keywords"],
            update_tags: ["updated_tag"],
          },
        ],
      };

      mockCreateLLMClient.mockReturnValue({
        chat: vi.fn().mockResolvedValue({
          content: JSON.stringify(llmDecisions),
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

      mockUpdateMemory.mockResolvedValue({} as any);
      mockAddToMemoryTable.mockResolvedValue(undefined);

      const result = await evolveMemory("mem-target", makeConfig());
      expect(result.links_created).toBe(1);
      expect(result.neighbors_evolved).toBe(1);

      // Should have called updateMemory for the neighbor evolution
      // (link updates + content updates)
      expect(mockUpdateMemory).toHaveBeenCalled();
      expect(mockAddToMemoryTable).toHaveBeenCalled();
      expect(mockDeleteFromMemoryFTS).toHaveBeenCalled();
      expect(mockAddToMemoryFTS).toHaveBeenCalled();
    });

    it("skips already-linked neighbors", async () => {
      const memory = makeMemory({
        memory_id: "mem-target",
        linked_memory_ids: ["mem-neighbor"],
        link_reasons: ["existing link"],
      });
      const neighbor = makeMemory({ memory_id: "mem-neighbor" });

      mockFindMemory.mockResolvedValueOnce(memory);
      mockFindMemory.mockResolvedValueOnce(neighbor);

      // Near-duplicate so we skip LLM
      mockSearchMemoryTable.mockResolvedValue([
        {
          id: "mem-neighbor",
          owner: "test-owner",
          content: "content",
          memory_type: "fact",
          tags: "[]",
          importance: 0.5,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          _distance: 0.05,
        },
      ]);

      const result = await evolveMemory("mem-target", makeConfig());
      // Link already exists, so links_created should be 0
      expect(result.links_created).toBe(0);
    });

    it("handles LLM error gracefully with fallback linking", async () => {
      const memory = makeMemory({ memory_id: "mem-target" });
      const neighbor = makeMemory({ memory_id: "mem-neighbor" });

      mockFindMemory.mockResolvedValueOnce(memory);
      mockFindMemory.mockResolvedValueOnce(neighbor);

      // Moderate similarity (triggers LLM)
      mockSearchMemoryTable.mockResolvedValue([
        {
          id: "mem-neighbor",
          owner: "test-owner",
          content: "content",
          memory_type: "fact",
          tags: "[]",
          importance: 0.5,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          _distance: 0.4,
        },
      ]);

      mockCreateLLMClient.mockReturnValue({
        chat: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
        chatWithTools: vi.fn(),
        toAuditRecord: vi.fn(),
        config: {} as any,
      });

      mockUpdateMemory.mockResolvedValue({} as any);

      const result = await evolveMemory("mem-target", makeConfig());
      // Should fall back to linking without evolution
      expect(result.links_created).toBe(1);
      expect(result.neighbors_evolved).toBe(0);
    });

    it("skips invalidated neighbors", async () => {
      const memory = makeMemory({ memory_id: "mem-target" });
      const invalidatedNeighbor = makeMemory({
        memory_id: "mem-neighbor",
        invalidated_at: new Date(),
      });

      mockFindMemory.mockResolvedValueOnce(memory);
      mockFindMemory.mockResolvedValueOnce(invalidatedNeighbor);

      mockSearchMemoryTable.mockResolvedValue([
        {
          id: "mem-neighbor",
          owner: "test-owner",
          content: "content",
          memory_type: "fact",
          tags: "[]",
          importance: 0.5,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          _distance: 0.05,
        },
      ]);

      const result = await evolveMemory("mem-target", makeConfig());
      expect(result.links_created).toBe(0);
    });

    it("filters out self from neighbor results", async () => {
      const memory = makeMemory({ memory_id: "mem-target" });

      mockFindMemory.mockResolvedValueOnce(memory);

      // Only result is self
      mockSearchMemoryTable.mockResolvedValue([
        {
          id: "mem-target",
          owner: "test-owner",
          content: "self",
          memory_type: "fact",
          tags: "[]",
          importance: 0.5,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          _distance: 0,
        },
      ]);

      const result = await evolveMemory("mem-target", makeConfig());
      expect(result).toEqual({ links_created: 0, neighbors_evolved: 0 });
    });
  });
});
