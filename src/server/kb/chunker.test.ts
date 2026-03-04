import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { type Chunk, type ChunkOptions, chunkPdfPages, chunkText } from "./chunker.js";

const defaults: ChunkOptions = { chunkSize: 512, chunkOverlap: 50 };
const small: ChunkOptions = { chunkSize: 20, chunkOverlap: 5 };

describe("chunkText", () => {
  it("returns empty array for empty/whitespace input", () => {
    expect(chunkText("", defaults)).toEqual([]);
    expect(chunkText("   ", defaults)).toEqual([]);
    expect(chunkText("\n\n", defaults)).toEqual([]);
  });

  it("returns a single chunk for short text", () => {
    const chunks = chunkText("Hello, world.", defaults);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe("Hello, world.");
    expect(chunks[0].metadata.section).toBeUndefined();
  });

  it("preserves markdown heading as section metadata", () => {
    const text = "# Introduction\n\nThis is the intro.\n\n## Details\n\nSome details here.";
    const chunks = chunkText(text, defaults);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].metadata.section).toBe("Introduction");
    expect(chunks[1].metadata.section).toBe("Details");
  });

  it("splits long text into multiple chunks", () => {
    // Each paragraph is ~25 tokens at 4 chars/token = ~100 chars
    const paragraph = "A".repeat(100);
    const text = Array(10).fill(paragraph).join("\n\n");
    const chunks = chunkText(text, small);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeGreaterThan(0);
    }
  });

  it("handles text with only headings (no body)", () => {
    const text = "# Heading One\n\n## Heading Two\n\n### Heading Three";
    const chunks = chunkText(text, defaults);
    // Heading-only text still produces chunks since the raw text is non-empty
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it("splits on paragraph boundaries before sentence boundaries", () => {
    const text = "First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.";
    // With small chunk size, paragraphs should stay intact if possible
    const chunks = chunkText(text, { chunkSize: 10, chunkOverlap: 2 });
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it("handles very long single sentence via token window", () => {
    const longSentence = "word ".repeat(500); // ~625 tokens at 4 chars/token
    const chunks = chunkText(longSentence, { chunkSize: 50, chunkOverlap: 10 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("handles mixed heading levels", () => {
    const text = [
      "# H1",
      "Content under H1.",
      "## H2",
      "Content under H2.",
      "### H3",
      "Content under H3.",
    ].join("\n\n");
    const chunks = chunkText(text, defaults);
    const sections = chunks.map((c) => c.metadata.section);
    expect(sections).toContain("H1");
    expect(sections).toContain("H2");
    expect(sections).toContain("H3");
  });

  it("trims excessive newlines in chunks", () => {
    const text = "Hello\n\n\n\n\n\nworld";
    const chunks = chunkText(text, defaults);
    for (const chunk of chunks) {
      expect(chunk.content).not.toMatch(/\n{3,}/);
    }
  });

  it("preserves content without headings as undefined section", () => {
    const text = "Just some plain text without any markdown headings.";
    const chunks = chunkText(text, defaults);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].metadata.section).toBeUndefined();
  });
});

describe("chunkPdfPages", () => {
  it("returns empty array for empty pages", () => {
    expect(chunkPdfPages([], defaults)).toEqual([]);
  });

  it("skips pages with empty text", () => {
    const pages = [
      { pageNum: 1, text: "" },
      { pageNum: 2, text: "Content on page 2." },
    ];
    const chunks = chunkPdfPages(pages, defaults);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].metadata.page).toBe(2);
  });

  it("assigns correct page numbers to chunks", () => {
    const pages = [
      { pageNum: 1, text: "Page one content." },
      { pageNum: 2, text: "Page two content." },
      { pageNum: 3, text: "Page three content." },
    ];
    const chunks = chunkPdfPages(pages, defaults);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].metadata.page).toBe(1);
    expect(chunks[1].metadata.page).toBe(2);
    expect(chunks[2].metadata.page).toBe(3);
  });

  it("splits long page text into multiple chunks", () => {
    const longText = "Sentence one. ".repeat(200);
    const pages = [{ pageNum: 1, text: longText }];
    const chunks = chunkPdfPages(pages, { chunkSize: 50, chunkOverlap: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.metadata.page).toBe(1);
    }
  });

  it("does not set section metadata for PDF chunks", () => {
    const pages = [{ pageNum: 1, text: "Some PDF content." }];
    const chunks = chunkPdfPages(pages, defaults);
    expect(chunks[0].metadata.section).toBeUndefined();
  });
});

describe("Chunk.metadata — file_path and parent_dir", () => {
  it("accepts file_path and parent_dir in chunk metadata", () => {
    const chunk: Chunk = {
      content: "some content",
      metadata: {
        section: "Intro",
        file_path: "docs/api/auth.md",
        parent_dir: "docs/api",
      },
    };
    expect(chunk.metadata.file_path).toBe("docs/api/auth.md");
    expect(chunk.metadata.parent_dir).toBe("docs/api");
  });

  it("file_path and parent_dir default to undefined when not set", () => {
    const chunks = chunkText("Hello world.", defaults);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].metadata.file_path).toBeUndefined();
    expect(chunks[0].metadata.parent_dir).toBeUndefined();
  });

  it("file_path can be stamped after chunking", () => {
    const chunks = chunkText("# Heading\n\nContent here.", defaults);
    const filePath = "engineering/backend/auth.md";
    const parentDir = dirname(filePath);

    for (const chunk of chunks) {
      chunk.metadata.file_path = filePath;
      chunk.metadata.parent_dir = parentDir;
    }

    expect(chunks[0].metadata.file_path).toBe("engineering/backend/auth.md");
    expect(chunks[0].metadata.parent_dir).toBe("engineering/backend");
    expect(chunks[0].metadata.section).toBe("Heading");
  });
});
