import type { KBScope, KBSearchResult } from "../../shared/kbTypes.js";
import { formatPathBreadcrumb } from "../../shared/kbUtils.js";
import { createLogger } from "../../shared/logger.js";
import { getModelForRole } from "../../shared/modelConfig.js";
import type { ResearchStrategy } from "../../shared/researchTypes.js";
import type { JobAttachment } from "../../shared/types.js";
import { assembleContext } from "../context/index.js";
import { queryJobs } from "../jobs/jobService.js";
import { researchKnowledgeBases, searchKnowledgeBases } from "../kb/kbService.js";
import type { ContentBlock, LLMProvider, ToolDefinition } from "../llm/index.js";
import { getMemoryContext } from "../memory/index.js";
import {
  buildActionsPromptSection,
  buildToolsFromConfig,
  getRoutingConfig,
} from "../routing/index.js";

const log = createLogger("server:slack:router");

export interface MemoryMeta {
  memories_used: number;
  facts_used: number;
  reflections_used: number;
  profile_loaded: boolean;
  memory_context?: string;
}

export interface RoutedAction {
  command: string;
  // biome-ignore lint/suspicious/noExplicitAny: Slack API type
  args: Record<string, any>;
  reply: string;
  memoryMeta?: MemoryMeta;
}

/**
 * Build system prompt and tools dynamically from the YAML routing config.
 * Falls back to empty config if not initialized (e.g. in tests).
 */
function buildSystemPromptAndTools(): {
  systemPromptTemplate: string;
  tools: ToolDefinition[];
  model: string;
} {
  try {
    const config = getRoutingConfig();
    const tools = buildToolsFromConfig(config);
    const actionsSection = buildActionsPromptSection(config);

    // Inject the auto-generated actions section into the system prompt
    // if it contains {ACTIONS}, otherwise append it
    let prompt = config.system_prompt;
    if (prompt.includes("{ACTIONS}")) {
      prompt = prompt.replace("{ACTIONS}", actionsSection);
    }

    return {
      systemPromptTemplate: prompt,
      tools,
      model: config.model || configuredModel,
    };
  } catch {
    log.warn("Routing config not available, using empty config");
    return { systemPromptTemplate: "", tools: [], model: configuredModel };
  }
}

let provider: LLMProvider | null = null;
let configuredModel = getModelForRole("routing");

export function initMessageRouter(llmProvider: LLMProvider, model: string) {
  provider = llmProvider;
  configuredModel = model;
  log.info("Message router initialized", { model });
}

async function buildJobsContext(): Promise<string> {
  try {
    const { jobs } = await queryJobs({ limit: 10 });
    if (!jobs.length) return "(No recent jobs)";

    return jobs
      .map((j) => {
        const prs = j.pr_urls?.length ? ` | PRs: ${j.pr_urls.join(", ")}` : "";
        const err = j.error?.message ? ` | Error: ${j.error.message.slice(0, 100)}` : "";
        const plan =
          j.status === "PENDING_CONFIRMATION" && j.plan?.summary
            ? `\n  Plan: ${j.plan.summary.slice(0, 300)}`
            : "";
        return `- ${j.task_id.slice(0, 8)}… | ${j.status} | "${j.task_text?.slice(0, 80)}"${prs}${err}${plan}`;
      })
      .join("\n");
  } catch (err: unknown) {
    log.warn("Failed to fetch jobs context", { error: (err as Error).message });
    return "(Could not fetch recent jobs)";
  }
}

export interface ThreadMessage {
  user: string;
  text: string;
  ts: string;
  isBot: boolean;
}

const CHARS_PER_TOKEN = 4;
const DEFAULT_KB_MAX_TOKENS = 2000;

/**
 * Format basic vector search results into a context string, truncated to maxChars.
 */
