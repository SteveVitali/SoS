import { afterEach, describe, expect, it, vi } from "vitest";
import type { InteractionEpisode, MemoryConfig } from "../../../shared/memoryTypes.js";

// Mock all external dependencies
vi.mock("../episodeRepo.js", () => ({
  listEpisodes: vi.fn(),
  appendSignals: vi.fn(),
}));

vi.mock("../../chat/conversationRepo.js", () => ({
  findConversation: vi.fn(),
}));

vi.mock("../../jobs/jobRepo.js", () => ({
  findJobByTaskId: vi.fn(),
}));

vi.mock("../../kb/embeddings.js", () => ({
  getEmbeddingProvider: vi.fn(() => ({
    embed: vi.fn().mockResolvedValue([
      [1, 0, 0],
      [0, 1, 0],
    ]),
    dimensions: 3,
    modelName: "test-model",
  })),
}));

vi.mock("../memoryUtils.js", () => ({
  distanceToSimilarity: vi.fn((d: number) => 1 / (1 + d)),
}));

import { findConversation } from "../../chat/conversationRepo.js";
import { findJobByTaskId } from "../../jobs/jobRepo.js";
import { getEmbeddingProvider } from "../../kb/embeddings.js";
import { appendSignals, listEpisodes } from "../episodeRepo.js";
import {
  CORRECTION_REGEX,
  collectSignals,
  cosineSimilarity,
  detectEmbeddingSignals,
  detectJobSignals,
  detectSignals,
  findNextUserMessage,
  GRATITUDE_REGEX,
} from "./signalCollector.js";

const mockListEpisodes = vi.mocked(listEpisodes);
const mockAppendSignals = vi.mocked(appendSignals);
const mockFindConversation = vi.mocked(findConversation);
const mockFindJobByTaskId = vi.mocked(findJobByTaskId);
const mockGetEmbeddingProvider = vi.mocked(getEmbeddingProvider);

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
    signal_delay_ms: 300000, // 5 minutes
    signal_no_response_timeout_ms: 1800000, // 30 minutes
    ...overrides,
  };
}

