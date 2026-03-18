import { describe, expect, it } from "vitest";
import { estimateTokens, serializeContext } from "./contextSerializer.js";
import type { ContextItem } from "./contextTypes.js";

function makeItem(overrides?: Partial<ContextItem>): ContextItem {
  return {
    id: "test-1",
    content: "Test content here",
    source: "kb",
    raw_score: 0.85,
    metadata: {
      kb_name: "Test KB",
      temporal_tag: "Test KB > file.md",
    },
    ...overrides,
  };
}

describe("estimateTokens", () => {
  it("estimates ~4 chars per token", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("serializeContext", () => {
  it("serializes KB items with source tags", () => {
    const items = [makeItem({ content: "Auth module docs" })];
    const { context } = serializeContext(items, 1000);
    expect(context).toContain("Auth module docs");
    expect(context).toContain("Test KB > file.md");
  });

  it("serializes memory items with temporal tags", () => {
    const items = [
      makeItem({
        source: "memory",
        content: "User prefers strict TS",
        metadata: { memory_type: "fact", temporal_tag: "fact, learned Mar 15" },
      }),
    ];
    const { context } = serializeContext(items, 1000);
    expect(context).toContain("User prefers strict TS");
    expect(context).toContain("fact, learned Mar 15");
  });

  it("respects token budget", () => {
    const longContent = "x".repeat(4000); // ~1000 tokens
    const items = [
      makeItem({ id: "1", content: longContent }),
      makeItem({ id: "2", content: longContent }),
      makeItem({ id: "3", content: longContent }),
    ];
    const { context, itemsUsed } = serializeContext(items, 1500);
    // Should only fit 1 item (1000 tokens) not all 3
    expect(itemsUsed).toBeLessThan(3);
    expect(estimateTokens(context)).toBeLessThanOrEqual(1500);
  });

  it("returns empty for empty items", () => {
    const result = serializeContext([], 1000);
    expect(result.context).toBe("");
    expect(result.itemsUsed).toBe(0);
    expect(result.kbItemsUsed).toBe(0);
    expect(result.memoryItemsUsed).toBe(0);
  });

  it("counts KB and memory items separately", () => {
    const items = [
      makeItem({ id: "kb-1", source: "kb", content: "KB content" }),
      makeItem({
        id: "mem-1",
        source: "memory",
        content: "Memory content",
        metadata: { memory_type: "fact", temporal_tag: "fact, learned Mar 1" },
      }),
      makeItem({ id: "kb-2", source: "kb", content: "More KB content" }),
    ];
    const result = serializeContext(items, 5000);
    expect(result.kbItemsUsed).toBe(2);
    expect(result.memoryItemsUsed).toBe(1);
    expect(result.itemsUsed).toBe(3);
  });

  it("preserves item order from input", () => {
    const items = [
      makeItem({ id: "1", content: "First item", metadata: { temporal_tag: "tag1" } }),
      makeItem({ id: "2", content: "Second item", metadata: { temporal_tag: "tag2" } }),
    ];
    const { context } = serializeContext(items, 5000);
    const firstIdx = context.indexOf("First item");
    const secondIdx = context.indexOf("Second item");
    expect(firstIdx).toBeLessThan(secondIdx);
  });
});