function formatSearchResults(results: KBSearchResult[], maxChars: number): string {
  let totalChars = 0;
  const entries: string[] = [];
  for (const r of results) {
    const breadcrumb = formatPathBreadcrumb(r);
    const sectionSuffix = r.metadata.section ? ` > ${r.metadata.section}` : "";
    const entry = `[${r.kb_name} > ${breadcrumb}${sectionSuffix}] (score: ${r.score.toFixed(2)}):\n${r.content}`;
    if (totalChars + entry.length > maxChars) break;
    entries.push(entry);
    totalChars += entry.length;
  }
  return entries.length ? entries.join("\n\n---\n\n") : "";
}

/**
 * Basic vector search fallback — search KBs and format results.
 */
async function basicKBSearch(query: string, scopes: KBScope[], maxChars: number): Promise<string> {
  const results = await searchKnowledgeBases({ query, scopes });
  if (!results.length) return "(No knowledge base context available)";
  const formatted = formatSearchResults(results, maxChars);
  return formatted || "(No knowledge base context available)";
}

/**
 * Build knowledge base context by searching enabled KBs with the user's message.
 * When `kb_research_strategy` is set in routing config, uses the advanced research
 * pipeline for richer context. Otherwise falls back to basic vector search.
 */
async function buildKBContext(userMessage: string, scopes: KBScope[]): Promise<string> {
  try {
    // Check if the research pipeline should be used
    let researchStrategy: ResearchStrategy | undefined;
    let maxTokens = DEFAULT_KB_MAX_TOKENS;
    try {
      const config = getRoutingConfig();
      if (config.kb_context_max_tokens) {
        maxTokens = config.kb_context_max_tokens;
      }
      if (config.kb_research_strategy) {
        researchStrategy = config.kb_research_strategy;
      }
    } catch {}

    const maxChars = maxTokens * CHARS_PER_TOKEN;

    // Use research pipeline if strategy is configured
    if (researchStrategy) {
      return buildResearchKBContext(userMessage, scopes, researchStrategy, maxChars);
    }

    // Fallback: basic vector search
    const context = await basicKBSearch(userMessage, scopes, maxChars);

    if (context !== "(No knowledge base context available)") {
      log.info("KB context built for routing", { chars: context.length });
    }

    return context;
  } catch (err: any) {
    log.warn("Failed to build KB context", { error: err.message });
    return "(Knowledge base search unavailable)";
  }
}

/**
 * Build KB context using the advanced research pipeline.
 * Produces richer context with query enhancement, evaluation, and reasoning.
 */
async function buildResearchKBContext(
  userMessage: string,
  scopes: KBScope[],
  strategy: ResearchStrategy,
  maxChars: number,
): Promise<string> {
  try {
    const result = await researchKnowledgeBases({
      query: userMessage,
      scopes,
      strategy,
      consumer: { type: "chat", id: "message-router" },
    });

    if (!result.context) return "(No knowledge base context available)";

    // Truncate if needed
    const context =
      result.context.length > maxChars
        ? `${result.context.slice(0, maxChars)}\n[truncated]`
        : result.context;

    log.info("Research KB context built for routing", {
      strategy,
      chunks: result.chunks.length,
      context_length: context.length,
      session_id: result.session_id,
      metrics: result.metrics,
    });

    return context;
  } catch (err: any) {
    log.warn("Research pipeline failed for chat context, falling back to basic search", {
      error: err.message,
      strategy,
    });
    return basicKBSearch(userMessage, scopes, maxChars);
  }
}