function makeEpisode(overrides: Partial<InteractionEpisode> = {}): InteractionEpisode {
  return {
    episode_id: `ep-${Math.random().toString(36).slice(2, 8)}`,
    owner: "test-owner",
    source: "slack",
    source_ref: { channel_id: "C123", thread_ts: "111.222" },
    user_message: "How do I configure TypeScript strict mode?",
    routed_action: "chat",
    action_args_summary: "{}",
    response_summary: "You can enable it in tsconfig.json by setting strict: true.",
    signals: [],
    timestamp: new Date("2025-03-15T10:00:00Z"),
    extraction_status: "extracted",
    extracted_memory_ids: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("signalCollector", () => {
  describe("GRATITUDE_REGEX", () => {
    it("matches 'thanks'", () => {
      expect(GRATITUDE_REGEX.test("thanks for the help")).toBe(true);
    });

    it("matches 'thank you'", () => {
      expect(GRATITUDE_REGEX.test("thank you so much")).toBe(true);
    });

    it("matches 'perfect'", () => {
      expect(GRATITUDE_REGEX.test("perfect, that works")).toBe(true);
    });

    it("matches 'awesome'", () => {
      expect(GRATITUDE_REGEX.test("awesome!")).toBe(true);
    });

    it("matches case-insensitively", () => {
      expect(GRATITUDE_REGEX.test("THANKS")).toBe(true);
      expect(GRATITUDE_REGEX.test("Great job")).toBe(true);
    });

    it("does not match unrelated text", () => {
      expect(GRATITUDE_REGEX.test("how do I set up TypeScript?")).toBe(false);
    });
  });

  describe("CORRECTION_REGEX", () => {
    it("matches 'no'", () => {
      expect(CORRECTION_REGEX.test("no, that's not right")).toBe(true);
    });

    it("matches 'wrong'", () => {
      expect(CORRECTION_REGEX.test("that's wrong")).toBe(true);
    });

    it("matches 'incorrect'", () => {
      expect(CORRECTION_REGEX.test("that's incorrect")).toBe(true);
    });

    it("matches 'actually'", () => {
      expect(CORRECTION_REGEX.test("actually, I wanted something else")).toBe(true);
    });

    it("matches 'not what I meant'", () => {
      expect(CORRECTION_REGEX.test("that's not what I meant")).toBe(true);
    });

    it("matches case-insensitively", () => {
      expect(CORRECTION_REGEX.test("WRONG answer")).toBe(true);
    });

    it("does not match unrelated text", () => {
      expect(CORRECTION_REGEX.test("please show me the logs")).toBe(false);
    });
  });

  describe("cosineSimilarity", () => {
    it("returns 1 for identical vectors", () => {
      expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
    });

    it("returns 0 for orthogonal vectors", () => {
      expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0);
    });

    it("returns -1 for opposite vectors", () => {
      expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1.0);
    });

    it("returns 0 for empty vectors", () => {
      expect(cosineSimilarity([], [])).toBe(0);
    });

    it("returns 0 for mismatched lengths", () => {
      expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    });
  });

  describe("findNextUserMessage", () => {
    it("finds next user message from web_chat conversations collection", async () => {
      const episode = makeEpisode({
        source: "web_chat",
        source_ref: { conversation_id: "conv-1" },
        timestamp: new Date("2025-03-15T10:00:00Z"),
      });

      mockFindConversation.mockResolvedValue({
        conversation_id: "conv-1",
        owner: "test-owner",
        created_at: new Date(),
        updated_at: new Date(),
        messages: [
          {
            id: "m1",
            role: "user",
            text: "original question",
            at: new Date("2025-03-15T09:59:00Z"),
          },
          { id: "m2", role: "assistant", text: "response", at: new Date("2025-03-15T10:00:00Z") },
          {
            id: "m3",
            role: "user",
            text: "follow-up question",
            at: new Date("2025-03-15T10:01:00Z"),
          },
        ],
        linked_task_ids: [],
      });

      const result = await findNextUserMessage(episode);
      expect(result).not.toBeNull();
      expect(result!.text).toBe("follow-up question");
    });

    it("returns null for web_chat with no follow-up", async () => {
      const episode = makeEpisode({
        source: "web_chat",
        source_ref: { conversation_id: "conv-1" },
        timestamp: new Date("2025-03-15T10:00:00Z"),
      });

      mockFindConversation.mockResolvedValue({
        conversation_id: "conv-1",
        owner: "test-owner",
        created_at: new Date(),
        updated_at: new Date(),
        messages: [
          { id: "m1", role: "user", text: "only message", at: new Date("2025-03-15T09:59:00Z") },
          { id: "m2", role: "assistant", text: "response", at: new Date("2025-03-15T10:00:00Z") },
        ],
        linked_task_ids: [],
      });

      const result = await findNextUserMessage(episode);
      expect(result).toBeNull();
    });

    it("finds next message from Slack episodes by thread_ts", async () => {
      const episode = makeEpisode({
        source: "slack",
        source_ref: { channel_id: "C123", thread_ts: "111.222" },
        timestamp: new Date("2025-03-15T10:00:00Z"),
      });

      const followUpEpisode = makeEpisode({
        episode_id: "ep-follow",
        source: "slack",
        source_ref: { channel_id: "C123", thread_ts: "111.222" },
        user_message: "thanks for that",
        timestamp: new Date("2025-03-15T10:05:00Z"),
      });

      mockListEpisodes.mockResolvedValue({
        episodes: [followUpEpisode, episode],
        total: 2,
      });

      const result = await findNextUserMessage(episode);
      expect(result).not.toBeNull();
      expect(result!.text).toBe("thanks for that");
    });

    it("returns null when no subsequent episodes in same thread", async () => {
      const episode = makeEpisode({
        source: "slack",
        source_ref: { channel_id: "C123", thread_ts: "111.222" },
        timestamp: new Date("2025-03-15T10:00:00Z"),
      });

      mockListEpisodes.mockResolvedValue({ episodes: [episode], total: 1 });

      const result = await findNextUserMessage(episode);
      expect(result).toBeNull();
    });
  });

  describe("detectSignals", () => {
    it("detects gratitude signal", async () => {
      const episode = makeEpisode({
        source: "web_chat",
        source_ref: { conversation_id: "conv-1" },
        timestamp: new Date("2025-03-15T10:00:00Z"),
      });

      mockFindConversation.mockResolvedValue({
        conversation_id: "conv-1",
        owner: "test-owner",
        created_at: new Date(),
        updated_at: new Date(),
        messages: [
          { id: "m1", role: "user", text: "question", at: new Date("2025-03-15T09:59:00Z") },
          { id: "m2", role: "assistant", text: "answer", at: new Date("2025-03-15T10:00:00Z") },
          {
            id: "m3",
            role: "user",
            text: "thanks, that's perfect!",
            at: new Date("2025-03-15T10:01:00Z"),
          },
        ],
        linked_task_ids: [],
      });

      const signals = await detectSignals(episode, makeConfig());

      const gratitude = signals.find((s) => s.signal_type === "gratitude");
      expect(gratitude).toBeDefined();
      expect(gratitude!.strength).toBe(0.8);

      const continuation = signals.find((s) => s.signal_type === "continuation");
      expect(continuation).toBeDefined();
      expect(continuation!.strength).toBe(0.2);
    });

    it("detects correction signal with details", async () => {
      const episode = makeEpisode({
        source: "web_chat",
        source_ref: { conversation_id: "conv-1" },
        timestamp: new Date("2025-03-15T10:00:00Z"),
      });

      mockFindConversation.mockResolvedValue({
        conversation_id: "conv-1",
        owner: "test-owner",
        created_at: new Date(),
        updated_at: new Date(),
        messages: [
          { id: "m1", role: "user", text: "question", at: new Date("2025-03-15T09:59:00Z") },
          { id: "m2", role: "assistant", text: "answer", at: new Date("2025-03-15T10:00:00Z") },
          {
            id: "m3",
            role: "user",
            text: "no, that's not what I meant",
            at: new Date("2025-03-15T10:01:00Z"),
          },
        ],
        linked_task_ids: [],
      });

      const signals = await detectSignals(episode, makeConfig());

      const correction = signals.find((s) => s.signal_type === "correction");
      expect(correction).toBeDefined();
      expect(correction!.strength).toBe(-0.6);
      expect(correction!.details).toContain("not what I meant");
    });

    it("detects no_response signal after timeout", async () => {
      const episode = makeEpisode({
        source: "web_chat",
        source_ref: { conversation_id: "conv-1" },
        // Set timestamp far in the past to exceed the 30min timeout
        timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000),
      });

      mockFindConversation.mockResolvedValue({
        conversation_id: "conv-1",
        owner: "test-owner",
        created_at: new Date(),
        updated_at: new Date(),
        messages: [
          {
            id: "m1",
            role: "user",
            text: "question",
            at: new Date(Date.now() - 2 * 60 * 60 * 1000 - 1000),
          },
          {
            id: "m2",
            role: "assistant",
            text: "answer",
            at: new Date(Date.now() - 2 * 60 * 60 * 1000),
          },
        ],
        linked_task_ids: [],
      });

      const config = makeConfig({ signal_no_response_timeout_ms: 1800000 });
      const signals = await detectSignals(episode, config);

      const noResponse = signals.find((s) => s.signal_type === "no_response");
      expect(noResponse).toBeDefined();
      expect(noResponse!.strength).toBe(-0.1);
    });

    it("does not detect no_response before timeout", async () => {
      const episode = makeEpisode({
        source: "web_chat",
        source_ref: { conversation_id: "conv-1" },
        // Set timestamp recently (within timeout window)
        timestamp: new Date(Date.now() - 5 * 60 * 1000),
      });

      mockFindConversation.mockResolvedValue({
        conversation_id: "conv-1",
        owner: "test-owner",
        created_at: new Date(),
        updated_at: new Date(),
        messages: [
          {
            id: "m1",
            role: "user",
            text: "question",
            at: new Date(Date.now() - 5 * 60 * 1000 - 1000),
          },
          { id: "m2", role: "assistant", text: "answer", at: new Date(Date.now() - 5 * 60 * 1000) },
        ],
        linked_task_ids: [],
      });

      const config = makeConfig({ signal_no_response_timeout_ms: 1800000 });
      const signals = await detectSignals(episode, config);

      const noResponse = signals.find((s) => s.signal_type === "no_response");
      expect(noResponse).toBeUndefined();
    });
  });

  describe("detectJobSignals", () => {
    it("detects job_completed signal", async () => {
      mockFindJobByTaskId.mockResolvedValue({
        task_id: "task-1",
        status: "DONE",
      } as any);

      const signals = await detectJobSignals("task-1");
      expect(signals).toHaveLength(1);
      expect(signals[0].signal_type).toBe("job_completed");
      expect(signals[0].strength).toBe(1.0);
    });

    it("detects job_failed signal", async () => {
      mockFindJobByTaskId.mockResolvedValue({
        task_id: "task-1",
        status: "FAILED",
        error: { message: "Build failed" },
      } as any);

      const signals = await detectJobSignals("task-1");
      expect(signals).toHaveLength(1);
      expect(signals[0].signal_type).toBe("job_failed");
      expect(signals[0].strength).toBe(-0.5);
      expect(signals[0].details).toContain("Build failed");
    });

    it("returns no signals for running job", async () => {
      mockFindJobByTaskId.mockResolvedValue({
        task_id: "task-1",
        status: "RUNNING",
      } as any);

      const signals = await detectJobSignals("task-1");
      expect(signals).toHaveLength(0);
    });

    it("returns no signals when job not found", async () => {
      mockFindJobByTaskId.mockResolvedValue(null);

      const signals = await detectJobSignals("non-existent");
      expect(signals).toHaveLength(0);
    });

    it("handles job repo error gracefully", async () => {
      mockFindJobByTaskId.mockRejectedValue(new Error("DB error"));

      const signals = await detectJobSignals("task-1");
      expect(signals).toHaveLength(0);
    });
  });

  describe("detectEmbeddingSignals", () => {
    it("detects rephrase when similarity > 0.8", async () => {
      // Mock embedding provider to return very similar vectors
      mockGetEmbeddingProvider.mockReturnValue({
        embed: vi.fn().mockResolvedValue([
          [1.0, 0.1, 0.0],
          [0.99, 0.12, 0.01],
        ]),
        dimensions: 3,
        modelName: "test-model",
      });

      const signals = await detectEmbeddingSignals(
        "How do I configure TypeScript?",
        "How to set up TypeScript?",
      );

      const rephrase = signals.find((s) => s.signal_type === "rephrase");
      expect(rephrase).toBeDefined();
      expect(rephrase!.strength).toBe(-0.4);
    });

    it("detects follow_up_deeper when similarity 0.5-0.8 and longer message", async () => {
      // Mock embedding provider to return moderately similar vectors
      mockGetEmbeddingProvider.mockReturnValue({
        embed: vi.fn().mockResolvedValue([
          [1.0, 0.0, 0.0],
          [0.7, 0.7, 0.0],
        ]),
        dimensions: 3,
        modelName: "test-model",
      });

      const signals = await detectEmbeddingSignals(
        "TypeScript config",
        "Can you explain more about the TypeScript configuration options and which ones are recommended?",
      );

      const followUp = signals.find((s) => s.signal_type === "follow_up_deeper");
      expect(followUp).toBeDefined();
      expect(followUp!.strength).toBe(0.4);
    });

    it("detects topic_change when similarity < 0.3", async () => {
      // Mock embedding provider to return very different vectors
      mockGetEmbeddingProvider.mockReturnValue({
        embed: vi.fn().mockResolvedValue([
          [1.0, 0.0, 0.0],
          [0.0, 0.0, 1.0],
        ]),
        dimensions: 3,
        modelName: "test-model",
      });

      const signals = await detectEmbeddingSignals(
        "How do I configure TypeScript?",
        "What restaurants are nearby?",
      );

      const topicChange = signals.find((s) => s.signal_type === "topic_change");
      expect(topicChange).toBeDefined();
      expect(topicChange!.strength).toBe(0.0);
    });

    it("returns empty when similarity is in neutral zone (0.3-0.5)", async () => {
      // Mock embedding provider to return neutral similarity vectors
      mockGetEmbeddingProvider.mockReturnValue({
        embed: vi.fn().mockResolvedValue([
          [1.0, 0.0, 0.0],
          [0.4, 0.9, 0.0],
        ]),
        dimensions: 3,
        modelName: "test-model",
      });

      const signals = await detectEmbeddingSignals("TypeScript question", "Short");

      // Should not match follow_up_deeper (follow-up is shorter)
      // Should not match rephrase (sim not > 0.8)
      // Should not match topic_change (sim not < 0.3)
      expect(signals).toHaveLength(0);
    });
  });

  describe("collectSignals (batch)", () => {
    it("processes episodes past the delay threshold", async () => {
      const oldEpisode = makeEpisode({
        episode_id: "ep-old",
        source: "web_chat",
        source_ref: { conversation_id: "conv-1" },
        timestamp: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago
        signal_collected_at: undefined,
      });

      mockListEpisodes.mockResolvedValue({ episodes: [oldEpisode], total: 1 });

      // No follow-up message
      mockFindConversation.mockResolvedValue({
        conversation_id: "conv-1",
        owner: "test-owner",
        created_at: new Date(),
        updated_at: new Date(),
        messages: [
          {
            id: "m1",
            role: "user",
            text: "question",
            at: new Date(Date.now() - 10 * 60 * 1000 - 1000),
          },
          {
            id: "m2",
            role: "assistant",
            text: "answer",
            at: new Date(Date.now() - 10 * 60 * 1000),
          },
        ],
        linked_task_ids: [],
      });

      mockAppendSignals.mockResolvedValue(null);

      const config = makeConfig({ signal_delay_ms: 300000 }); // 5 min
      const result = await collectSignals(config);

      expect(result.episodes_processed).toBe(1);
      expect(mockAppendSignals).toHaveBeenCalled();
    });

    it("skips episodes not past the delay threshold", async () => {
      const recentEpisode = makeEpisode({
        episode_id: "ep-recent",
        timestamp: new Date(Date.now() - 1000), // 1 second ago
        signal_collected_at: undefined,
      });

      mockListEpisodes.mockResolvedValue({ episodes: [recentEpisode], total: 1 });

      const config = makeConfig({ signal_delay_ms: 300000 });
      const result = await collectSignals(config);

      expect(result.episodes_processed).toBe(0);
      expect(mockAppendSignals).not.toHaveBeenCalled();
    });

    it("skips already-collected episodes", async () => {
      const collectedEpisode = makeEpisode({
        episode_id: "ep-collected",
        timestamp: new Date(Date.now() - 10 * 60 * 1000),
        signal_collected_at: new Date(),
      });

      mockListEpisodes.mockResolvedValue({ episodes: [collectedEpisode], total: 1 });

      const config = makeConfig({ signal_delay_ms: 300000 });
      const result = await collectSignals(config);

      expect(result.episodes_processed).toBe(0);
    });

    it("processes multiple episodes in batch", async () => {
      const episodes = [
        makeEpisode({
          episode_id: "ep-1",
          source: "web_chat",
          source_ref: { conversation_id: "conv-1" },
          timestamp: new Date(Date.now() - 10 * 60 * 1000),
        }),
        makeEpisode({
          episode_id: "ep-2",
          source: "web_chat",
          source_ref: { conversation_id: "conv-2" },
          timestamp: new Date(Date.now() - 8 * 60 * 1000),
        }),
      ];

      mockListEpisodes.mockResolvedValue({ episodes, total: 2 });

      mockFindConversation.mockResolvedValue({
        conversation_id: "conv-1",
        owner: "test-owner",
        created_at: new Date(),
        updated_at: new Date(),
        messages: [],
        linked_task_ids: [],
      });

      mockAppendSignals.mockResolvedValue(null);

      const config = makeConfig({ signal_delay_ms: 300000 });
      const result = await collectSignals(config);

      expect(result.episodes_processed).toBe(2);
    });

    it("handles errors for individual episodes gracefully", async () => {
      const episodes = [
        makeEpisode({
          episode_id: "ep-bad",
          source: "web_chat",
          source_ref: { conversation_id: "conv-bad" },
          timestamp: new Date(Date.now() - 10 * 60 * 1000),
        }),
        makeEpisode({
          episode_id: "ep-good",
          source: "web_chat",
          source_ref: { conversation_id: "conv-good" },
          timestamp: new Date(Date.now() - 10 * 60 * 1000),
        }),
      ];

      mockListEpisodes.mockResolvedValue({ episodes, total: 2 });

      // First episode throws, second succeeds
      mockFindConversation.mockRejectedValueOnce(new Error("DB error")).mockResolvedValueOnce({
        conversation_id: "conv-good",
        owner: "test-owner",
        created_at: new Date(),
        updated_at: new Date(),
        messages: [],
        linked_task_ids: [],
      });

      mockAppendSignals.mockResolvedValue(null);

      const config = makeConfig({ signal_delay_ms: 300000 });
      const result = await collectSignals(config);

      // Only the good episode should be processed successfully
      expect(result.episodes_processed).toBe(1);
    });
  });
});
