import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addToFTSIndex,
  closeFTSStore,
  countFTSRows,
  deleteDocumentFromFTS,
  dropFTSIndex,
  type FTSRecord,
  hasFTSIndex,
  initFTSStore,
  rebuildFTSIndex,
  sanitizeFTSQuery,
  searchFTS,
} from "./ftsStore.js";

const KB_ID = "test-kb-001";

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "fts-test-"));
  initFTSStore(tempDir);
});

afterAll(() => {
  closeFTSStore();
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Clean up the test KB index before each test
  dropFTSIndex(KB_ID);
});

function makeRecords(count: number, sourceFile = "test.md"): FTSRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    chunk_id: `chunk-${i}`,
    kb_id: KB_ID,
    source_file: sourceFile,
    content: `This is chunk number ${i} with some content about testing.`,
  }));
}

// ─── Lifecycle ──────────────────────────────────────────────

describe("initFTSStore / hasFTSIndex", () => {
  it("reports no index before any records are added", () => {
    expect(hasFTSIndex(KB_ID)).toBe(false);
  });

  it("reports index exists after adding records", () => {
    addToFTSIndex(KB_ID, makeRecords(1));
    expect(hasFTSIndex(KB_ID)).toBe(true);
  });
});

// ─── CRUD ───────────────────────────────────────────────────

describe("addToFTSIndex / countFTSRows", () => {
  it("inserts records and counts them", () => {
    addToFTSIndex(KB_ID, makeRecords(5));
    expect(countFTSRows(KB_ID)).toBe(5);
  });

  it("handles empty array gracefully", () => {
    addToFTSIndex(KB_ID, []);
    expect(hasFTSIndex(KB_ID)).toBe(false); // no DB created
  });

  it("accumulates records across multiple calls", () => {
    addToFTSIndex(KB_ID, makeRecords(3, "file1.md"));
    addToFTSIndex(KB_ID, makeRecords(2, "file2.md"));
    expect(countFTSRows(KB_ID)).toBe(5);
  });
});

describe("deleteDocumentFromFTS", () => {
  it("deletes records for a specific source file", () => {
    addToFTSIndex(KB_ID, [
      { chunk_id: "a1", kb_id: KB_ID, source_file: "keep.md", content: "keep this" },
      { chunk_id: "a2", kb_id: KB_ID, source_file: "delete.md", content: "delete this" },
      { chunk_id: "a3", kb_id: KB_ID, source_file: "keep.md", content: "also keep" },
    ]);
    expect(countFTSRows(KB_ID)).toBe(3);

    deleteDocumentFromFTS(KB_ID, "delete.md");
    expect(countFTSRows(KB_ID)).toBe(2);
  });

  it("is a no-op when index does not exist", () => {
    // Should not throw
    deleteDocumentFromFTS("nonexistent-kb", "file.md");
  });
});

describe("dropFTSIndex", () => {
  it("removes the SQLite file", () => {
    addToFTSIndex(KB_ID, makeRecords(1));
    expect(hasFTSIndex(KB_ID)).toBe(true);

    dropFTSIndex(KB_ID);
    expect(hasFTSIndex(KB_ID)).toBe(false);
  });

  it("is a no-op when called twice", () => {
    addToFTSIndex(KB_ID, makeRecords(1));
    dropFTSIndex(KB_ID);
    dropFTSIndex(KB_ID); // should not throw
    expect(hasFTSIndex(KB_ID)).toBe(false);
  });
});

describe("rebuildFTSIndex", () => {
  it("replaces existing index with new records", () => {
    addToFTSIndex(KB_ID, makeRecords(10));
    expect(countFTSRows(KB_ID)).toBe(10);

    rebuildFTSIndex(KB_ID, makeRecords(3));
    expect(countFTSRows(KB_ID)).toBe(3);
  });

  it("handles empty rebuild (drops everything)", () => {
    addToFTSIndex(KB_ID, makeRecords(5));
    rebuildFTSIndex(KB_ID, []);
    expect(hasFTSIndex(KB_ID)).toBe(false);
  });
});

// ─── Search ─────────────────────────────────────────────────