const IMAGE_MIMETYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export async function routeMessage(
  userMessage: string,
  slackUserId: string,
  threadMessages?: ThreadMessage[],
  attachments?: JobAttachment[],
): Promise<RoutedAction> {
  if (!provider) {
    throw new Error("LLM provider not initialized — cannot route message");
  }

  const { systemPromptTemplate, tools: configTools, model } = buildSystemPromptAndTools();

  // Unified context assembly — searches KB + Memory in parallel, cross-ranks,
  // and auto-escalates to deep retrieval when context is insufficient.
  const [jobsContext, contextResult] = await Promise.all([
    buildJobsContext(),
    assembleContext({
      query: userMessage,
      owner: slackUserId,
      scopes: ["chat", "all"],
    }).catch((err) => {
      log.warn("Unified context assembly failed, falling back to legacy", {
        error: (err as Error).message,
      });
      return null;
    }),
  ]);

  let systemPrompt = systemPromptTemplate.replace("{JOBS_CONTEXT}", jobsContext);

  // Legacy fallback: if unified context failed or template uses old placeholders
  if (!contextResult || !systemPromptTemplate.includes("{CONTEXT}")) {
    // Fall back to legacy independent KB + memory context
    const [kbContext, memoryResult] = await Promise.all([
      buildKBContext(userMessage, ["chat", "all"]),
      getMemoryContext(userMessage, slackUserId).catch(() => ({
        memoryContext: "",
        userContext: "",
      })),
    ]);
    systemPrompt = systemPrompt.replace("{KB_CONTEXT}", kbContext);
    systemPrompt = systemPrompt.replace("{MEMORY_CONTEXT}", memoryResult.memoryContext);
    systemPrompt = systemPrompt.replace("{USER_CONTEXT}", memoryResult.userContext);
  } else {
    // Unified path — single {CONTEXT} + {USER_CONTEXT}
    systemPrompt = systemPrompt.replace("{CONTEXT}", contextResult.context);
    systemPrompt = systemPrompt.replace("{USER_CONTEXT}", contextResult.profile);
    // Also replace legacy placeholders with empty strings in case template has both
    systemPrompt = systemPrompt.replace("{KB_CONTEXT}", "");
    systemPrompt = systemPrompt.replace("{MEMORY_CONTEXT}", "");
  }

  // Store context result for memory metadata extraction later
  const memoryResult = contextResult
    ? { memoryContext: contextResult.context, userContext: contextResult.profile }
    : { memoryContext: "", userContext: "" };
  const activeModel = model || configuredModel;

  // Build message history from thread context
  const messages: { role: "user" | "assistant"; content: string | ContentBlock[] }[] = [];
  if (threadMessages && threadMessages.length > 0) {
    for (const msg of threadMessages) {
      // Skip messages with empty text — Bedrock rejects blank content blocks
      if (!msg.text?.trim()) continue;
      if (msg.isBot) {
        messages.push({ role: "assistant", content: msg.text });
      } else {
        messages.push({ role: "user", content: `[${msg.user}]: ${msg.text}` });
      }
    }
  } else {
    // Single message, no thread context
    messages.push({
      role: "user",
      content: `<slack_user_id>${slackUserId}</slack_user_id>\n<message>${userMessage}</message>`,
    });
  }

  // Append file attachments to the last user message
  if (attachments && attachments.length > 0) {
    const imageAttachments = attachments.filter((a) => IMAGE_MIMETYPES.has(a.mimetype));
    const otherAttachments = attachments.filter((a) => !IMAGE_MIMETYPES.has(a.mimetype));

    // Build content blocks for the last user message
    const lastUserIdx = messages.length - 1;
    const lastContent = messages[lastUserIdx].content;
    const textContent = typeof lastContent === "string" ? lastContent : "";

    const blocks: ContentBlock[] = [{ type: "text", text: textContent }];

    // Add images as vision blocks
    for (const img of imageAttachments) {
      blocks.push({
        type: "image",
        mediaType: img.mimetype,
        base64: img.base64,
      });
    }

    // Add non-image files as text notes
    if (otherAttachments.length > 0) {
      const fileList = otherAttachments
        .map((a) => `${a.filename} (${a.mimetype}, ${Math.round(a.size_bytes / 1024)}KB)`)
        .join(", ");
      blocks.push({ type: "text", text: `\n[Attached files: ${fileList}]` });
    }

    messages[lastUserIdx] = { role: "user", content: blocks };
    log.info("Multimodal content built for routing LLM", {
      images: imageAttachments.length,
      otherFiles: otherAttachments.length,
    });
  }

  try {
    const response = await provider.chat({
      model: activeModel,
      maxTokens: 1024,
      system: systemPrompt,
      tools: configTools,
      messages,
    });

    let reply = response.text;
    let command = "chat";
    // biome-ignore lint/suspicious/noExplicitAny: Slack API type
    let args: Record<string, any> = {};

    if (response.toolCalls.length > 0) {
      const tc = response.toolCalls[0];
      command = tc.name;
      args = tc.input;
    }

    // If no text, check tool args for a response (e.g. chat tool)
    if (!reply && args.response) {
      reply = args.response;
    }
    if (!reply) {
      reply = "On it.";
    }

    // Post-routing guard: if the LLM picked "chat" but the user is clearly
    // asking the bot to leave the channel, override to leave_channel so the
    // bot actually calls conversations.leave instead of just chatting about it.
    if (command === "chat" && configTools.some((t) => t.name === "leave_channel")) {
      const userLeaveIntent =
        /\b(leave\s+(this|the)(\s+\w+)?\s+channel|please\s+leave|go\s+away|get\s+out|remove\s+yourself|you\s+can\s+(go|leave)|can\s+you\s+leave)\b/i;
      if (userLeaveIntent.test(userMessage)) {
        log.info(
          "Post-routing override: chat → leave_channel (user message indicated leave intent)",
        );
        const chatReply = reply || args.response || "";
        // If the LLM's reply is a refusal ("I can't leave", "I don't have the ability"),
        // use a sensible default farewell instead of posting the refusal before leaving.
        const isRefusal = /\b(can'?t|cannot|don'?t|do not|unable|not able)\b.{0,40}\bleave\b/i.test(
          chatReply,
        );
        command = "leave_channel";
        args = { farewell: isRefusal || !chatReply ? "Alright, I'm out. ✌️" : chatReply };
      }
    }

    log.info("Message routed", {
      command,
      args: JSON.stringify(args).slice(0, 200),
      reply: reply.slice(0, 100),
    });

    // Build memory metadata for chat UI transparency
    const memCtx = memoryResult.memoryContext;
    const memLines = memCtx ? memCtx.split("\n").filter((l) => l.trim()) : [];
    const factsUsed = memLines.filter((l) => l.includes("[fact")).length;
    const reflectionsUsed = memLines.filter((l) => l.includes("[reflection")).length;
    const memoryMeta: MemoryMeta | undefined =
      memLines.length > 0 || memoryResult.userContext
        ? {
            memories_used: memLines.length,
            facts_used: factsUsed,
            reflections_used: reflectionsUsed,
            profile_loaded: !!memoryResult.userContext,
            memory_context: memCtx || undefined,
          }
        : undefined;

    return { command, reply, args, memoryMeta };
  } catch (err: unknown) {
    log.error("LLM routing failed", { error: (err as Error).message });
    throw new Error(`LLM routing unavailable: ${(err as Error).message}`);
  }
}

