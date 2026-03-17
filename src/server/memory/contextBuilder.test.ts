import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryConfig, MemoryNote, MemorySearchResult } from "../../shared/memoryTypes.js";

// Mock dependencies before importing the module under test
vi.mock("./memorySearch.js", () => ({
  searchMemories: vi.fn(),
}));

vi.mock("./memoryRepo.js", () => ({
  listMemories: vi.fn(),
}));

import { buildMemoryContext, buildUserContext } from "./contextBuilder.js";
import { listMemories } from "./memoryRepo.js";
import { searchMemories } from "./memorySearch.js";

const mockSearchMemories = vi.mocked(searchMemories);
const mockListMemories = vi.mocked(listMemories);

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

function makeMemoryNote(overrides: Partial<MemoryNote> = {}): MemoryNote {
  const now = new Date();
  return {
    memory_id: `mem-${Math.random().toString(36).slice(2, 8)}`,
    owner: "test-owner",
    memory_type: "fact",
    content: "The user prefers TypeScript strict mode",
    context: "From a chat about code style",
    keywords: ["typescript", "strict"],
    tags: ["code_style"],
    source_episodes: ["ep-1"],
    source_type: "slack",
    created_at: now,
    updated_at: now,
    valid_from: now,
    linked_memory_ids: [],
    link_reasons: [],
    access_count: 2,
    importance: 0.5,
    confidence: 0.8,
    embedding_text: "The user prefers TypeScript strict mode.",
    ...overrides,
  };
}

function makeSearchResult(overrides: Partial<MemorySearchResult> = {}): MemorySearchResult {
  return {
    memory: makeMemoryNote(),
    score: 0.75,
    similarity_score: 0.8,
    recency_score: 0.9,
    importance_score: 0.5,
    access_score: 0.2,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("contextBuilder", () => {
  describe("buildMemoryContext", () => {
    it("returns empty string when disabled", async () => {
      const config = makeConfig({ enabled: false });
      const result = await buildMemoryContext("test query", "owner", config);
      expect(result).toBe("");
    });

    it("returns empty string when no memories found", async () => {
      mockSearchMemories.mockResolvedValue([]);
      const result = await buildMemoryContext("test query", "owner", makeConfig());
      expect(result).toBe("");
    });

    it("formats fact memories with type and date", async () => {
      const date = new Date("2025-03-15T12:00:00Z");
      const expectedDateStr = date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
      const mem = makeMemoryNote({
        memory_type: "fact",
        content: "User prefers dark mode",
        updated_at: date,
      });
      mockSearchMemories.mockResolvedValue([makeSearchResult({ memory: mem })]);

      const result = await buildMemoryContext("test query", "owner", makeConfig());
      expect(result).toContain(`[fact, learned ${expectedDateStr}]`);
      expect(result).toContain("User prefers dark mode");
    });

    it("formats reflection memories with episode count", async () => {
      const mem = makeMemoryNote({
        memory_type: "reflection",
        content: "Auth questions usually relate to OAuth",
        source_episodes: ["ep-1", "ep-2", "ep-3", "ep-4", "ep-5"],
      });
      mockSearchMemories.mockResolvedValue([makeSearchResult({ memory: mem })]);

      const result = await buildMemoryContext("test query", "owner", makeConfig());
      expect(result).toContain("[reflection, from 5 interactions]");
      expect(result).toContain("Auth questions usually relate to OAuth");
    });

    it("formats reflection with singular interaction count", async () => {
      const mem = makeMemoryNote({
        memory_type: "reflection",
        content: "Single interaction reflection",
        source_episodes: ["ep-1"],
      });
      mockSearchMemories.mockResolvedValue([makeSearchResult({ memory: mem })]);

      const result = await buildMemoryContext("test query", "owner", makeConfig());
      expect(result).toContain("[reflection, from 1 interaction]");
    });

    it("truncates to token limit", async () => {
      // Create memories with very long content that exceeds token budget
      const results = Array.from({ length: 20 }, (_, i) =>
        makeSearchResult({
          memory: makeMemoryNote({
            memory_id: `mem-${i}`,
            content: `Memory number ${i}: ${"A".repeat(200)}`,
          }),
        }),
      );
      mockSearchMemories.mockResolvedValue(results);

      const config = makeConfig({ retrieval_max_tokens: 100 });
      const result = await buildMemoryContext("test query", "owner", config);

      // Token estimate is ~4 chars per token, so 100 tokens ≈ 400 chars
      // Should have fewer than all 20 memories
      const lines = result.split("\n").filter(Boolean);
      expect(lines.length).toBeLessThan(20);
      expect(lines.length).toBeGreaterThan(0);
    });

    it("formats multiple memories as list items", async () => {
      const results = [
        makeSearchResult({
          memory: makeMemoryNote({ content: "First fact", memory_type: "fact" }),
        }),
        makeSearchResult({
          memory: makeMemoryNote({ content: "Second fact", memory_type: "fact" }),
        }),
      ];
      mockSearchMemories.mockResolvedValue(results);

      const result = await buildMemoryContext("test", "owner", makeConfig());
      expect(result).toContain("- [fact");
      expect(result).toContain("First fact");
      expect(result).toContain("Second fact");
    });

    it("returns empty string on search error", async () => {
      mockSearchMemories.mockRejectedValue(new Error("search failed"));
      const result = await buildMemoryContext("test", "owner", makeConfig());
      expect(result).toBe("");
    });
  });

  describe("buildUserContext", () => {
    it("returns profile content when it exists", async () => {
      const profile = makeMemoryNote({
        memory_type: "user_profile",
        content: "Steve is a TypeScript developer who prefers strict mode.",
      });
      mockListMemories.mockResolvedValue({ memories: [profile], total: 1 });

      const result = await buildUserContext("test-owner");
      expect(result).toBe("Steve is a TypeScript developer who prefers strict mode.");
    });

    it("returns empty string when no profile exists", async () => {
      mockListMemories.mockResolvedValue({ memories: [], total: 0 });
      const result = await buildUserContext("test-owner");
      expect(result).toBe("");
    });

    it("returns empty string on error", async () => {
      mockListMemories.mockRejectedValue(new Error("db error"));
      const result = await buildUserContext("test-owner");
      expect(result).toBe("");
    });

    it("queries with correct parameters", async () => {
      mockListMemories.mockResolvedValue({ memories: [], total: 0 });
      await buildUserContext("my-owner");

      expect(mockListMemories).toHaveBeenCalledWith({
        owner: "my-owner",
        memory_type: "user_profile",
        include_invalidated: false,
        limit: 1,
      });
    });
  });
});
