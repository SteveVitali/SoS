/**
 * Audit logging for research pipeline sessions.
 * Provides AuditEmitter (session-level) and StepRecorder (step-level) for
 * structured recording of every decision, LLM call, and retrieval.
 */

import { v4 as uuidv4 } from "uuid";
import type { KBScope } from "../../../shared/kbTypes.js";
import { createLogger } from "../../../shared/logger.js";
import type {
  LLMCallRecord,
  ResearchConfig,
  ResearchConsumer,
  ResearchMetrics,
  ResearchSession,
  ResearchStage,
  ResearchStep,
  ResearchStreamEvent,
  RetrievalRecord,
} from "../../../shared/researchTypes.js";

const log = createLogger("server:kb:research:audit");

// ─── StepRecorder ───────────────────────────────────────────────

export class StepRecorder {
  private startTime = Date.now();
  private step: ResearchStep;

  constructor(
    stage: ResearchStage,
    iteration: number,
    private session: ResearchSession,
    private onEvent?: (event: ResearchStreamEvent) => void,
  ) {
    this.step = {
      step_id: uuidv4(),
      stage,
      iteration,
      input: {},
      output: {},
      duration_ms: 0,
      llm_calls: [],
      retrieval_calls: [],
    };
    this.onEvent?.({ type: "step_start", stage, iteration });
  }

  recordInput(input: Record<string, unknown> | object): void {
    this.step.input = input as Record<string, unknown>;
  }

  recordOutput(output: Record<string, unknown> | object): void {
    this.step.output = output as Record<string, unknown>;
  }

  recordLLMCall(call: LLMCallRecord): void {
    this.step.llm_calls.push(call);
    this.onEvent?.({
      type: "llm_call",
      purpose: call.purpose,
      duration_ms: call.duration_ms,
      model: call.model,
    });
  }

  recordRetrieval(call: RetrievalRecord): void {
    this.step.retrieval_calls.push(call);
    this.onEvent?.({
      type: "retrieval",
      kb: call.kb_ids_searched.join(", "),
      results: call.results_count,
      top_score: call.top_score,
      vector_hits: call.vector_hits,
      keyword_hits: call.keyword_hits,
      both_hits: call.both_hits,
    });
  }

  finish(details?: Record<string, unknown>): ResearchStep {
    this.step.duration_ms = Date.now() - this.startTime;
    this.session.steps.push(this.step);
    this.onEvent?.({
      type: "step_complete",
      stage: this.step.stage,
      duration_ms: this.step.duration_ms,
      details,
    });
    return this.step;
  }
}

// ─── AuditEmitter ───────────────────────────────────────────────

export class AuditEmitter {
  private session: ResearchSession;
  private onEvent?: (event: ResearchStreamEvent) => void;

  constructor(
    query: string,
    scopes: KBScope[],
    config: ResearchConfig,
    consumer?: ResearchConsumer,
    onEvent?: (event: ResearchStreamEvent) => void,
  ) {
    this.onEvent = onEvent;
    this.session = {
      session_id: uuidv4(),
      original_query: query,
      scopes,
      config,
      steps: [],
      status: "running",
      consumer,
      created_at: new Date(),
    };
    this.onEvent?.({
      type: "session_start",
      session_id: this.session.session_id,
      strategy: config.strategy,
    });
    log.info("Research session started", {
      session_id: this.session.session_id,
      strategy: config.strategy,
      query: query.slice(0, 200),
    });
  }

  get sessionId(): string {
    return this.session.session_id;
  }

  startStep(stage: ResearchStage, iteration: number): StepRecorder {
    return new StepRecorder(stage, iteration, this.session, this.onEvent);
  }

  complete(): ResearchSession {
    this.session.status = "completed";
    this.session.completed_at = new Date();
    const metrics = this.computeMetrics();
    this.onEvent?.({
      type: "session_complete",
      session_id: this.session.session_id,
      total_ms: metrics.total_duration_ms,
      llm_calls: metrics.llm_calls,
      cost_usd: metrics.estimated_cost_usd,
    });
    log.info("Research session completed", {
      session_id: this.session.session_id,
      ...metrics,
    });
    return this.session;
  }

  fail(error: string): ResearchSession {
    this.session.status = "failed";
    this.session.completed_at = new Date();
    this.onEvent?.({
      type: "session_error",
      session_id: this.session.session_id,
      error,
    });
    log.error("Research session failed", {
      session_id: this.session.session_id,
      error,
    });
    return this.session;
  }

  budgetExhausted(): ResearchSession {
    this.session.status = "budget_exhausted";
    this.session.completed_at = new Date();
    const metrics = this.computeMetrics();
    this.onEvent?.({
      type: "session_complete",
      session_id: this.session.session_id,
      total_ms: metrics.total_duration_ms,
      llm_calls: metrics.llm_calls,
      cost_usd: metrics.estimated_cost_usd,
    });
    log.warn("Research session budget exhausted", {
      session_id: this.session.session_id,
      ...metrics,
    });
    return this.session;
  }

  getSession(): ResearchSession {
    return this.session;
  }

  computeMetrics(): ResearchMetrics {
    const allLLM = this.session.steps.flatMap((s) => s.llm_calls);
    const allRetrieval = this.session.steps.flatMap((s) => s.retrieval_calls);
    const totalDuration = this.session.completed_at
      ? this.session.completed_at.getTime() - this.session.created_at.getTime()
      : Date.now() - this.session.created_at.getTime();

    const maxIteration = this.session.steps.reduce((max, s) => Math.max(max, s.iteration), 0);

    return {
      total_duration_ms: totalDuration,
      iterations: maxIteration + 1,
      llm_calls: allLLM.length,
      retrieval_calls: allRetrieval.length,
      chunks_retrieved: allRetrieval.reduce((sum, r) => sum + r.results_count, 0),
      chunks_used: 0, // set by synthesizer
      prompt_tokens: allLLM.reduce((sum, c) => sum + c.prompt_tokens, 0),
      completion_tokens: allLLM.reduce((sum, c) => sum + c.completion_tokens, 0),
      estimated_cost_usd: allLLM.reduce((sum, c) => sum + (c.cost_usd ?? 0), 0),
    };
  }
}
