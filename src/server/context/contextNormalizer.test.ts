import { describe, expect, it } from "vitest";
import type { KBSearchResult } from "../../shared/kbTypes.js";
import type { MemoryNote, MemorySearchResult } from "../../shared/memoryTypes.js";
import { normalizeKBResults, normalizeMemoryResults } from "./contextNormalizer.js";

describe("normalizeKBResults", () => {
  it("converts KBSearchResult[] to ContextItem[]", () => {
    const results: KBSearchResult[] = [
      {
        content: "Auth module uses JWT",
        source_file: "auth.md",
        kb_name: "Design Docs",
        kb_id: "kb-1",
        score: 0.85,
        metadata: { section: "JWT", file_path: "docs/auth.md" },
      },
    ];

    const items = normalizeKBResults(results);
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe("kb");
    expect(items[0].content).toBe("Auth module uses JWT");
    expect(items[0].raw_score).toBe(0.85);
    expect(items[0].metadata.kb_name).toBe("Design Docs");
    expect(items[0].metadata.section).toBe("JWT");
    expect(items[0].metadata.temporal_tag).toContain("Design Docs");
  });

  it("returns empty array for empty input", () => {
    expect(normalizeKBResults([])).toEqual([]);
  });

  it("generates unique IDs for each item", () => {
    const results: KBSearchResult[] = [
      {
        content: "A",
        source_file: "a.md",
        kb_name: "KB1",
        kb_id: "kb-1",
        score: 0.9,
        metadata: {},
      },
      {
        content: "B",
        source_file: "b.md",
        kb_name: "KB1",
        kb_id: "kb-1",
        score: 0.8,
        metadata: {},
      },
    ];

    const items = normalizeKBResults(results);
    expect(items[0].id).not.toBe(items[1].id);
  });
});

describe("normalizeMemoryResults", () => {
  const makeMemory = (overrides?: Partial<MemoryNote>): MemoryNote => ({
    memory_id: "mem-1",
    owner: "user-1",
    memory_type: "fact",
    content: "User prefers TypeScript strict mode",
    context: "From a chat about linting",
    keywords: ["typescript", "strict"],
    tags: ["preferences"],
    source_episodes: ["ep-1"],
    source_type: "slack",
    created_at: new Date("2026-03-01"),
    updated_at: new Date("2026-03-15"),
    valid_from: new Date("2026-03-01"),
    linked_memory_ids: [],
    link_reasons: [],
    access_count: 3,
    importance: 0.7,
    confidence: 0.9,
    embedding_text: "User prefers TypeScript strict mode",
    ...overrides,
  });

  const makeSearchResult = (overrides?: Partial<MemorySearchResult>): MemorySearchResult => ({
    memory: makeMemory(overrides?.memory as Partial<MemoryNote>),
    score: 0.75,
    similarity_score: 0.8,
    recency_score: 0.9,
    importance_score: 0.7,
    access_score: 0.3,
    ...overrides,
  });

  it("converts MemorySearchResult[] to ContextItem[]", () => {
    const results = [makeSearchResult()];
    const items = normalizeMemoryResults(results);

    expect(items).toHaveLength(1);
    expect(items[0].source).toBe("memory");
    expect(items[0].content).toBe("User prefers TypeScript strict mode");
    expect(items[0].raw_score).toBe(0.75);
    expect(items[0].metadata.memory_type).toBe("fact");
    expect(items[0].metadata.memory_id).toBe("mem-1");
    expect(items[0].metadata.importance).toBe(0.7);
    expect(items[0].metadata.temporal_tag).toContain("fact");
    expect(items[0].metadata.temporal_tag).toContain("Mar");
  });

  it("formats reflection temporal_tag with episode count", () => {
    const results = [
      makeSearchResult({
        memory: makeMemory({
          memory_type: "reflection",
          source_episodes: ["ep-1", "ep-2", "ep-3"],
          content: "Auth questions usually relate to OAuth",
        }),
      }),
    ];

    const items = normalizeMemoryResults(results);
    expect(items[0].metadata.temporal_tag).toBe("reflection, from 3 interactions");
  });

  it("returns empty array for empty input", () => {
    expect(normalizeMemoryResults([])).toEqual([]);
  });
});
