import { describe, expect, it } from "vitest";
import {
  buildChunkDocId,
  getAllChunks,
  getChunkForDate,
  isCurrentChunk,
  parseChunkConfig,
  toDateStr,
} from "./chunks.js";

const EPOCH = new Date("2024-01-01T00:00:00Z");
const CHUNK_DAYS = 28;

describe("getChunkForDate", () => {
  it("returns the chunk containing the epoch date itself", () => {
    const chunk = getChunkForDate(new Date("2024-01-01"), EPOCH, CHUNK_DAYS);
    expect(chunk.start).toBe("2024-01-01");
    expect(chunk.end).toBe("2024-01-29");
    expect(chunk.id).toBe("2024-01-01..2024-01-29");
  });

  it("returns the correct chunk for a date mid-chunk", () => {
    const chunk = getChunkForDate(new Date("2024-01-15"), EPOCH, CHUNK_DAYS);
    expect(chunk.start).toBe("2024-01-01");
    expect(chunk.end).toBe("2024-01-29");
  });

  it("returns the next chunk for the first day after a chunk boundary", () => {
    const chunk = getChunkForDate(new Date("2024-01-29"), EPOCH, CHUNK_DAYS);
    expect(chunk.start).toBe("2024-01-29");
    expect(chunk.end).toBe("2024-02-26");
  });

  it("handles dates before the epoch (negative chunk indices)", () => {
    const chunk = getChunkForDate(new Date("2023-12-15"), EPOCH, CHUNK_DAYS);
    expect(chunk.start).toBe("2023-12-04");
    expect(chunk.end).toBe("2024-01-01");
  });

  it("produces deterministic chunk IDs regardless of time-of-day", () => {
    const morning = getChunkForDate(new Date("2024-03-05T08:00:00Z"), EPOCH, CHUNK_DAYS);
    const evening = getChunkForDate(new Date("2024-03-05T22:00:00Z"), EPOCH, CHUNK_DAYS);
    expect(morning.id).toBe(evening.id);
  });
});

describe("getAllChunks", () => {
  it("returns correct number of chunks for a 56-day span", () => {
    const since = new Date("2024-01-01");
    const now = new Date("2024-02-26"); // 56 days = 2 chunks
    const chunks = getAllChunks(since, now, EPOCH, CHUNK_DAYS);
    expect(chunks.length).toBe(2);
    expect(chunks[0].start).toBe("2024-01-01");
    expect(chunks[1].start).toBe("2024-01-29");
  });

  it("includes partial current chunk", () => {
    const since = new Date("2024-01-01");
    const now = new Date("2024-02-10"); // mid-second chunk
    const chunks = getAllChunks(since, now, EPOCH, CHUNK_DAYS);
    expect(chunks.length).toBe(2);
  });

  it("returns 1 chunk for a range within a single chunk", () => {
    const since = new Date("2024-01-05");
    const now = new Date("2024-01-20");
    const chunks = getAllChunks(since, now, EPOCH, CHUNK_DAYS);
    expect(chunks.length).toBe(1);
  });

  it("generates roughly 13 chunks for 365 days", () => {
    const since = new Date("2024-01-01");
    const now = new Date("2025-01-01");
    const chunks = getAllChunks(since, now, EPOCH, CHUNK_DAYS);
    // 365 / 28 = ~13.04 chunks
    expect(chunks.length).toBeGreaterThanOrEqual(13);
    expect(chunks.length).toBeLessThanOrEqual(14);
  });

  it("returns chunks in chronological order", () => {
    const since = new Date("2024-01-01");
    const now = new Date("2024-06-01");
    const chunks = getAllChunks(since, now, EPOCH, CHUNK_DAYS);
    for (let i = 1; i < chunks.length; i++) {
      expect(new Date(chunks[i].start).getTime()).toBeGreaterThan(
        new Date(chunks[i - 1].start).getTime(),
      );
    }
  });
});

describe("isCurrentChunk", () => {
  it("returns true for the chunk containing the given date", () => {
    const chunk = getChunkForDate(new Date("2024-02-10"), EPOCH, CHUNK_DAYS);
    expect(isCurrentChunk(chunk, new Date("2024-02-10"))).toBe(true);
  });

  it("returns false for a historical chunk", () => {
    const chunk = getChunkForDate(new Date("2024-01-01"), EPOCH, CHUNK_DAYS);
    expect(isCurrentChunk(chunk, new Date("2024-03-01"))).toBe(false);
  });
});

describe("buildChunkDocId", () => {
  it("produces the expected format", () => {
    const id = buildChunkDocId("prs", "MyOrganization", "2024-01-01..2024-01-29");
    expect(id).toBe("prs:MyOrganization:2024-01-01..2024-01-29");
  });
});

describe("toDateStr", () => {
  it("formats a Date as YYYY-MM-DD", () => {
    expect(toDateStr(new Date("2024-07-15T12:34:56Z"))).toBe("2024-07-15");
  });
});

describe("parseChunkConfig", () => {
  it("returns defaults when no options are provided", () => {
    const config = parseChunkConfig();
    expect(config.epochDate).toEqual(new Date("2024-01-01T00:00:00Z"));
    expect(config.chunkDays).toBe(28);
    expect(config.historyDays).toBe(365);
  });

  it("respects provided overrides", () => {
    const config = parseChunkConfig({
      epochDate: "2023-06-01",
      chunkDays: 14,
      historyDays: 180,
    });
    expect(config.epochDate).toEqual(new Date("2023-06-01T00:00:00Z"));
    expect(config.chunkDays).toBe(14);
    expect(config.historyDays).toBe(180);
  });
});
