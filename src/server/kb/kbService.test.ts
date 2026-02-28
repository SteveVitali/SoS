import { afterEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeBase } from "../../shared/kbTypes.js";
import type { VectorSearchResult } from "./vectorStore.js";

// Mock dependencies before importing the module under test
vi.mock("./kbRepo.js", () => ({
  listEnabledKBsByScope: vi.fn(),
  findKB: vi.fn(),
  createKB: vi.fn(),
  deleteKB: vi.fn(),
  updateKB: vi.fn(),
  listKBs: vi.fn(),
  incrementKBStats: vi.fn(),
  listDocuments: vi.fn(),
  addDocumentRecord: vi.fn(),
  removeDocumentRecord: vi.fn(),
}));

vi.mock("./vectorStore.js", () => ({
  searchKBTable: vi.fn(),
  addToKBTable: vi.fn(),
  countDocumentRows: vi.fn(),
  deleteDocumentFromKBTable: vi.fn(),
  dropKBTable: vi.fn(),
  listDocumentChunks: vi.fn(),
}));

vi.mock("./embeddings.js", () => ({
  getEmbeddingProvider: vi.fn(),
}));

vi.mock("./ingestion.js", () => ({
  ingestFiles: vi.fn(),
}));

import { getEmbeddingProvider } from "./embeddings.js";
import { listEnabledKBsByScope } from "./kbRepo.js";
import { distanceToSimilarity, searchKnowledgeBases } from "./kbService.js";
import { searchKBTable } from "./vectorStore.js";

const mockListEnabledKBsByScope = listEnabledKBsByScope as ReturnType<typeof vi.fn>;
const mockSearchKBTable = searchKBTable as ReturnType<typeof vi.fn>;
const mockGetEmbeddingProvider = getEmbeddingProvider as ReturnType<typeof vi.fn>;

function makeKB(overrides: Partial<KnowledgeBase> = {}): KnowledgeBase {
  return {
    kb_id: "kb-1",
    name: "Test KB",
    description: "A test KB",
    enabled: true,
    owner: "default",
    created_at: new Date(),
    updated_at: new Date(),
    scopes: ["chat"],
    chunk_count: 10,
    document_count: 2,
    total_size_bytes: 1000,
    embedding_model: "text-embedding-3-small",
    chunk_size: 512,
    chunk_overlap: 50,
    max_chunks_per_query: 5,
    min_similarity_score: 0.3,
    ...overrides,
  };
}

function makeSearchResult(overrides: Partial<VectorSearchResult> = {}): VectorSearchResult {
  return {
    id: "chunk-1",
    kb_id: "kb-1",
    source_file: "test.md",
    content: "Test content",
    section: "Introduction",
    page: 0,
    created_at: new Date().toISOString(),
    _distance: 0.5,
    ...overrides,
  };
}

