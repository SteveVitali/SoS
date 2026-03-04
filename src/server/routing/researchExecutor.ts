/**
 * Executor for the "research" execution type.
 *
 * Bridges the YAML-driven routing system to the advanced research pipeline
 * (src/server/kb/research/pipeline.ts), replacing the old LangGraph-based
 * corrective RAG executor.
 *
 * Unlike the LangGraph executor, this module does NOT need its own LLM
 * provider — the research pipeline manages its own LLM client internally.
 */

import type { KBScope } from "../../shared/kbTypes.js";
import { createLogger } from "../../shared/logger.js";
import type { ResearchStrategy } from "../../shared/researchTypes.js";
import { researchKnowledgeBases } from "../kb/kbService.js";
import type { CommandContext, CommandResult } from "../slack/commandExecutor.js";
import type { RoutedAction } from "../slack/messageRouter.js";
import type { ResearchExecution } from "./routingTypes.js";
import { renderTemplate, type TemplateContext } from "./template.js";

const log = createLogger("server:routing:research-executor");

const VALID_STRATEGIES: ResearchStrategy[] = ["simple", "deep", "agent"];

// ---------------------------------------------------------------------------
// Template context helper
// ---------------------------------------------------------------------------

function tplCtx(
  action: RoutedAction,
  ctx: CommandContext,
  extra?: Record<string, unknown>,
): TemplateContext {
  return {
    args: action.args,
    ctx: {
      user_id: ctx.userId,
      owner_id: ctx.ownerId,
    },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Executor entry point (called from executors.ts)
// ---------------------------------------------------------------------------

export async function executeResearch(
  action: RoutedAction,
  ctx: CommandContext,
  execDef: ResearchExecution,
): Promise<CommandResult> {
  const query = action.args.query || action.args.question || action.args.task_text || action.reply;

  if (!query || typeof query !== "string") {
    return {
      reply: "I need a question to search the knowledge bases. Could you rephrase?",
      actionTaken: "research: no query",
    };
  }

  // Resolve strategy: prefer the LLM-selected value, fall back to YAML default, then "simple"
  const rawStrategy = action.args.strategy;
  const strategy: ResearchStrategy =
    typeof rawStrategy === "string" && VALID_STRATEGIES.includes(rawStrategy as ResearchStrategy)
      ? (rawStrategy as ResearchStrategy)
      : (execDef.default_strategy ?? "simple");

  const scopes = (execDef.scopes ?? ["chat", "all"]) as KBScope[];
  const showTrace = execDef.show_trace !== false;
  const timeoutMs = execDef.timeout_ms ?? Infinity;

  try {
    log.info("Executing research pipeline", {
      strategy,
      query: query.slice(0, 100),
      scopes,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : "Infinity",
    });

    // Run research with optional timeout
    let resultPromise = researchKnowledgeBases({
      query,
      scopes,
      strategy,
      consumer: { type: "chat", id: `routing:${ctx.userId}` },
      owner: ctx.ownerId,
    });

    if (Number.isFinite(timeoutMs)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Research timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      });
      resultPromise = Promise.race([resultPromise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
      });
    }

    const result = await resultPromise;

    log.info("Research pipeline completed", {
      strategy: result.strategy,
      session_id: result.session_id,
      chunks: result.chunks.length,
      context_length: result.context.length,
      metrics: result.metrics,
    });

    // Build the reply from the synthesized context
    let reply = execDef.reply_template
      ? renderTemplate(
          execDef.reply_template,
          tplCtx(action, ctx, {
            answer: result.context,
            strategy: result.strategy,
            session_id: result.session_id,
            iterations: result.metrics.iterations,
            retrieval_calls: result.metrics.retrieval_calls,
            chunks_used: result.metrics.chunks_used,
            total_duration_ms: result.metrics.total_duration_ms,
          }),
        )
      : result.context;

    // Append trace/metrics footer when show_trace is enabled
    if (showTrace && result.metrics) {
      const m = result.metrics;
      const parts = [
        `strategy: ${result.strategy}`,
        `${m.retrieval_calls} retrieval${m.retrieval_calls !== 1 ? "s" : ""}`,
        `${m.chunks_used} chunks used`,
      ];
      if (m.iterations > 1) parts.push(`${m.iterations} iterations`);
      if (m.total_duration_ms > 0) parts.push(`${(m.total_duration_ms / 1000).toFixed(1)}s`);
      reply += `\n\n_📎 ${parts.join(" | ")}_`;
    }

    // If the LLM's initial routing reply is meaningful, prepend it
    const finalReply =
      action.reply && action.reply !== "On it." ? `${action.reply}\n\n${reply}` : reply;

    return {
      reply: finalReply,
      actionTaken: `research:${result.strategy} session=${result.session_id}`,
    };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    log.error("Research pipeline failed", {
      strategy,
      error: errorMessage,
    });

    const errorReply = execDef.reply_error
      ? renderTemplate(execDef.reply_error, tplCtx(action, ctx, { error: errorMessage }))
      : `⚠️ Knowledge base search failed: ${errorMessage}`;

    const finalErrorReply =
      action.reply && action.reply !== "On it." ? `${action.reply}\n\n${errorReply}` : errorReply;

    return {
      reply: finalErrorReply,
      actionTaken: `research:${strategy} failed`,
    };
  }
}