describe("searchFTS", () => {
  it("returns results ranked by BM25 relevance", () => {
    addToFTSIndex(KB_ID, [
      { chunk_id: "c1", kb_id: KB_ID, source_file: "a.md", content: "The quick brown fox jumps." },
      {
        chunk_id: "c2",
        kb_id: KB_ID,
        source_file: "b.md",
        content: "Fox foxes fox — the fox is very foxy.",
      },
      { chunk_id: "c3", kb_id: KB_ID, source_file: "c.md", content: "No animals mentioned here." },
    ]);

    const results = searchFTS(KB_ID, "fox", 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    // "c2" has more fox mentions, should rank higher
    expect(results[0].chunk_id).toBe("c2");
    // All scores should be positive (we negate the raw BM25 score)
    for (const r of results) {
      expect(r.bm25_score).toBeGreaterThan(0);
    }
  });

  it("respects the limit parameter", () => {
    addToFTSIndex(KB_ID, makeRecords(20));
    const results = searchFTS(KB_ID, "testing", 5);
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it("returns empty for queries with no matches", () => {
    addToFTSIndex(KB_ID, makeRecords(3));
    const results = searchFTS(KB_ID, "xyzzyplugh", 10);
    expect(results).toEqual([]);
  });

  it("returns empty when index does not exist", () => {
    const results = searchFTS("nonexistent-kb", "test", 10);
    expect(results).toEqual([]);
  });

  it("returns empty for empty query", () => {
    addToFTSIndex(KB_ID, makeRecords(3));
    const results = searchFTS(KB_ID, "", 10);
    expect(results).toEqual([]);
  });

  it("handles exact string matching for code symbols", () => {
    addToFTSIndex(KB_ID, [
      {
        chunk_id: "code1",
        kb_id: KB_ID,
        source_file: "api.ts",
        content: "export function searchKBTable(kbId: string, queryVector: number[])",
      },
      {
        chunk_id: "code2",
        kb_id: KB_ID,
        source_file: "config.ts",
        content: "const MAX_RETRIES = 3; export const DEFAULT_TIMEOUT = 5000;",
      },
    ]);

    const results = searchFTS(KB_ID, "searchKBTable", 10);
    expect(results.length).toBe(1);
    expect(results[0].chunk_id).toBe("code1");
  });

  it("uses porter stemming (plurals, tenses)", () => {
    addToFTSIndex(KB_ID, [
      {
        chunk_id: "stem1",
        kb_id: KB_ID,
        source_file: "doc.md",
        content: "The servers are running smoothly.",
      },
    ]);

    // "server" should match "servers" via porter stemming
    const results = searchFTS(KB_ID, "server running", 10);
    expect(results.length).toBe(1);
  });

  it("returns metadata fields (section, page, file_path, parent_dir)", () => {
    addToFTSIndex(KB_ID, [
      {
        chunk_id: "meta1",
        kb_id: KB_ID,
        source_file: "guide.md",
        content: "Deployment instructions for kubernetes clusters.",
        section: "Getting Started",
        page: 3,
        file_path: "docs/guide.md",
        parent_dir: "docs",
      },
    ]);

    const results = searchFTS(KB_ID, "kubernetes", 10);
    expect(results.length).toBe(1);
    expect(results[0].section).toBe("Getting Started");
    expect(results[0].page).toBe(3);
    expect(results[0].file_path).toBe("docs/guide.md");
    expect(results[0].parent_dir).toBe("docs");
  });

  it("returns undefined metadata when fields are empty", () => {
    addToFTSIndex(KB_ID, [
      {
        chunk_id: "nometa",
        kb_id: KB_ID,
        source_file: "plain.md",
        content: "Content without metadata fields.",
      },
    ]);

    const results = searchFTS(KB_ID, "metadata", 10);
    expect(results.length).toBe(1);
    // Empty strings/zero stored → returned as undefined
    expect(results[0].section).toBeUndefined();
    expect(results[0].page).toBeUndefined();
    expect(results[0].file_path).toBeUndefined();
    expect(results[0].parent_dir).toBeUndefined();
  });
});

// ─── Query Sanitization ─────────────────────────────────────

describe("sanitizeFTSQuery", () => {
  it("strips special FTS5 characters", () => {
    expect(sanitizeFTSQuery('hello "world"')).toBe('"hello" OR "world"');
  });

  it("removes boolean operators", () => {
    expect(sanitizeFTSQuery("foo AND bar NOT baz")).toBe('"foo" OR "bar" OR "baz"');
  });

  it("handles empty/whitespace input", () => {
    expect(sanitizeFTSQuery("")).toBe("");
    expect(sanitizeFTSQuery("   ")).toBe("");
  });

  it("preserves normal search terms", () => {
    expect(sanitizeFTSQuery("kubernetes pod restart")).toBe('"kubernetes" OR "pod" OR "restart"');
  });

  it("handles special characters in code queries", () => {
    const result = sanitizeFTSQuery("searchKBTable(kbId)");
    // Parentheses removed, tokens preserved
    expect(result).toContain("searchKBTable");
    expect(result).toContain("kbId");
  });
});
