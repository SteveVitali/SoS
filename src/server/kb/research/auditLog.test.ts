import { describe, expect, it } from "vitest";
import type { ResearchConfig } from "../../../shared/researchTypes.js";
import { AuditEmitter, StepRecorder } from "./auditLog.js";

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

describe("AuditEmitter", () => {
  it("creates a session with unique ID and running status", () => {
    const audit = new AuditEmitter("test query", ["chat"], makeConfig());
    const session = audit.getSession();
    expect(session.session_id).toBeTruthy();
    expect(session.original_query).toBe("test query");
    expect(session.status).toBe("running");
    expect(session.steps).toEqual([]);
  });

  it("emits session_start event on construction", () => {
    const events: any[] = [];
    new AuditEmitter("q", ["chat"], makeConfig(), undefined, (e) => events.push(e));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("session_start");
    expect(events[0].strategy).toBe("simple");
  });

  it("startStep creates a StepRecorder", () => {
    const audit = new AuditEmitter("q", ["chat"], makeConfig());
    const recorder = audit.startStep("query_analysis", 0);
    expect(recorder).toBeInstanceOf(StepRecorder);
  });

  it("complete() sets status to completed", () => {
    const audit = new AuditEmitter("q", ["chat"], makeConfig());
    const session = audit.complete();
    expect(session.status).toBe("completed");
    expect(session.completed_at).toBeDefined();
  });

  it("fail() sets status to failed", () => {
    const audit = new AuditEmitter("q", ["chat"], makeConfig());
    const session = audit.fail("something broke");
    expect(session.status).toBe("failed");
  });

  it("budgetExhausted() sets status to budget_exhausted", () => {
    const audit = new AuditEmitter("q", ["chat"], makeConfig());
    const session = audit.budgetExhausted();
    expect(session.status).toBe("budget_exhausted");
  });

  it("computeMetrics aggregates LLM and retrieval stats", () => {
    const audit = new AuditEmitter("q", ["chat"], makeConfig());

    const recorder = audit.startStep("query_analysis", 0);
    recorder.recordLLMCall({
      call_id: "c1",
      stage: "query_analysis",
      purpose: "test",
      model: "gpt-4o-mini",
      prompt_tokens: 100,
      completion_tokens: 50,
      cost_usd: 0.001,
      duration_ms: 200,
      input_preview: "input",
      output_preview: "output",
    });
    recorder.recordRetrieval({
      call_id: "r1",
      query_text: "test",
      query_type: "original",
      kb_ids_searched: ["kb1"],
      results_count: 3,
      top_score: 0.8,
      duration_ms: 100,
    });
    recorder.finish();

    const metrics = audit.computeMetrics();
    expect(metrics.llm_calls).toBe(1);
    expect(metrics.retrieval_calls).toBe(1);
    expect(metrics.prompt_tokens).toBe(100);
    expect(metrics.completion_tokens).toBe(50);
    expect(metrics.chunks_retrieved).toBe(3);
    expect(metrics.estimated_cost_usd).toBe(0.001);
  });
});

describe("StepRecorder", () => {
  it("records input and output", () => {
    const audit = new AuditEmitter("q", ["chat"], makeConfig());
    const recorder = audit.startStep("retrieval", 0);
    recorder.recordInput({ foo: "bar" });
    recorder.recordOutput({ result: 42 });
    const step = recorder.finish();
    expect(step.input).toEqual({ foo: "bar" });
    expect(step.output).toEqual({ result: 42 });
    expect(step.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("finish adds step to session", () => {
    const audit = new AuditEmitter("q", ["chat"], makeConfig());
    const recorder = audit.startStep("synthesis", 0);
    recorder.finish();
    expect(audit.getSession().steps).toHaveLength(1);
    expect(audit.getSession().steps[0].stage).toBe("synthesis");
  });

  it("emits step events", () => {
    const events: any[] = [];
    const audit = new AuditEmitter("q", ["chat"], makeConfig(), undefined, (e) => events.push(e));
    const recorder = audit.startStep("evaluation", 1);
    recorder.finish({ score: 5 });

    const stepStart = events.find((e) => e.type === "step_start");
    expect(stepStart).toBeDefined();
    expect(stepStart.stage).toBe("evaluation");
    expect(stepStart.iteration).toBe(1);

    const stepComplete = events.find((e) => e.type === "step_complete");
    expect(stepComplete).toBeDefined();
    expect(stepComplete.details).toEqual({ score: 5 });
  });
});
