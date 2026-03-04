import { describe, expect, it } from "vitest";
import type { KBSearchResult } from "../../../shared/kbTypes.js";
import { BudgetExhaustedError, chunkKey } from "./pipeline.js";

describe("pipeline utilities", () => {
  describe("chunkKey", () => {
    it("produces a stable key from kb_id, source_file, and content prefix", () => {
      const chunk: KBSearchResult = {
        content:
          "Hello world content that is fairly long and exceeds the 100 char limit used by the key",
        source_file: "readme.md",
        kb_name: "docs",
        kb_id: "kb-1",
        score: 0.9,
        metadata: {},
      };
      const key = chunkKey(chunk);
      expect(key).toBe(`kb-1:readme.md:${chunk.content.slice(0, 100)}`);
    });

    it("returns identical keys for chunks differing only after 100 chars", () => {
      const base = {
        source_file: "file.md",
        kb_name: "docs",
        kb_id: "kb-1",
        score: 0.8,
        metadata: {},
      };
      const prefix = "x".repeat(100);
      const a: KBSearchResult = { ...base, content: `${prefix}AAAA` };
      const b: KBSearchResult = { ...base, content: `${prefix}BBBB` };
      expect(chunkKey(a)).toBe(chunkKey(b));
    });

    it("returns different keys for different kb_ids", () => {
      const base = {
        content: "same content",
        source_file: "file.md",
        kb_name: "docs",
        score: 0.8,
        metadata: {},
      };
      const a: KBSearchResult = { ...base, kb_id: "kb-1" };
      const b: KBSearchResult = { ...base, kb_id: "kb-2" };
      expect(chunkKey(a)).not.toBe(chunkKey(b));
    });
  });

  describe("BudgetExhaustedError", () => {
    it("has the correct name and resource", () => {
      const err = new BudgetExhaustedError("llm_calls");
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("BudgetExhaustedError");
      expect(err.resource).toBe("llm_calls");
      expect(err.message).toContain("llm_calls");
    });

    it("supports all three resource types", () => {
      for (const resource of ["llm_calls", "retrieval_calls", "wall_time"] as const) {
        const err = new BudgetExhaustedError(resource);
        expect(err.resource).toBe(resource);
      }
    });
  });
});
