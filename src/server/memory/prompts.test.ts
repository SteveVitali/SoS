import { describe, expect, it } from "vitest";
import type { InteractionEpisode, MemoryNote } from "../../shared/memoryTypes.js";
import {
  buildBatchedExtractionPrompt,
  buildFactExtractionPrompt,
  buildMemoryCurationPrompt,
  buildMemoryEvolutionPrompt,
  formatMemoriesForPrompt,
  formatPriorEpisodes,
} from "./prompts.js";

describe("prompts", () => {
  describe("buildFactExtractionPrompt", () => {
    it("renders basic extraction prompt", () => {
      const prompt = buildFactExtractionPrompt({
        user_message: "I prefer tabs over spaces",
        routed_action: "chat",
        response_summary: "Noted your preference for tabs.",
        max_facts: 5,
      });

      expect(prompt).toContain("I prefer tabs over spaces");
      expect(prompt).toContain("chat");
      expect(prompt).toContain("Noted your preference for tabs.");
      expect(prompt).toContain("0–5");
      expect(prompt).not.toContain("Recent conversation context");
    });

    it("includes prior context when provided", () => {
      const prompt = buildFactExtractionPrompt({
        user_message: "Actually, I changed my mind",
        routed_action: "chat",
        response_summary: "OK, updated.",
        prior_context: "- User said they prefer tabs",
        max_facts: 3,
      });

      expect(prompt).toContain("Recent conversation context");
      expect(prompt).toContain("User said they prefer tabs");
      expect(prompt).toContain("0–3");
    });

    it("handles empty user message", () => {
      const prompt = buildFactExtractionPrompt({
        user_message: "",
        routed_action: "no_op",
        response_summary: "",
        max_facts: 5,
      });

      expect(prompt).toContain("User: ");
      expect(prompt).toContain("Return JSON");
    });
  });

  describe("buildMemoryCurationPrompt", () => {
    it("renders with similar memories", () => {
      const prompt = buildMemoryCurationPrompt({
        new_fact_content: "The user prefers dark mode",
        similar_memories: [
          {
            memory_id: "mem-1",
            content: "The user likes light mode",
            created_at: "2025-03-10",
            importance: 0.5,
          },
        ],
      });

      expect(prompt).toContain("The user prefers dark mode");
      expect(prompt).toContain("[mem-1]");
      expect(prompt).toContain("The user likes light mode");
      expect(prompt).toContain("ADD");
      expect(prompt).toContain("UPDATE");
      expect(prompt).toContain("DELETE");
      expect(prompt).toContain("NOOP");
    });

    it("renders with no similar memories", () => {
      const prompt = buildMemoryCurationPrompt({
        new_fact_content: "Brand new fact",
        similar_memories: [],
      });

      expect(prompt).toContain("Brand new fact");
      expect(prompt).toContain("(none)");
    });

    it("renders multiple similar memories", () => {
      const prompt = buildMemoryCurationPrompt({
        new_fact_content: "test fact",
        similar_memories: [
          { memory_id: "m1", content: "first", created_at: "2025-01-01", importance: 0.3 },
          { memory_id: "m2", content: "second", created_at: "2025-02-01", importance: 0.7 },
        ],
      });

      expect(prompt).toContain("[m1]");
      expect(prompt).toContain("[m2]");
      expect(prompt).toContain("importance: 0.3");
      expect(prompt).toContain("importance: 0.7");
    });
  });

  describe("buildBatchedExtractionPrompt", () => {
    it("renders the combined prompt with existing memories", () => {
      const prompt = buildBatchedExtractionPrompt({
        user_message: "Use ESLint with Biome for this project",
        routed_action: "chat",
        response_summary: "Good choice, Biome is fast.",
        existing_memories: [
          { memory_id: "mem-1", content: "User uses Biome for formatting", importance: 0.5 },
        ],
        max_facts: 5,
      });

      expect(prompt).toContain("ESLint with Biome");
      expect(prompt).toContain("[mem-1]");
      expect(prompt).toContain("User uses Biome");
      expect(prompt).toContain("0–5");
      expect(prompt).toContain('"operations"');
    });

    it("renders with no existing memories", () => {
      const prompt = buildBatchedExtractionPrompt({
        user_message: "hello",
        routed_action: "chat",
        response_summary: "hi",
        existing_memories: [],
        max_facts: 3,
      });

      expect(prompt).toContain("(none)");
    });

    it("includes prior context when provided", () => {
      const prompt = buildBatchedExtractionPrompt({
        user_message: "yes that's right",
        routed_action: "chat",
        response_summary: "ok",
        prior_context: "- earlier message about TypeScript",
        existing_memories: [],
        max_facts: 5,
      });

      expect(prompt).toContain("Recent conversation context");
      expect(prompt).toContain("earlier message about TypeScript");
    });
  });

  describe("buildMemoryEvolutionPrompt", () => {
    it("renders evolution prompt with neighbors", () => {
      const prompt = buildMemoryEvolutionPrompt({
        new_memory_content: "User prefers strict TypeScript",
        keywords: ["typescript", "strict"],
        tags: ["code_style"],
        neighbors: [
          {
            memory_id: "n1",
            content: "User uses TypeScript for all projects",
            context: "From a chat discussion",
            keywords: ["typescript", "projects"],
          },
        ],
      });

      expect(prompt).toContain("User prefers strict TypeScript");
      expect(prompt).toContain("typescript, strict");
      expect(prompt).toContain("code_style");
      expect(prompt).toContain("[n1]");
      expect(prompt).toContain("User uses TypeScript for all projects");
      expect(prompt).toContain("create_link");
    });

    it("renders multiple neighbors", () => {
      const prompt = buildMemoryEvolutionPrompt({
        new_memory_content: "test",
        keywords: ["k1"],
        tags: ["t1"],
        neighbors: [
          { memory_id: "n1", content: "c1", context: "ctx1", keywords: ["k1"] },
          { memory_id: "n2", content: "c2", context: "ctx2", keywords: ["k2", "k3"] },
        ],
      });

      expect(prompt).toContain("[n1]");
      expect(prompt).toContain("[n2]");
      expect(prompt).toContain("k2, k3");
    });
  });

  describe("formatPriorEpisodes", () => {
    it("formats episodes as context lines", () => {
      const episodes: InteractionEpisode[] = [
        {
          episode_id: "ep-1",
          owner: "test",
          source: "slack",
          source_ref: {},
          user_message: "How do I enable strict mode?",
          routed_action: "chat",
          action_args_summary: "{}",
          response_summary: "You can enable it in tsconfig.json",
          signals: [],
          timestamp: new Date("2025-03-15T10:00:00Z"),
          extraction_status: "pending",
          extracted_memory_ids: [],
        },
      ];

      const result = formatPriorEpisodes(episodes);
      expect(result).toContain("How do I enable strict mode?");
      expect(result).toContain("chat");
      expect(result).toContain("tsconfig.json");
    });

    it("returns empty string for no episodes", () => {
      expect(formatPriorEpisodes([])).toBe("");
    });
  });

  describe("formatMemoriesForPrompt", () => {
    it("extracts memory_id, content, importance", () => {
      const memories = [
        {
          memory_id: "m1",
          content: "Test content",
          importance: 0.7,
          owner: "test",
          memory_type: "fact" as const,
          context: "",
          keywords: [],
          tags: [],
          source_episodes: [],
          source_type: "slack" as const,
          created_at: new Date(),
          updated_at: new Date(),
          valid_from: new Date(),
          linked_memory_ids: [],
          link_reasons: [],
          access_count: 0,
          confidence: 0.8,
          embedding_text: "",
        },
      ] satisfies MemoryNote[];

      const result = formatMemoriesForPrompt(memories);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        memory_id: "m1",
        content: "Test content",
        importance: 0.7,
      });
    });
  });
});
