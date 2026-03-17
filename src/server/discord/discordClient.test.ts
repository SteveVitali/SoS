import { describe, expect, it } from "vitest";
import { splitForDiscord } from "./discordClient.js";

describe("splitForDiscord", () => {
  it("returns single chunk for short messages", () => {
    expect(splitForDiscord("Hello world")).toEqual(["Hello world"]);
  });

  it("returns single chunk for messages at exactly the limit", () => {
    const text = "a".repeat(2000);
    expect(splitForDiscord(text)).toEqual([text]);
  });

  it("splits at paragraph boundary for long messages", () => {
    const para1 = "a".repeat(1200);
    const para2 = "b".repeat(1200);
    const text = `${para1}\n\n${para2}`;
    const chunks = splitForDiscord(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(para1);
    expect(chunks[1]).toBe(para2);
  });

  it("splits at line boundary when no paragraph break available", () => {
    const line1 = "a".repeat(1200);
    const line2 = "b".repeat(1200);
    const text = `${line1}\n${line2}`;
    const chunks = splitForDiscord(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(line1);
    expect(chunks[1]).toBe(line2);
  });

  it("hard-splits when no line breaks available", () => {
    const text = "a".repeat(5000);
    const chunks = splitForDiscord(text);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(2000);
    expect(chunks[1]).toHaveLength(2000);
    expect(chunks[2]).toHaveLength(1000);
  });

  it("handles multiple splits for very long messages", () => {
    // 5 paragraphs of 800 chars each = 4000+ chars → needs 2-3 chunks
    const paras = Array.from({ length: 5 }, (_, i) => String.fromCharCode(97 + i).repeat(800));
    const text = paras.join("\n\n");
    const chunks = splitForDiscord(text);
    expect(chunks.length).toBeGreaterThan(1);
    // No chunk should exceed the limit
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
    // All content is preserved (join with separator to reconstruct)
    const reconstructed = chunks.join("\n\n");
    expect(reconstructed).toBe(text);
  });

  it("returns empty array for empty string", () => {
    expect(splitForDiscord("")).toEqual([""]);
  });
});
