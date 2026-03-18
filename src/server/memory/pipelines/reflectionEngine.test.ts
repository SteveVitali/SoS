import { afterEach, describe, expect, it, vi } from "vitest";
import type { InteractionEpisode, MemoryConfig, MemoryNote } from "../../../shared/memoryTypes.js";

// Mock all external dependencies
vi.mock("../episodeRepo.js", () => ({
  listEpisodes: vi.fn(),
}));

vi.mock("../memoryRepo.js", () => ({
  findMemory: vi.fn(),
  insertMemory: vi.fn(),
  listMemories: vi.fn(),
  updateMemory: vi.fn(),
}));

vi.mock("../memoryVectorStore.js", () => ({
  addToMemoryTable: vi.fn(),
}));

vi.mock("../memoryFtsStore.js", () => ({
  addToMemoryFTS: vi.fn(),
  deleteFromMemoryFTS: vi.fn(),
}));

vi.mock("../../kb/embeddings.js", () => ({
  getEmbeddingProvider: vi.fn(() => ({
    embed: vi.fn().mockImplementation((texts: string[]) => {
      // Return deterministic embeddings based on text content
      return Promise.resolve(
        texts.map((t) => {
          // Simple hash-based embedding for testing
          const hash = t.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
          return [Math.sin(hash), Math.cos(hash), Math.sin(hash * 2)];
        }),
      );
    }),
    dimensions: 3,
    modelName: "test-model",
  })),
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

vi.mock("../memorySearch.js", () => ({
  searchMemories: vi.fn().mockResolvedValue([]),
}));

import { listEpisodes } from "../episodeRepo.js";
import { addToMemoryFTS, deleteFromMemoryFTS } from "../memoryFtsStore.js";
import { findMemory, insertMemory, listMemories, updateMemory } from "../memoryRepo.js";
import { searchMemories } from "../memorySearch.js";
import { createMemoryLLMClient } from "../memoryUtils.js";
import { addToMemoryTable } from "../memoryVectorStore.js";
import {
  clusterEpisodes,
  computeCentroid,
  getLastReflectionTimestamp,
  runReflection,
} from "./reflectionEngine.js";
import { cosineSimilarity } from "./signalCollector.js";

const mockListEpisodes = vi.mocked(listEpisodes);
const mockFindMemory = vi.mocked(findMemory);
const mockInsertMemory = vi.mocked(insertMemory);
const mockListMemories = vi.mocked(listMemories);
const mockUpdateMemory = vi.mocked(updateMemory);
const mockAddToMemoryTable = vi.mocked(addToMemoryTable);
const mockAddToMemoryFTS = vi.mocked(addToMemoryFTS);
const mockDeleteFromMemoryFTS = vi.mocked(deleteFromMemoryFTS);
const mockCreateMemoryLLMClient = vi.mocked(createMemoryLLMClient);
const mockSearchMemories = vi.mocked(searchMemories);

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
    reflection_min_episodes: 3,
    signal_delay_ms: 300000,
    signal_no_response_timeout_ms: 1800000,
    ...overrides,
  };
}

function makeEpisode(overrides: Partial<InteractionEpisode> = {}): InteractionEpisode {
  return {
    episode_id: `ep-${Math.random().toString(36).slice(2, 8)}`,
    owner: "test-owner",
    source: "slack",
    source_ref: { channel_id: "C123" },
    user_message: "How do I configure TypeScript strict mode?",
    routed_action: "chat",
    action_args_summary: "{}",
    response_summary: "You can enable it in tsconfig.json.",
    signals: [],
    timestamp: new Date("2025-03-15T10:00:00Z"),
    extraction_status: "extracted",
    extracted_memory_ids: [],
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

describe("reflectionEngine", () => {
  describe("computeCentroid", () => {
    it("computes the mean of embeddings", () => {
      const centroid = computeCentroid([
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ]);
      expect(centroid[0]).toBeCloseTo(1 / 3);
      expect(centroid[1]).toBeCloseTo(1 / 3);
      expect(centroid[2]).toBeCloseTo(1 / 3);
    });

    it("returns empty array for empty input", () => {
      expect(computeCentroid([])).toEqual([]);
    });

    it("returns the vector itself for single input", () => {
      const centroid = computeCentroid([[0.5, 0.3, 0.2]]);
      expect(centroid[0]).toBeCloseTo(0.5);
      expect(centroid[1]).toBeCloseTo(0.3);
      expect(centroid[2]).toBeCloseTo(0.2);
    });
  });

  describe("clusterEpisodes", () => {
    it("groups similar episodes into the same cluster", () => {
      const episodes = [
        makeEpisode({ user_message: "TypeScript config" }),
        makeEpisode({ user_message: "TypeScript config again" }),
        makeEpisode({ user_message: "TypeScript config more" }),
      ];

      // All identical embeddings → should be one cluster
      const embeddings = [
        [1, 0, 0],
        [0.95, 0.05, 0],
        [0.9, 0.1, 0],
      ];

      const clusters = clusterEpisodes(episodes, embeddings, 0.6);
      expect(clusters.length).toBe(1);
      expect(clusters[0].episodes.length).toBe(3);
    });

    it("separates dissimilar episodes into different clusters", () => {
      const episodes = [
        makeEpisode({ user_message: "TypeScript config" }),
        makeEpisode({ user_message: "Python setup" }),
        makeEpisode({ user_message: "Restaurant recommendations" }),
      ];

      // Very different embeddings → should be separate clusters
      const embeddings = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ];

      const clusters = clusterEpisodes(episodes, embeddings, 0.6);
      expect(clusters.length).toBe(3);
      expect(clusters[0].episodes.length).toBe(1);
      expect(clusters[1].episodes.length).toBe(1);
      expect(clusters[2].episodes.length).toBe(1);
    });

    it("handles empty input", () => {
      const clusters = clusterEpisodes([], [], 0.6);
      expect(clusters).toEqual([]);
    });

    it("respects the similarity threshold", () => {
      const episodes = [makeEpisode({ user_message: "A" }), makeEpisode({ user_message: "B" })];

      const embeddings = [
        [1, 0, 0],
        [0.8, 0.6, 0], // similarity ≈ 0.8
      ];

      // With low threshold → same cluster
      const clustersLow = clusterEpisodes(episodes, embeddings, 0.5);
      expect(clustersLow.length).toBe(1);

      // With very high threshold → separate clusters
      const clustersHigh = clusterEpisodes(episodes, embeddings, 0.99);
      expect(clustersHigh.length).toBe(2);
    });
  });

  describe("getLastReflectionTimestamp", () => {
    it("returns null when no reflection metadata exists", async () => {
      mockFindMemory.mockResolvedValue(null);
      const result = await getLastReflectionTimestamp("test-owner");
      expect(result).toBeNull();
    });

    it("returns the updated_at of the metadata document", async () => {
      const date = new Date("2025-03-15T10:00:00Z");
      mockFindMemory.mockResolvedValue(
        makeMemory({
          memory_id: "__reflection_meta__test-owner",
          updated_at: date,
        }),
      );

      const result = await getLastReflectionTimestamp("test-owner");
      expect(result).toEqual(date);
    });
  });

  describe("runReflection", () => {
    it("returns zeros when reflection is disabled", async () => {
      const config = makeConfig({ reflection_enabled: false });
      const result = await runReflection("test-owner", config);
      expect(result).toEqual({
        episodes_reviewed: 0,
        clusters_found: 0,
        reflections_created: 0,
        profile_updated: false,
      });
    });

    it("skips when not enough episodes", async () => {
      mockFindMemory.mockResolvedValue(null); // No last reflection
      mockListEpisodes.mockResolvedValue({
        episodes: [makeEpisode(), makeEpisode()], // Only 2 episodes
        total: 2,
      });

      const config = makeConfig({ reflection_min_episodes: 3 });
      const result = await runReflection("test-owner", config);

      expect(result.episodes_reviewed).toBe(2);
      expect(result.reflections_created).toBe(0);
    });

    it("generates reflections for clusters of >= 3 episodes", async () => {
      mockFindMemory.mockResolvedValue(null); // No last reflection, no reflection meta

      // 4 similar episodes → should form 1 cluster
      const episodes = [
        makeEpisode({ episode_id: "ep-1", user_message: "TypeScript strict mode" }),
        makeEpisode({ episode_id: "ep-2", user_message: "TypeScript strict config" }),
        makeEpisode({ episode_id: "ep-3", user_message: "TypeScript strict settings" }),
        makeEpisode({ episode_id: "ep-4", user_message: "TypeScript strict options" }),
      ];

      mockListEpisodes.mockResolvedValue({ episodes, total: 4 });
      mockSearchMemories.mockResolvedValue([]);

      // Mock LLM for reflection
      const reflectionResponse = {
        reflections: [
          {
            content: "User frequently asks about TypeScript strict mode configuration",
            importance: 0.7,
            keywords: ["typescript", "strict_mode", "configuration"],
            tags: ["pattern", "typescript"],
          },
        ],
      };

      // Mock LLM for profile synthesis
      const profileResponse = "This user is primarily interested in TypeScript configuration.";

      mockCreateMemoryLLMClient.mockReturnValue({
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: JSON.stringify(reflectionResponse),
            model: "gpt-4.1-mini",
            prompt_tokens: 200,
            completion_tokens: 100,
            duration_ms: 800,
            tool_calls: [],
          })
          .mockResolvedValueOnce({
            content: profileResponse,
            model: "gpt-4.1-mini",
            prompt_tokens: 200,
            completion_tokens: 100,
            duration_ms: 800,
            tool_calls: [],
          }),
        chatWithTools: vi.fn(),
        toAuditRecord: vi.fn(),
        config: {} as any,
      });

      mockInsertMemory.mockResolvedValue({} as any);
      mockAddToMemoryTable.mockResolvedValue(undefined);
      mockUpdateMemory.mockResolvedValue({} as any);

      // Mock listMemories for fact/reflection gathering + profile lookup
      mockListMemories
        .mockResolvedValueOnce({ memories: [makeMemory()], total: 1 }) // facts
        .mockResolvedValueOnce({ memories: [], total: 0 }) // reflections
        .mockResolvedValueOnce({ memories: [], total: 0 }); // existing profiles

      const config = makeConfig({ reflection_min_episodes: 3 });
      const result = await runReflection("test-owner", config);

      expect(result.episodes_reviewed).toBe(4);
      expect(result.clusters_found).toBeGreaterThanOrEqual(1);
      expect(result.reflections_created).toBeGreaterThanOrEqual(1);
      expect(mockInsertMemory).toHaveBeenCalled();
    });

    it("updates existing user profile instead of creating new one", async () => {
      mockFindMemory.mockResolvedValue(null);

      // Use identical messages to guarantee clustering together
      const episodes = [
        makeEpisode({ episode_id: "ep-1", user_message: "TypeScript strict mode config" }),
        makeEpisode({ episode_id: "ep-2", user_message: "TypeScript strict mode config" }),
        makeEpisode({ episode_id: "ep-3", user_message: "TypeScript strict mode config" }),
      ];

      mockListEpisodes.mockResolvedValue({ episodes, total: 3 });
      mockSearchMemories.mockResolvedValue([]);

      const reflectionResponse = {
        reflections: [
          {
            content: "Pattern observed",
            importance: 0.6,
            keywords: ["pattern"],
            tags: ["pattern"],
          },
        ],
      };

      const existingProfile = makeMemory({
        memory_id: "profile-existing",
        memory_type: "user_profile",
        content: "Old profile content",
        source_episodes: ["ep-old"],
      });

      // Track call order across multiple createMemoryLLMClient() calls.
      // Each call to createMemoryLLMClient() returns a fresh mock LLM.
      let llmCallIndex = 0;
      const llmResponses = [
        // First LLM call: reflection generation
        {
          content: JSON.stringify(reflectionResponse),
          model: "gpt-4.1-mini",
          prompt_tokens: 100,
          completion_tokens: 50,
          duration_ms: 500,
          tool_calls: [],
        },
        // Second LLM call: profile synthesis
        {
          content: "Updated user profile content",
          model: "gpt-4.1-mini",
          prompt_tokens: 100,
          completion_tokens: 50,
          duration_ms: 500,
          tool_calls: [],
        },
      ];

      mockCreateMemoryLLMClient.mockImplementation(() => ({
        chat: vi.fn().mockImplementation(() => {
          const response = llmResponses[llmCallIndex] ?? llmResponses[llmResponses.length - 1];
          llmCallIndex++;
          return Promise.resolve(response);
        }),
        chatWithTools: vi.fn(),
        toAuditRecord: vi.fn(),
        config: {} as any,
      }));

      mockInsertMemory.mockResolvedValue({} as any);
      mockAddToMemoryTable.mockResolvedValue(undefined);
      mockUpdateMemory.mockResolvedValue({} as any);

      // Mock listMemories calls:
      // 1. facts for profile synthesis
      // 2. reflections for profile synthesis
      // 3. existing user_profile lookup
      mockListMemories
        .mockResolvedValueOnce({ memories: [makeMemory()], total: 1 })
        .mockResolvedValueOnce({ memories: [], total: 0 })
        .mockResolvedValueOnce({ memories: [existingProfile], total: 1 });

      const config = makeConfig({ reflection_min_episodes: 3 });
      const result = await runReflection("test-owner", config);

      expect(result.profile_updated).toBe(true);
      // Should call updateMemory for the existing profile
      expect(mockUpdateMemory).toHaveBeenCalledWith(
        "profile-existing",
        expect.objectContaining({
          content: "Updated user profile content",
        }),
      );
    });

    it("only processes episodes since last reflection", async () => {
      const lastReflectionTime = new Date("2025-03-15T09:00:00Z");
      mockFindMemory.mockResolvedValue(
        makeMemory({
          memory_id: "__reflection_meta__test-owner",
          updated_at: lastReflectionTime,
        }),
      );

      const oldEpisode = makeEpisode({
        episode_id: "ep-old",
        timestamp: new Date("2025-03-15T08:00:00Z"), // Before last reflection
      });
      const newEpisode1 = makeEpisode({
        episode_id: "ep-new-1",
        timestamp: new Date("2025-03-15T10:00:00Z"),
      });
      const newEpisode2 = makeEpisode({
        episode_id: "ep-new-2",
        timestamp: new Date("2025-03-15T11:00:00Z"),
      });

      mockListEpisodes.mockResolvedValue({
        episodes: [newEpisode2, newEpisode1, oldEpisode],
        total: 3,
      });

      const config = makeConfig({ reflection_min_episodes: 3 });
      const result = await runReflection("test-owner", config);

      // Only 2 new episodes → below threshold of 3
      expect(result.episodes_reviewed).toBe(2);
      expect(result.reflections_created).toBe(0);
    });

    it("handles LLM error in reflection gracefully", async () => {
      mockFindMemory.mockResolvedValue(null);

      const episodes = [
        makeEpisode({ episode_id: "ep-1", user_message: "same topic A" }),
        makeEpisode({ episode_id: "ep-2", user_message: "same topic A" }),
        makeEpisode({ episode_id: "ep-3", user_message: "same topic A" }),
      ];

      mockListEpisodes.mockResolvedValue({ episodes, total: 3 });
      mockSearchMemories.mockResolvedValue([]);

      mockCreateMemoryLLMClient.mockReturnValue({
        chat: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
        chatWithTools: vi.fn(),
        toAuditRecord: vi.fn(),
        config: {} as any,
      });

      // Mock listMemories for profile synthesis (which will also fail due to LLM)
      mockListMemories
        .mockResolvedValueOnce({ memories: [], total: 0 })
        .mockResolvedValueOnce({ memories: [], total: 0 })
        .mockResolvedValueOnce({ memories: [], total: 0 });

      mockInsertMemory.mockResolvedValue({} as any);

      const config = makeConfig({ reflection_min_episodes: 3 });
      const result = await runReflection("test-owner", config);

      // Should not crash, reflections_created should be 0
      expect(result.reflections_created).toBe(0);
      expect(result.profile_updated).toBe(false);
    });

    it("skips clusters smaller than 3 episodes", async () => {
      mockFindMemory.mockResolvedValue(null);

      // 4 episodes but in 4 different topics → 4 clusters of 1
      const episodes = [
        makeEpisode({ episode_id: "ep-1", user_message: "Topic A about cats" }),
        makeEpisode({ episode_id: "ep-2", user_message: "Topic B about rockets" }),
        makeEpisode({ episode_id: "ep-3", user_message: "Topic C about cooking" }),
        makeEpisode({ episode_id: "ep-4", user_message: "Topic D about music" }),
      ];

      mockListEpisodes.mockResolvedValue({ episodes, total: 4 });

      mockCreateMemoryLLMClient.mockReturnValue({
        chat: vi.fn().mockResolvedValue({
          content: "No profile needed",
          model: "gpt-4.1-mini",
          prompt_tokens: 50,
          completion_tokens: 20,
          duration_ms: 300,
          tool_calls: [],
        }),
        chatWithTools: vi.fn(),
        toAuditRecord: vi.fn(),
        config: {} as any,
      });

      mockListMemories
        .mockResolvedValueOnce({ memories: [], total: 0 })
        .mockResolvedValueOnce({ memories: [], total: 0 })
        .mockResolvedValueOnce({ memories: [], total: 0 });

      mockInsertMemory.mockResolvedValue({} as any);

      const config = makeConfig({ reflection_min_episodes: 3 });
      const result = await runReflection("test-owner", config);

      expect(result.episodes_reviewed).toBe(4);
      // No clusters of >= 3 should exist (topics are very different)
      expect(result.reflections_created).toBe(0);
    });

    it("records reflection timestamp after completion", async () => {
      mockFindMemory.mockResolvedValue(null);

      const episodes = [
        makeEpisode({ episode_id: "ep-1" }),
        makeEpisode({ episode_id: "ep-2" }),
        makeEpisode({ episode_id: "ep-3" }),
      ];

      mockListEpisodes.mockResolvedValue({ episodes, total: 3 });
      mockSearchMemories.mockResolvedValue([]);

      mockCreateMemoryLLMClient.mockReturnValue({
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: JSON.stringify({ reflections: [] }),
            model: "gpt-4.1-mini",
            prompt_tokens: 100,
            completion_tokens: 20,
            duration_ms: 300,
            tool_calls: [],
          })
          .mockResolvedValueOnce({
            content: "Profile content",
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

      mockInsertMemory.mockResolvedValue({} as any);
      mockAddToMemoryTable.mockResolvedValue(undefined);

      mockListMemories
        .mockResolvedValueOnce({ memories: [makeMemory()], total: 1 })
        .mockResolvedValueOnce({ memories: [], total: 0 })
        .mockResolvedValueOnce({ memories: [], total: 0 });

      const config = makeConfig({ reflection_min_episodes: 3 });
      await runReflection("test-owner", config);

      // Should have called insertMemory for the reflection metadata
      const insertCalls = mockInsertMemory.mock.calls;
      const metaInsert = insertCalls.find(
        (call) => call[0].memory_id === "__reflection_meta__test-owner",
      );
      expect(metaInsert).toBeDefined();
    });
  });
});
