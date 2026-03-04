/**
 * ReAct Research Agent loop (Phase 4).
 * Uses LLM with tool-calling to dynamically decide what to search,
 * when to evaluate, and when to synthesize.
 */

import type { KBScope } from "../../../../shared/kbTypes.js";
import { createLogger } from "../../../../shared/logger.js";
import type {
  ResearchConfig,
  ResearchConsumer,
  ResearchResult,
  ResearchStreamEvent,
} from "../../../../shared/researchTypes.js";
import { listEnabledKBsByScope } from "../../kbRepo.js";
import { AuditEmitter } from "../auditLog.js";
import { saveResearchSession } from "../auditRepo.js";
import { type ChatMessage, getResearchLLMClient, type ToolCall } from "../llmClient.js";
import { chunkKey } from "../pipeline.js";
import { runSynthesizer } from "../stages/synthesizer.js";
import { buildAgentSystemPrompt } from "./agentPrompts.js";
import { AGENT_TOOL_DEFINITIONS, type AgentToolContext, executeAgentTool } from "./agentTools.js";

const log = createLogger("server:kb:research:agent");

export async function runResearchAgent(
  query: string,
  scopes: KBScope[],
  config: ResearchConfig,
  options?: {
    owner?: string;
    consumer?: ResearchConsumer;
    onEvent?: (event: ResearchStreamEvent) => void;
  },
): Promise<ResearchResult> {
  const { owner, consumer, onEvent } = options ?? {};
  const audit = new AuditEmitter(query, scopes, config, consumer, onEvent);
  const llm = getResearchLLMClient();

  const kbs = await listEnabledKBsByScope(scopes, owner);
  const systemPrompt = buildAgentSystemPrompt(query, kbs, config.max_iterations);

  const toolCtx: AgentToolContext = {
    scopes,
    config,
    accumulatedChunks: [],
    owner,
  };

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: query },
  ];

  let synthesizeSummary: string | undefined;

  try {
    for (let turn = 0; turn < config.max_iterations; turn++) {
      // Budget check
      const session = audit.getSession();
      const llmCalls = session.steps.flatMap((s) => s.llm_calls).length;
      const elapsed = Date.now() - session.created_at.getTime();
      if (llmCalls >= config.max_llm_calls || elapsed >= config.max_wall_time_ms) {
        log.warn("Agent budget exhausted", { turn, llmCalls, elapsed });
        break;
      }

      // Ask LLM what to do next
      const stepRecorder = audit.startStep("reasoning", turn);
      const response = await llm.chatWithTools(messages, AGENT_TOOL_DEFINITIONS);

      stepRecorder.recordLLMCall(
        llm.toAuditRecord(response, "reasoning", `agent_turn_${turn}`, query),
      );

      // If the LLM returned text content (thinking), add it to history
      if (response.content) {
        messages.push({ role: "assistant", content: response.content });
      }

      // If no tool calls, the agent is done
      if (response.tool_calls.length === 0) {
        stepRecorder.recordOutput({
          action: "no_tool_calls",
          content: response.content?.slice(0, 200),
        });
        stepRecorder.finish({ action: "stop" });
        break;
      }

      // Build assistant message with tool calls for conversation history
      // (OpenAI format: assistant message carries tool_calls)
      const assistantMsg: ChatMessage & { tool_calls?: ToolCall[] } = {
        role: "assistant",
        content: response.content || "",
      };
      assistantMsg.tool_calls = response.tool_calls;
      messages.push(assistantMsg);

      let shouldStop = false;

      // Execute each tool call
      for (const tc of response.tool_calls) {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(tc.function.arguments);
        } catch {
          parsedArgs = {};
        }

        const toolRecorder = audit.startStep("retrieval", turn);
        toolRecorder.recordInput({
          tool: tc.function.name,
          args: parsedArgs,
        });

        const { result, chunks } = await executeAgentTool(tc.function.name, parsedArgs, toolCtx);

        // Accumulate any retrieved chunks
        if (chunks) {
          for (const chunk of chunks) {
            const key = chunkKey(chunk);
            const exists = toolCtx.accumulatedChunks.some((c) => chunkKey(c) === key);
            if (!exists) {
              toolCtx.accumulatedChunks.push(chunk);
            }
          }
        }

        toolRecorder.recordOutput({
          tool: tc.function.name,
          result_preview: result.slice(0, 300),
          chunks_added: chunks?.length ?? 0,
        });
        toolRecorder.finish({
          tool: tc.function.name,
          chunks: chunks?.length ?? 0,
        });

        // Add tool result to conversation history
        messages.push({
          role: "tool",
          content: result,
          tool_call_id: tc.id,
        });

        // Check if synthesize_answer was called
        if (tc.function.name === "synthesize_answer") {
          synthesizeSummary = result;
          shouldStop = true;
        }
      }

      stepRecorder.recordOutput({
        turn,
        tool_calls: response.tool_calls.map((tc) => tc.function.name),
        accumulated_chunks: toolCtx.accumulatedChunks.length,
      });
      stepRecorder.finish({
        turn,
        tools: response.tool_calls.map((tc) => tc.function.name).join(", "),
      });

      if (shouldStop) break;
    }

    // Synthesize final context
    const synthRecorder = audit.startStep("synthesis", 0);
    const synthesis = runSynthesizer(
      query,
      toolCtx.accumulatedChunks,
      synthesizeSummary || "",
      config,
      synthRecorder,
    );

    const session = audit.complete();
    const metrics = audit.computeMetrics();
    metrics.chunks_used = synthesis.chunks_used.length;

    await persistSession(session);

    return {
      session_id: session.session_id,
      strategy: config.strategy,
      original_query: query,
      context: synthesis.context,
      chunks: synthesis.chunks_used,
      reasoning_trace: synthesis.reasoning_trace,
      metrics,
      audit: session,
    };
  } catch (err) {
    const session = audit.fail((err as Error).message);
    await persistSession(session);
    throw err;
  }
}

async function persistSession(session: { session_id: string }): Promise<void> {
  try {
    await saveResearchSession(session as Parameters<typeof saveResearchSession>[0]);
  } catch (err) {
    log.warn("Failed to persist research session", {
      session_id: session.session_id,
      error: (err as Error).message,
    });
  }
}
