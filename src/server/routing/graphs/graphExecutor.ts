/**
 * Bridge between the YAML-driven executor system and LangGraph graphs.
 *
 * This module:
 * 1. Reads the LangGraphExecution config from the YAML action definition
 * 2. Resolves which graph to run (currently just "corrective_rag")
 * 3. Passes the LLM provider + config into the graph
 * 4. Returns a CommandResult compatible with the existing executor interface
 */

import type { KBScope } from "../../../shared/kbTypes.js";
import { createLogger } from "../../../shared/logger.js";
import type { LLMProvider } from "../../llm/llmProvider.js";
import type { CommandContext, CommandResult } from "../../slack/commandExecutor.js";
import type { RoutedAction } from "../../slack/messageRouter.js";
import type { LangGraphExecution } from "../routingTypes.js";
import { renderTemplate, type TemplateContext } from "../template.js";
import { runCorrectiveRAG } from "./correctiveRag.js";
import type { GraphResult, RAGGraphConfig } from "./types.js";

const log = createLogger("server:routing:graphs:executor");

// ---------------------------------------------------------------------------
// Provider registry (initialized at server startup)
// ---------------------------------------------------------------------------

let llmProvider: LLMProvider | null = null;
let defaultModel = "claude-sonnet-4-20250514";

export function initGraphExecutor(provider: LLMProvider, model: string) {
  llmProvider = provider;
  defaultModel = model;
  log.info("Graph executor initialized", { model });
}

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
// Graph dispatch
// ---------------------------------------------------------------------------

async function runGraph(
  graphName: string,
  query: string,
  config: RAGGraphConfig,
): Promise<GraphResult> {
  if (!llmProvider) {
    throw new Error("Graph executor not initialized. Call initGraphExecutor() first.");
  }

  switch (graphName) {
    case "corrective_rag": {
      const result = await runCorrectiveRAG(llmProvider, query, {
        ...config,
        model: config.model ?? defaultModel,
      });

      return {
        reply: result.answer,
        actionTaken: `corrective_rag: ${result.retrievalRounds} rounds`,
        trace: result.trace,
        retrievalRounds: result.retrievalRounds,
      };
    }

    default:
      throw new Error(`Unknown graph: ${graphName}`);
  }
}

// ---------------------------------------------------------------------------
// Executor entry point (called from executors.ts)
// ---------------------------------------------------------------------------

export async function executeLangGraph(
  action: RoutedAction,
  ctx: CommandContext,
  execDef: LangGraphExecution,
): Promise<CommandResult> {
  const query = action.args.query || action.args.question || action.args.task_text || action.reply;

  if (!query || typeof query !== "string") {
    return {
      reply: "I need a question to search the knowledge bases. Could you rephrase?",
      actionTaken: "langgraph: no query",
    };
  }

  const showTrace = execDef.graph_config?.show_trace !== false;
  const timeoutMs = execDef.graph_config?.timeout_ms ?? Infinity;

  try {
    log.info("Executing LangGraph", {
      graph: execDef.graph,
      query: query.slice(0, 100),
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : "Infinity",
    });

    const graphConfig: RAGGraphConfig = {
      ...execDef.graph_config,
      scopes: execDef.graph_config?.scopes as KBScope[] | undefined,
    };

    // Run graph with optional timeout
    let result: GraphResult;
    if (Number.isFinite(timeoutMs)) {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Graph timed out after ${timeoutMs}ms`)), timeoutMs),
      );
      result = await Promise.race([runGraph(execDef.graph, query, graphConfig), timeout]);
    } else {
      result = await runGraph(execDef.graph, query, graphConfig);
    }

    log.info("LangGraph completed", {
      graph: execDef.graph,
      rounds: result.retrievalRounds,
      traceLength: result.trace.length,
      answerLength: result.reply.length,
      trace: result.trace,
    });

    // Use the reply template if provided, otherwise use the graph's raw answer
    let reply = execDef.reply_template
      ? renderTemplate(
          execDef.reply_template,
          tplCtx(action, ctx, {
            answer: result.reply,
            retrieval_rounds: result.retrievalRounds,
            trace: result.trace.join("\n"),
          }),
        )
      : result.reply;

    // Append trace summary footer when show_trace is enabled
    if (showTrace && result.trace.length > 0) {
      const reformulations = result.trace.filter((t) => t.startsWith("[reformulate]")).length;
      const chunks = result.trace
        .filter((t) => t.startsWith("[retrieve"))
        .reduce((sum, t) => {
          const match = t.match(/(\d+) chunks/);
          return sum + (match ? parseInt(match[1], 10) : 0);
        }, 0);
      const parts = [
        `${result.retrievalRounds} retrieval round${result.retrievalRounds !== 1 ? "s" : ""}`,
      ];
      if (chunks > 0) parts.push(`${chunks} chunks graded`);
      if (reformulations > 0) parts.push(`query reformulated ${reformulations}×`);
      reply += `\n\n_📎 ${parts.join(" | ")}_`;
    }

    // If the LLM's initial routing reply is meaningful, prepend it
    const finalReply =
      action.reply && action.reply !== "On it." ? `${action.reply}\n\n${reply}` : reply;

    return {
      reply: finalReply,
      actionTaken: result.actionTaken,
    };
  } catch (err: unknown) {
    log.error("LangGraph execution failed", {
      graph: execDef.graph,
      error: (err as Error).message,
    });

    const reply = execDef.reply_error
      ? renderTemplate(
          execDef.reply_error,
          tplCtx(action, ctx, {
            error: (err as Error).message,
          }),
        )
      : `⚠️ Knowledge base search failed: ${(err as Error).message}`;

    return {
      reply: action.reply ? `${action.reply}\n\n${reply}` : reply,
      actionTaken: `langgraph: ${execDef.graph} failed`,
    };
  }
}
