import { beforeEach, describe, expect, it, vi } from "vitest";
import { hybridSearch } from "./hybridSearch.js";

// ─── Mocks ──────────────────────────────────────────────────

// Mock vectorStore.searchKBTable
vi.mock("./vectorStore.js", () => ({
  searchKBTable: vi.fn(),
}));

// Mock ftsStore.searchFTS
vi.mock("./ftsStore.js", () => ({
  searchFTS: vi.fn(),
  hasFTSIndex: vi.fn().mockReturnValue(true),
}));

// Mock kbService.distanceToSimilarity (re-export the real formula)
vi.mock("./kbService.js", () => ({
  distanceToSimilarity: (d: number) => 1 / (1 + d),
}));

import type { FTSSearchResult } from "./ftsStore.js";
import { searchFTS } from "./ftsStore.js";
import type { VectorSearchResult } from "./vectorStore.js";
import { searchKBTable } from "./vectorStore.js";

const mockSearchKBTable = vi.mocked(searchKBTable);
const mockSearchFTS = vi.mocked(searchFTS);

// ─── Helpers ────────────────────────────────────────────────

function makeVectorResult(id: string, content: string, distance: number): VectorSearchResult {
  return {
    id,
    kb_id: "kb1",
    source_file: "test.md",
    content,
    section: "",
    page: 0,
    file_path: "test.md",
    parent_dir: "",
    created_at: "",
    level: 0,
    children_ids: "[]",
    _distance: distance,
  };
}

function makeFTSResult(chunkId: string, content: string, bm25Score: number): FTSSearchResult {
  return {
    chunk_id: chunkId,
    kb_id: "kb1",
    source_file: "test.md",
    content,
    bm25_score: bm25Score,
  };
}

// ─── Tests ──────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe("hybridSearch", () => {
  it("returns empty when both indexes return nothing", async () => {
    mockSearchKBTable.mockResolvedValue([]);
    mockSearchFTS.mockReturnValue([]);

    const results = await hybridSearch("kb1", [1, 2, 3], "test query", 10);
    expect(results).toEqual([]);
  });

  it("returns vector-only results when FTS has no matches", async () => {
    mockSearchKBTable.mockResolvedValue([
      makeVectorResult("c1", "vector result 1", 0.1),
      makeVectorResult("c2", "vector result 2", 0.3),
    ]);
    mockSearchFTS.mockReturnValue([]);

    const results = await hybridSearch("kb1", [1, 2, 3], "test", 10);
    expect(results.length).toBe(2);
    // All results should have positive RRF scores
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
    }
  });

  it("returns FTS-only results when vector search returns nothing", async () => {
    mockSearchKBTable.mockResolvedValue([]);
    mockSearchFTS.mockReturnValue([
      makeFTSResult("c1", "keyword result 1", 5.0),
      makeFTSResult("c2", "keyword result 2", 3.0),
    ]);

    const results = await hybridSearch("kb1", [1, 2, 3], "test", 10);
    expect(results.length).toBe(2);
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
    }
  });

  it("merges and deduplicates results found in both indexes", async () => {
    // Same chunk_id "shared" appears in both
    mockSearchKBTable.mockResolvedValue([
      makeVectorResult("shared", "shared content", 0.1),
      makeVectorResult("vector-only", "vector only", 0.2),
    ]);
    mockSearchFTS.mockReturnValue([
      makeFTSResult("shared", "shared content", 5.0),
      makeFTSResult("fts-only", "fts only", 3.0),
    ]);

    const results = await hybridSearch("kb1", [1, 2, 3], "test", 10);

    // Should have 3 unique chunks, not 4
    expect(results.length).toBe(3);

    // "shared" should rank highest (appears in both → gets double RRF contribution)
    expect(results[0].content).toBe("shared content");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("applies RRF scoring correctly", async () => {
    const RRF_K = 60;

    // Rank 1 in vector, rank 1 in keyword
    mockSearchKBTable.mockResolvedValue([makeVectorResult("both", "both indexes", 0.1)]);
    mockSearchFTS.mockReturnValue([makeFTSResult("both", "both indexes", 5.0)]);

    const results = await hybridSearch("kb1", [1, 2, 3], "test", 10);
    expect(results.length).toBe(1);

    // Expected RRF: 1/(60+1) + 1/(60+1) = 2/61
    const expectedRRF = 2 / (RRF_K + 1);
    expect(results[0].score).toBeCloseTo(expectedRRF, 6);
  });

  it("respects the limit parameter", async () => {
    mockSearchKBTable.mockResolvedValue([
      makeVectorResult("c1", "content 1", 0.1),
      makeVectorResult("c2", "content 2", 0.2),
      makeVectorResult("c3", "content 3", 0.3),
    ]);
    mockSearchFTS.mockReturnValue([]);

    const results = await hybridSearch("kb1", [1, 2, 3], "test", 2);
    expect(results.length).toBe(2);
  });

  it("filters vector results below minSimilarityScore", async () => {
    // distance=5 → similarity = 1/(1+5) ≈ 0.167 (below 0.3 threshold)
    mockSearchKBTable.mockResolvedValue([
      makeVectorResult("good", "high similarity", 0.1), // similarity ≈ 0.909
      makeVectorResult("bad", "low similarity", 5.0), // similarity ≈ 0.167
    ]);
    mockSearchFTS.mockReturnValue([]);

    const results = await hybridSearch("kb1", [1, 2, 3], "test", 10, {
      minSimilarityScore: 0.3,
    });

    expect(results.length).toBe(1);
    expect(results[0].content).toBe("high similarity");
  });

  it("attaches kbName from config to results", async () => {
    mockSearchKBTable.mockResolvedValue([makeVectorResult("c1", "content", 0.1)]);
    mockSearchFTS.mockReturnValue([]);

    const results = await hybridSearch("kb1", [1, 2, 3], "test", 10, {
      kbName: "My Knowledge Base",
    });

    expect(results[0].kb_name).toBe("My Knowledge Base");
  });

  it("sorts results by RRF score descending", async () => {
    // c1 is rank 1 in vector + rank 2 in FTS
    // c2 is rank 2 in vector + rank 1 in FTS
    // Both should have the same RRF score
    // c3 is only in vector (rank 3)
    mockSearchKBTable.mockResolvedValue([
      makeVectorResult("c1", "content 1", 0.1),
      makeVectorResult("c2", "content 2", 0.2),
      makeVectorResult("c3", "content 3", 0.3),
    ]);
    mockSearchFTS.mockReturnValue([
      makeFTSResult("c2", "content 2", 5.0),
      makeFTSResult("c1", "content 1", 3.0),
    ]);

    const results = await hybridSearch("kb1", [1, 2, 3], "test", 10);

    // c1 and c2 both appear in both indexes, so they should rank above c3
    expect(results.length).toBe(3);
    expect(results[2].content).toBe("content 3"); // lowest RRF (single source)
    // c1 and c2 should have equal RRF (rank 1 in one + rank 2 in other)
    expect(results[0].score).toBeCloseTo(results[1].score, 6);
  });

  it("passes perIndexLimit to both search functions", async () => {
    mockSearchKBTable.mockResolvedValue([]);
    mockSearchFTS.mockReturnValue([]);

    await hybridSearch("kb1", [1, 2, 3], "test", 10, {
      perIndexLimit: 50,
    });

    expect(mockSearchKBTable).toHaveBeenCalledWith("kb1", [1, 2, 3], 50);
    expect(mockSearchFTS).toHaveBeenCalledWith("kb1", "test", 50);
  });
});
