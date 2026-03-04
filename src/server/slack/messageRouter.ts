import { formatPathBreadcrumb, type KBScope, type KBSearchResult } from "../../shared/kbTypes.js";
import { createLogger } from "../../shared/logger.js";
import type { JobAttachment } from "../../shared/types.js";
import { queryJobs } from "../jobs/jobService.js";
import { searchKnowledgeBases } from "../kb/kbService.js";
import type { ContentBlock, LLMProvider, ToolDefinition } from "../llm/index.js";
import {
  buildActionsPromptSection,
  buildToolsFromConfig,
  getRoutingConfig,
} from "../routing/index.js";

const log = createLogger("server:slack:router");

export interface RoutedAction {
  command: string;
  // biome-ignore lint/suspicious/noExplicitAny: Slack API type
  args: Record<string, any>;
  reply: string;
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
let configuredModel = "claude-sonnet-4-20250514";

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
 * Build knowledge base context by searching enabled KBs with the user's message.
 * Returns a formatted string for injection into the system prompt.
 */
async function buildKBContext(userMessage: string, scopes: KBScope[]): Promise<string> {
  try {
    const results = await searchKnowledgeBases({
      query: userMessage,
      scopes,
    });

    if (!results.length) return "(No knowledge base context available)";

    // Get the max tokens from routing config, or use default
    let maxTokens = DEFAULT_KB_MAX_TOKENS;
    try {
      const config = getRoutingConfig();
      if (config.kb_context_max_tokens) {
        maxTokens = config.kb_context_max_tokens;
      }
    } catch {}

    const maxChars = maxTokens * CHARS_PER_TOKEN;
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

    if (!entries.length) return "(No knowledge base context available)";

    log.info("KB context built for routing", {
      results: results.length,
      included: entries.length,
      chars: totalChars,
    });

    return entries.join("\n\n---\n\n");
  } catch (err: any) {
    log.warn("Failed to build KB context", { error: err.message });
    return "(Knowledge base search unavailable)";
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
    log.warn("LLM provider not initialized, treating as job creation");
    return {
      command: "create_job",
      args: { task_text: userMessage },
      reply: "Got it — I'll take a look.",
    };
  }

  const jobsContext = await buildJobsContext();
  const { systemPromptTemplate, tools: configTools, model } = buildSystemPromptAndTools();
  const kbContext = await buildKBContext(userMessage, ["chat", "all"]);
  let systemPrompt = systemPromptTemplate.replace("{JOBS_CONTEXT}", jobsContext);
  systemPrompt = systemPrompt.replace("{KB_CONTEXT}", kbContext);
  const activeModel = model || configuredModel;

  // Build message history from thread context
  const messages: { role: "user" | "assistant"; content: string | ContentBlock[] }[] = [];
  if (threadMessages && threadMessages.length > 0) {
    for (const msg of threadMessages) {
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

    return { command, reply, args };
  } catch (err: unknown) {
    log.error("LLM routing failed, falling back to create_job", { error: (err as Error).message });
    return {
      command: "create_job",
      args: { task_text: userMessage },
      reply: "Got it — I'll take a look. _(LLM routing unavailable, treating as a task)_",
    };
  }
}
