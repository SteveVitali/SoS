import { createLogger } from "../../shared/logger.js";
import { queryJobs } from "../jobs/jobService.js";
import type { LLMProvider, ToolDefinition, ContentBlock } from "../llm/index.js";
import type { JobAttachment } from "../../shared/types.js";

const log = createLogger("server:slack:router");

export interface RoutedAction {
  command: "create_job" | "job_status" | "cancel_job" | "retry_job" | "list_jobs" | "chat" | "no_op";
  args: Record<string, any>;
  reply: string;
}

const STEVE_SYSTEM_PROMPT = `You are Steve, a senior staff engineer / tech lead. You're sharp, slightly snarky, but ultimately helpful and competent. You speak concisely — no fluff. You have a dry sense of humor.

You are the interface for "Son of Steve", a coding agent orchestrator. People interact with you in Slack threads.

## Thread Context

You will receive the full conversation history from the Slack thread. Messages are labeled with the Slack user ID of who sent them. Messages from you (the bot) are labeled as "[bot]". Use this context to understand the conversation flow and respond appropriately.

## Available Actions (use the tools)

- **create_job**: The user wants you to write code, fix a bug, implement a feature, etc. This is the most common action. Extract the task description, and optionally a repo hint, test level, and reviewers. Incorporate relevant context from the thread into the task description.
- **job_status**: The user is asking about the status of a specific job. Extract the task_id (can be partial).
- **cancel_job**: The user wants to cancel a running job. Extract the task_id.
- **retry_job**: The user wants to retry a failed job. Extract the task_id.
- **list_jobs**: The user wants to see recent jobs. Optionally extract a limit.
- **chat**: The user is just talking, asking a question about you, saying hi, or their message doesn't map to any action. Just respond conversationally as Steve.
- **no_op**: The latest message in the thread is NOT directed at you and doesn't require your response. Use this when people are having a side conversation in the thread, or when someone replies to someone else and it's clear the bot shouldn't chime in. When in doubt between chat and no_op, prefer no_op — don't be annoying.

## Guidelines

- If the user's intent is ambiguous between chat and create_job, lean toward asking for clarification rather than creating a job.
- Always respond in character as Steve. Keep it brief.
- If someone asks what you can do, explain your capabilities naturally — don't just dump a help menu.
- Reference job details from the context provided when answering status questions.
- For create_job, clean up the task text — remove any @mentions, modifiers, and conversational fluff to extract just the actual task.
- If the latest message is clearly not addressed to you (e.g., two humans talking to each other in the thread), use no_op.
- If someone @-mentions you directly, always respond — never no_op a direct mention.

## Recent Jobs Context
{JOBS_CONTEXT}
`;

const TOOLS: ToolDefinition[] = [
  {
    name: "create_job",
    description: "Create a new coding task for the agent to work on",
    parameters: {
      type: "object",
      properties: {
        task_text: { type: "string", description: "Clean task description" },
        repo_hint: { type: "string", description: "Repository ID hint (e.g. 'fsq-graph', 'foursquare.web')" },
        test_level: { type: "string", enum: ["fast", "full", "none"], description: "Test level" },
        reviewers: {
          type: "array",
          items: { type: "string" },
          description: "GitHub usernames for PR reviewers",
        },
      },
      required: ["task_text"],
    },
  },
  {
    name: "job_status",
    description: "Look up the status of a job by task_id",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Full or partial task_id" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "cancel_job",
    description: "Cancel a running or queued job",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Full or partial task_id" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "retry_job",
    description: "Retry a failed or canceled job",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Full or partial task_id" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "list_jobs",
    description: "List recent jobs",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max jobs to return (default 5)" },
      },
      required: [],
    },
  },
  {
    name: "chat",
    description: "Just respond conversationally — no action needed. Put your full response in the 'response' field.",
    parameters: {
      type: "object",
      properties: {
        response: { type: "string", description: "Your conversational response to the user" },
      },
      required: ["response"],
    },
  },
  {
    name: "no_op",
    description: "The latest message does not require a response from the bot. Use when the message is not directed at you.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Brief reason why no response is needed" },
      },
      required: ["reason"],
    },
  },
];

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
        return `- ${j.task_id.slice(0, 8)}… | ${j.status} | "${j.task_text?.slice(0, 80)}"${prs}${err}`;
      })
      .join("\n");
  } catch (err: any) {
    log.warn("Failed to fetch jobs context", { error: err.message });
    return "(Could not fetch recent jobs)";
  }
}

export interface ThreadMessage {
  user: string;
  text: string;
  ts: string;
  isBot: boolean;
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
  const systemPrompt = STEVE_SYSTEM_PROMPT.replace("{JOBS_CONTEXT}", jobsContext);

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
      model: configuredModel,
      maxTokens: 1024,
      system: systemPrompt,
      tools: TOOLS,
      messages,
    });

    let reply = response.text;
    let command: RoutedAction["command"] = "chat";
    let args: Record<string, any> = {};

    if (response.toolCalls.length > 0) {
      const tc = response.toolCalls[0];
      command = tc.name as RoutedAction["command"];
      args = tc.input;
    }

    // If no text, check tool args for a response (e.g. chat tool)
    if (!reply && args.response) {
      reply = args.response;
    }
    if (!reply) {
      reply = "On it.";
    }

    log.info("Message routed", { command, args: JSON.stringify(args).slice(0, 200), reply: reply.slice(0, 100) });

    return { command, reply, args };
  } catch (err: any) {
    log.error("LLM routing failed, falling back to create_job", { error: err.message });
    return {
      command: "create_job",
      args: { task_text: userMessage },
      reply: "Got it — I'll take a look. _(LLM routing unavailable, treating as a task)_",
    };
  }
}