/**
 * Extract a user-friendly error message from an LLM routing failure.
 * Parses common API error patterns (credit balance, rate limits, auth, etc.)
 * and returns a concise explanation instead of a generic "unavailable" message.
 */
export function formatRoutingError(errMsg: string): string {
  const lower = errMsg.toLowerCase();

  if (lower.includes("credit balance") || lower.includes("purchase credits")) {
    return "⚠️ Anthropic API credits have run out. Please top up at https://console.anthropic.com/settings/plans and try again.";
  }
  if (lower.includes("rate limit") || lower.includes("rate_limit")) {
    return "⚠️ LLM API rate limit hit. Please wait a moment and try again.";
  }
  if (
    lower.includes("authentication") ||
    lower.includes("invalid.*api.key") ||
    lower.includes("401")
  ) {
    return "⚠️ LLM API authentication failed — the API key may be invalid or expired. Check your server configuration.";
  }
  if (lower.includes("overloaded") || lower.includes("529") || lower.includes("capacity")) {
    return "⚠️ The LLM API is currently overloaded. Please try again in a few minutes.";
  }
  if (
    lower.includes("context length") ||
    lower.includes("too many tokens") ||
    lower.includes("max_tokens")
  ) {
    return "⚠️ Message too long for the LLM context window. Try a shorter message.";
  }

  // Fallback: include a truncated version of the actual error
  const cleaned = errMsg.replace(/^LLM routing unavailable:\s*/i, "").slice(0, 200);
  return `⚠️ LLM routing failed: ${cleaned}`;
}
