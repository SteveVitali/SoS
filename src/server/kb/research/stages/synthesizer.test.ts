import { describe, expect, it } from "vitest";
import type { KBSearchResult } from "../../../../shared/kbTypes.js";
import type { ResearchConfig } from "../../../../shared/researchTypes.js";
import { AuditEmitter } from "../auditLog.js";
import { runSynthesizer } from "./synthesizer.js";

function makeConfig(overrides: Partial<ResearchConfig> = {}): ResearchConfig {
  return {
    strategy: "simple",
    max_iterations: 1,
    max_llm_calls: 5,
    max_retrieval_calls: 10,
    max_wall_time_ms: 30000,
    enable_decomposition: false,
    enable_hyde: true,
    enable_step_back: false,
    enable_crag: false,
    enable_ircot: false,
    max_chunks_per_query: 5,
    min_similarity_score: 0.3,
    dedup_threshold: 0.9,
    ...overrides,
  };
}

function makeChunk(overrides: Partial<KBSearchResult> = {}): KBSearchResult {
  return {
    content: "Test chunk content about TypeScript patterns.",
    source_file: "docs/patterns.md",
    kb_name: "Design Docs",
    kb_id: "kb-1",
    score: 0.85,
    metadata: { section: "Introduction" },
    ...overrides,
  };
}

describe("synthesizer", () => {
  it("returns empty context for no chunks", () => {
    const config = makeConfig();
    const audit = new AuditEmitter("q", ["chat"], config);
    const recorder = audit.startStep("synthesis", 0);

    const result = runSynthesizer("test query", [], "", config, recorder);
    expect(result.context).toBe("");
    expect(result.chunks_used).toEqual([]);
  });

  it("formats chunks with numbered citations", () => {
    const config = makeConfig();
    const audit = new AuditEmitter("q", ["chat"], config);
    const recorder = audit.startStep("synthesis", 0);
    const chunks = [
      makeChunk({ score: 0.9, content: "First chunk" }),
      makeChunk({ score: 0.8, content: "Second chunk", source_file: "other.md", metadata: {} }),
    ];

    const result = runSynthesizer("test query", chunks, "", config, recorder);
    expect(result.context).toContain("[1]");
    expect(result.context).toContain("[2]");
    expect(result.context).toContain("First chunk");
    expect(result.context).toContain("Second chunk");
    expect(result.context).toContain("Design Docs");
    expect(result.chunks_used).toHaveLength(2);
  });

  it("includes reasoning trace for deep strategy", () => {
    const config = makeConfig({ strategy: "deep" });
    const audit = new AuditEmitter("q", ["chat"], config);
    const recorder = audit.startStep("synthesis", 0);
    const chunks = [makeChunk()];

    const result = runSynthesizer("q", chunks, "Deep reasoning here", config, recorder);
    expect(result.context).toContain("Research Reasoning");
    expect(result.context).toContain("Deep reasoning here");
    expect(result.reasoning_trace).toBe("Deep reasoning here");
  });

  it("omits reasoning trace for simple strategy", () => {
    const config = makeConfig({ strategy: "simple" });
    const audit = new AuditEmitter("q", ["chat"], config);
    const recorder = audit.startStep("synthesis", 0);
    const chunks = [makeChunk()];

    const result = runSynthesizer("q", chunks, "Reasoning text", config, recorder);
    expect(result.context).not.toContain("Research Reasoning");
  });

  it("respects max_chunks_per_query limit", () => {
    const config = makeConfig({ max_chunks_per_query: 2 });
    const audit = new AuditEmitter("q", ["chat"], config);
    const recorder = audit.startStep("synthesis", 0);
    const chunks = [
      makeChunk({ score: 0.9 }),
      makeChunk({ score: 0.8 }),
      makeChunk({ score: 0.7 }),
      makeChunk({ score: 0.6 }),
    ];

    const result = runSynthesizer("q", chunks, "", config, recorder);
    expect(result.chunks_used).toHaveLength(2);
  });

  it("includes strategy name in context", () => {
    const config = makeConfig({ strategy: "deep" });
    const audit = new AuditEmitter("q", ["chat"], config);
    const recorder = audit.startStep("synthesis", 0);
    const chunks = [makeChunk()];

    const result = runSynthesizer("q", chunks, "", config, recorder);
    expect(result.context).toContain("deep");
  });
});