const mockEmbedder = {
  embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
  modelName: "test-model",
  dimensions: 3,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("distanceToSimilarity", () => {
  it("returns 1 for distance 0", () => {
    expect(distanceToSimilarity(0)).toBe(1);
  });

  it("returns 0.5 for distance 1", () => {
    expect(distanceToSimilarity(1)).toBe(0.5);
  });

  it("returns values between 0 and 1 for positive distances", () => {
    expect(distanceToSimilarity(0.1)).toBeCloseTo(0.909, 2);
    expect(distanceToSimilarity(5)).toBeCloseTo(0.167, 2);
    expect(distanceToSimilarity(100)).toBeCloseTo(0.0099, 3);
  });
});

describe("searchKnowledgeBases (two-stage routing)", () => {
  it("returns empty when no KBs match the scopes", async () => {
    mockListEnabledKBsByScope.mockResolvedValue([]);

    const results = await searchKnowledgeBases({
      query: "test query",
      scopes: ["chat"],
    });

    expect(results).toEqual([]);
    expect(mockSearchKBTable).not.toHaveBeenCalled();
  });

  it("returns empty when embedding fails", async () => {
    mockListEnabledKBsByScope.mockResolvedValue([makeKB()]);
    mockGetEmbeddingProvider.mockReturnValue({
      embed: vi.fn().mockRejectedValue(new Error("API down")),
    });

    const results = await searchKnowledgeBases({
      query: "test",
      scopes: ["chat"],
    });

    expect(results).toEqual([]);
    expect(mockSearchKBTable).not.toHaveBeenCalled();
  });

  it("skips KBs whose probe result is below min_similarity_score", async () => {
    const kb1 = makeKB({ kb_id: "kb-1", name: "Relevant KB", min_similarity_score: 0.3 });
    const kb2 = makeKB({ kb_id: "kb-2", name: "Irrelevant KB", min_similarity_score: 0.3 });

    mockListEnabledKBsByScope.mockResolvedValue([kb1, kb2]);
    mockGetEmbeddingProvider.mockReturnValue(mockEmbedder);

    // kb-1 probe: distance 0.5 → similarity ~0.667 (above 0.3)
    // kb-2 probe: distance 10 → similarity ~0.091 (below 0.3)
    mockSearchKBTable
      .mockResolvedValueOnce([makeSearchResult({ kb_id: "kb-1", _distance: 0.5 })]) // kb-1 probe
      .mockResolvedValueOnce([makeSearchResult({ kb_id: "kb-2", _distance: 10 })]) // kb-2 probe
      .mockResolvedValueOnce([
        // kb-1 full search
        makeSearchResult({ kb_id: "kb-1", _distance: 0.5, content: "result 1" }),
        makeSearchResult({ kb_id: "kb-1", _distance: 0.8, content: "result 2" }),
      ]);

    const results = await searchKnowledgeBases({
      query: "test",
      scopes: ["chat"],
    });

    // searchKBTable called 3 times: probe kb-1, probe kb-2, full search kb-1
    expect(mockSearchKBTable).toHaveBeenCalledTimes(3);

    // Stage 1: probe kb-1 (limit=1), probe kb-2 (limit=1)
    expect(mockSearchKBTable).toHaveBeenNthCalledWith(1, "kb-1", [0.1, 0.2, 0.3], 1);
    expect(mockSearchKBTable).toHaveBeenNthCalledWith(2, "kb-2", [0.1, 0.2, 0.3], 1);

    // Stage 2: full search on kb-1 only (limit=5 from max_chunks_per_query)
    expect(mockSearchKBTable).toHaveBeenNthCalledWith(3, "kb-1", [0.1, 0.2, 0.3], 5);

    // Only results from kb-1
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.kb_id === "kb-1")).toBe(true);
  });

  it("searches all KBs in stage 2 when all pass the probe", async () => {
    const kb1 = makeKB({ kb_id: "kb-1", name: "KB One" });
    const kb2 = makeKB({ kb_id: "kb-2", name: "KB Two" });

    mockListEnabledKBsByScope.mockResolvedValue([kb1, kb2]);
    mockGetEmbeddingProvider.mockReturnValue(mockEmbedder);

    // Both probes pass
    mockSearchKBTable
      .mockResolvedValueOnce([makeSearchResult({ kb_id: "kb-1", _distance: 0.3 })]) // kb-1 probe
      .mockResolvedValueOnce([makeSearchResult({ kb_id: "kb-2", _distance: 0.4 })]) // kb-2 probe
      .mockResolvedValueOnce([
        // kb-1 full
        makeSearchResult({ kb_id: "kb-1", _distance: 0.3, content: "kb1 result" }),
      ])
      .mockResolvedValueOnce([
        // kb-2 full
        makeSearchResult({ kb_id: "kb-2", _distance: 0.4, content: "kb2 result" }),
      ]);

    const results = await searchKnowledgeBases({
      query: "test",
      scopes: ["chat"],
    });

    // 4 calls: 2 probes + 2 full searches
    expect(mockSearchKBTable).toHaveBeenCalledTimes(4);
    expect(results).toHaveLength(2);
  });

  it("returns empty when all probes are below threshold", async () => {
    const kb1 = makeKB({ kb_id: "kb-1", min_similarity_score: 0.5 });

    mockListEnabledKBsByScope.mockResolvedValue([kb1]);
    mockGetEmbeddingProvider.mockReturnValue(mockEmbedder);

    // Probe returns high distance → low similarity below 0.5
    mockSearchKBTable.mockResolvedValueOnce([
      makeSearchResult({ _distance: 5 }), // similarity ~0.167
    ]);

    const results = await searchKnowledgeBases({
      query: "test",
      scopes: ["chat"],
    });

    // Only 1 probe call, no stage 2
    expect(mockSearchKBTable).toHaveBeenCalledTimes(1);
    expect(results).toEqual([]);
  });

  it("handles probe returning empty results (empty KB table)", async () => {
    const kb1 = makeKB({ kb_id: "kb-1" });

    mockListEnabledKBsByScope.mockResolvedValue([kb1]);
    mockGetEmbeddingProvider.mockReturnValue(mockEmbedder);

    mockSearchKBTable.mockResolvedValueOnce([]); // empty table

    const results = await searchKnowledgeBases({
      query: "test",
      scopes: ["chat"],
    });

    expect(mockSearchKBTable).toHaveBeenCalledTimes(1);
    expect(results).toEqual([]);
  });

  it("gracefully handles probe failure for one KB and continues", async () => {
    const kb1 = makeKB({ kb_id: "kb-1", name: "Broken KB" });
    const kb2 = makeKB({ kb_id: "kb-2", name: "Good KB" });

    mockListEnabledKBsByScope.mockResolvedValue([kb1, kb2]);
    mockGetEmbeddingProvider.mockReturnValue(mockEmbedder);

    mockSearchKBTable
      .mockRejectedValueOnce(new Error("LanceDB table corrupted")) // kb-1 probe fails
      .mockResolvedValueOnce([makeSearchResult({ kb_id: "kb-2", _distance: 0.3 })]) // kb-2 probe
      .mockResolvedValueOnce([
        // kb-2 full
        makeSearchResult({ kb_id: "kb-2", _distance: 0.3, content: "good result" }),
      ]);

    const results = await searchKnowledgeBases({
      query: "test",
      scopes: ["chat"],
    });

    // 3 calls: failed probe + successful probe + full search
    expect(mockSearchKBTable).toHaveBeenCalledTimes(3);
    expect(results).toHaveLength(1);
    expect(results[0].kb_name).toBe("Good KB");
  });

  it("respects request-level min_score over KB-level min_similarity_score", async () => {
    const kb1 = makeKB({ kb_id: "kb-1", min_similarity_score: 0.1 });

    mockListEnabledKBsByScope.mockResolvedValue([kb1]);
    mockGetEmbeddingProvider.mockReturnValue(mockEmbedder);

    // Probe: distance 1 → similarity 0.5
    mockSearchKBTable.mockResolvedValueOnce([makeSearchResult({ _distance: 1 })]);

    // Request min_score=0.8 → probe result 0.5 doesn't pass
    const results = await searchKnowledgeBases({
      query: "test",
      scopes: ["chat"],
      min_score: 0.8,
    });

    expect(mockSearchKBTable).toHaveBeenCalledTimes(1); // probe only
    expect(results).toEqual([]);
  });

  it("respects max_chunks from the request", async () => {
    const kb1 = makeKB({ kb_id: "kb-1", max_chunks_per_query: 10 });

    mockListEnabledKBsByScope.mockResolvedValue([kb1]);
    mockGetEmbeddingProvider.mockReturnValue(mockEmbedder);

    mockSearchKBTable
      .mockResolvedValueOnce([makeSearchResult({ _distance: 0.2 })]) // probe
      .mockResolvedValueOnce([
        // full search
        makeSearchResult({ _distance: 0.2, content: "r1" }),
        makeSearchResult({ _distance: 0.3, content: "r2" }),
        makeSearchResult({ _distance: 0.4, content: "r3" }),
      ]);

    const results = await searchKnowledgeBases({
      query: "test",
      scopes: ["chat"],
      max_chunks: 2,
    });

    // Stage 2 called with max_chunks=2 (from request, not KB's 10)
    expect(mockSearchKBTable).toHaveBeenNthCalledWith(2, "kb-1", [0.1, 0.2, 0.3], 2);
    // Total results capped at 2
    expect(results).toHaveLength(2);
  });

  it("sorts final results by score descending across multiple KBs", async () => {
    const kb1 = makeKB({ kb_id: "kb-1", name: "KB One" });
    const kb2 = makeKB({ kb_id: "kb-2", name: "KB Two" });

    mockListEnabledKBsByScope.mockResolvedValue([kb1, kb2]);
    mockGetEmbeddingProvider.mockReturnValue(mockEmbedder);

    mockSearchKBTable
      .mockResolvedValueOnce([makeSearchResult({ kb_id: "kb-1", _distance: 0.3 })]) // kb-1 probe
      .mockResolvedValueOnce([makeSearchResult({ kb_id: "kb-2", _distance: 0.1 })]) // kb-2 probe
      .mockResolvedValueOnce([
        // kb-1 full
        makeSearchResult({ kb_id: "kb-1", _distance: 0.3, content: "kb1 mid" }),
        makeSearchResult({ kb_id: "kb-1", _distance: 0.8, content: "kb1 low" }),
      ])
      .mockResolvedValueOnce([
        // kb-2 full
        makeSearchResult({ kb_id: "kb-2", _distance: 0.1, content: "kb2 high" }),
      ]);

    const results = await searchKnowledgeBases({
      query: "test",
      scopes: ["chat"],
    });

    expect(results).toHaveLength(3);
    // Best result should be from kb-2 (distance 0.1 → highest similarity)
    expect(results[0].content).toBe("kb2 high");
    // Scores should be descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
  });
});
