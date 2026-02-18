import Anthropic from "@anthropic-ai/sdk";
import { createLogger } from "../../shared/logger.js";
import { queryJobs, findJobByTaskId } from "../jobs/jobService.js";

const log = createLogger("server:slack:router");

export interface RoutedAction {
  command: "create_job" | "job_status" | "cancel_job" | "retry_job" | "list_jobs" | "chat";
  args: Record<string, any>;
  reply: string;
}

const STEVE_SYSTEM_PROMPT = `You are Steve, a senior staff engineer / tech lead. You're sharp, slightly snarky, but ultimately helpful and competent. You speak concisely — no fluff. You have a dry sense of humor.

You are the interface for "Son of Steve", a coding agent orchestrator. When someone @-mentions you in Slack, you decide what they want and take action.

## Available Actions (use the tools)

- **create_job**: The user wants you to write code, fix a bug, implement a feature, etc. This is the most common action. Extract the task description, and optionally a repo hint, test level, and reviewers.
- **job_status**: The user is asking about the status of a specific job. Extract the task_id (can be partial).
- **cancel_job**: The user wants to cancel a running job. Extract the task_id.
- **retry_job**: The user wants to retry a failed job. Extract the task_id.
- **list_jobs**: The user wants to see recent jobs. Optionally extract a limit.
- **chat**: The user is just talking, asking a question about you, saying hi, or their message doesn't map to any action. Just respond conversationally as Steve.

## Guidelines

- If the user's intent is ambiguous between chat and create_job, lean toward asking for clarification rather than creating a job.
- Always respond in character as Steve. Keep it brief.
- If someone asks what you can do, explain your capabilities naturally — don't just dump a help menu.
- Reference job details from the context provided when answering status questions.
- For create_job, clean up the task text — remove any @mentions, modifiers, and conversational fluff to extract just the actual task.

## Recent Jobs Context
{JOBS_CONTEXT}
`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "create_job",
    description: "Create a new coding task for the agent to work on",
    input_schema: {
      type: "object" as const,
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
    input_schema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string", description: "Full or partial task_id" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "cancel_job",
    description: "Cancel a running or queued job",
    input_schema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string", description: "Full or partial task_id" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "retry_job",
    description: "Retry a failed or canceled job",
    input_schema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string", description: "Full or partial task_id" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "list_jobs",
    description: "List recent jobs",
    input_schema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max jobs to return (default 5)" },
      },
      required: [],
    },
  },
  {
    name: "chat",
    description: "Just respond conversationally — no action needed. Put your full response in the 'response' field.",
    input_schema: {
      type: "object" as const,
      properties: {
        response: { type: "string", description: "Your conversational response to the user" },
      },
      required: ["response"],
    },
  },
];

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
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

export async function routeMessage(userMessage: string, slackUserId: string): Promise<RoutedAction> {
  const jobsContext = await buildJobsContext();
  const systemPrompt = STEVE_SYSTEM_PROMPT.replace("{JOBS_CONTEXT}", jobsContext);

  try {
    const anthropic = getClient();
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: systemPrompt,
      tools: TOOLS,
      messages: [
        {
          role: "user",
          content: `<slack_user_id>${slackUserId}</slack_user_id>\n<message>${userMessage}</message>`,
        },
      ],
    });

    let reply = "";
    let command: RoutedAction["command"] = "chat";
    let args: Record<string, any> = {};

    for (const block of response.content) {
      if (block.type === "text") {
        reply += block.text;
      } else if (block.type === "tool_use") {
        command = block.name as RoutedAction["command"];
        args = (block.input as Record<string, any>) || {};
      }
    }

    // If no text block, check tool args for a response (e.g. chat tool)
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
