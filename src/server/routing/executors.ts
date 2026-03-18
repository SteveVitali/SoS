/**
 * Generic execution primitives for YAML-driven action routing.
 *
 * Each executor is a small function that reads its configuration from the YAML
 * ExecutionDef and performs the corresponding action. The switch statement in
 * commandExecutor.ts is replaced by a lookup into this map.
 */

import { execFile } from "node:child_process";
import { createLogger } from "../../shared/logger.js";
import { getModelForRole } from "../../shared/modelConfig.js";
import type { ResearchConfig } from "../../shared/researchTypes.js";
import type { GithubQueryType, JobDoc } from "../../shared/types.js";
import { GITHUB_INSTANT_QUERIES, GITHUB_SUMMARY_QUERIES } from "../../shared/types.js";
import { storeGeneratedImage } from "../chat/imageStore.js";
import { formatInstantQueryFromMongo } from "../github/mongoFormatting.js";
import { executeInstantQueryFromMongo } from "../github/mongoQueries.js";
import { executeRecapInline } from "../github/recapService.js";
import {
  cancel,
  confirmJob,
  createJobFromDiscord,
  createJobFromSlack,
  createJobFromWeb,
  createRespondToCommentsJob,
  findJobByTaskId,
  promotePr,
  queryJobs,
  retry,
} from "../jobs/jobService.js";
import { searchKnowledgeBases } from "../kb/kbService.js";
import { StepRecorder } from "../kb/research/auditLog.js";
import { getResearchLLMClient } from "../kb/research/llmClient.js";
import { runEvaluator } from "../kb/research/stages/evaluator.js";
import type { LLMProvider } from "../llm/llmProvider.js";
import type { CommandContext, CommandResult } from "../slack/commandExecutor.js";
import type { RoutedAction } from "../slack/messageRouter.js";
import { executeResearch } from "./researchExecutor.js";
import type {
  AgentTaskExecution,
  CreateJobExecution,
  CreateRespondJobExecution,
  DispatchExecution,
  ExecutionDef,
  GenerateImageExecution,
  GithubQueryExecution,
  JobActionExecution,
  JobListExecution,
  JobQueryExecution,
  LeaveChannelExecution,
  ReplyExecution,
  ShellExecution,
  WebhookExecution,
} from "./routingTypes.js";
import { renderTemplate, type TemplateContext } from "./template.js";

const log = createLogger("server:routing:executors");

// --- LLM provider for inline recaps ---

let recapLlmProvider: LLMProvider | null = null;
let imageGenProvider: LLMProvider | null = null;

export function initExecutorLLM(provider: LLMProvider): void {
  recapLlmProvider = provider;
  imageGenProvider = provider;
  log.info("Executor LLM provider initialized (inline recaps enabled)");
}

export function initImageGenProvider(provider: LLMProvider): void {
  imageGenProvider = provider;
  log.info("Image generation provider initialized", {
    supportsImageGen: typeof provider.generateImage === "function",
  });
}

// --- Shared helpers ---

async function resolveTaskId(partial: string): Promise<string | null> {
  const exact = await findJobByTaskId(partial);
  if (exact) return exact.task_id;
  const { jobs } = await queryJobs({ limit: 50 });
  // biome-ignore lint/suspicious/noExplicitAny: dynamic config type
  const match = jobs.find((j: any) => j.task_id.startsWith(partial));
  return match?.task_id || null;
}

function tplCtx(
  action: RoutedAction,
  ctx: CommandContext,
  extra?: Record<string, unknown>,
): TemplateContext {
  return {
    args: action.args,
    ctx: {
      github_username: ctx.githubUsername,
      github_org: ctx.githubOrg,
      github_team_slug: ctx.githubTeamSlug,
      user_id: ctx.userId,
      owner_id: ctx.ownerId,
    },
    env: Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] != null),
    ),
    ...extra,
  };
}

function appendReply(base: string, extra: string): string {
  if (!base) return extra;
  if (!extra) return base;
  return `${base}\n\n${extra}`;
}

// --- Executor: reply ---

async function executeReply(
  action: RoutedAction,
  _ctx: CommandContext,
  execDef: ReplyExecution,
): Promise<CommandResult> {
  if (execDef.silent) {
    return { reply: "", actionTaken: `no_op: ${action.args.reason || "not relevant"}` };
  }
  return { reply: action.reply, actionTaken: "chat" };
}

// --- Executor: create_job ---

async function executeCreateJob(
  action: RoutedAction,
  ctx: CommandContext,
  execDef: CreateJobExecution,
): Promise<CommandResult> {
  try {
    const args = action.args;
    const customInstr = execDef.custom_instructions
      ? renderTemplate(execDef.custom_instructions, tplCtx(action, ctx))
      : undefined;

    let job: JobDoc;
    if (ctx.source === "slack" && ctx.slack) {
      job = (
        await createJobFromSlack({
          event_id: ctx.eventId,
          requested_by: ctx.userId,
          slack_requester: ctx.userId,
          task_text: args.task_text || "(no task description)",
          channel_id: ctx.slack.channelId,
          thread_ts: ctx.slack.threadTs,
          message_ts: ctx.slack.messageTs,
          repo_hint: args.repo_hint,
          test_level: args.test_level,
          reviewers: args.reviewers,
          attachments: ctx.attachments,
          needs_plan: execDef.needs_plan,
          custom_instructions: customInstr,
        })
      ).job;
    } else if (ctx.source === "discord" && ctx.discord) {
      job = (
        await createJobFromDiscord({
          event_id: ctx.eventId,
          requested_by: ctx.userId,
          discord_requester: ctx.userId,
          task_text: args.task_text || "(no task description)",
          channel_id: ctx.discord.channelId,
          thread_id: ctx.discord.threadId,
          message_id: ctx.discord.messageId,
          guild_id: ctx.discord.guildId,
          repo_hint: args.repo_hint,
          test_level: args.test_level,
          reviewers: args.reviewers,
          attachments: ctx.attachments,
          needs_plan: execDef.needs_plan,
          custom_instructions: customInstr,
        })
      ).job;
    } else {
      job = await createJobFromWeb({
        requested_by: ctx.ownerId,
        task_text: args.task_text || "(no task description)",
        repo_hint: args.repo_hint,
        test_level: args.test_level,
        reviewers: args.reviewers,
        needs_plan: execDef.needs_plan,
        custom_instructions: customInstr,
      });
    }

    const reply = renderTemplate(
      execDef.reply_success || "📋 Task queued: `{{task_id:0:8}}…`",
      tplCtx(action, ctx, { task_id: job.task_id }),
    );
    return {
      reply: appendReply(action.reply, reply),
      actionTaken: `created job ${job.task_id}`,
      taskId: job.task_id,
    };
  } catch (err: unknown) {
    log.error("Failed to create job", { error: (err as Error).message });
    const reply = renderTemplate(
      execDef.reply_error || "⚠️ Failed to queue task: {{error}}",
      tplCtx(action, ctx, { error: (err as Error).message }),
    );
    return { reply: appendReply(action.reply, reply), actionTaken: "create_job failed" };
  }
}

// --- Executor: job_action ---

async function executeJobAction(
  action: RoutedAction,
  ctx: CommandContext,
  execDef: JobActionExecution,
): Promise<CommandResult> {
  const taskId = await resolveTaskId(action.args.task_id || "");
  if (!taskId) {
    const reply = renderTemplate(
      execDef.reply_not_found || "❓ Couldn't find a job matching `{{args.task_id}}`.",
      tplCtx(action, ctx),
    );
    return {
      reply: appendReply(action.reply, reply),
      actionTaken: `${execDef.method}: not found`,
    };
  }

  // Pre-fetch job for status/PR checks and for methods that need it
  const existing = await findJobByTaskId(taskId);

  // Check status requirement
  if (execDef.require_status) {
    if (!existing || existing.status !== execDef.require_status) {
      const reply = renderTemplate(
        execDef.reply_wrong_status ||
          "⚠️ `{{task_id:0:8}}…` has status {{status}}, expected {{require_status}}.",
        tplCtx(action, ctx, {
          task_id: taskId,
          status: existing?.status || "not found",
          require_status: execDef.require_status,
        }),
      );
      return {
        reply: appendReply(action.reply, reply),
        actionTaken: `${execDef.method}: wrong status`,
      };
    }
  }

  // Check PR requirement (independent of status check)
  if (execDef.require_pr && !existing?.pr_urls?.length) {
    const reply = renderTemplate(
      execDef.reply_no_pr || "⚠️ No PR URL on `{{task_id:0:8}}…`.",
      tplCtx(action, ctx, { task_id: taskId }),
    );
    return {
      reply: appendReply(action.reply, reply),
      actionTaken: `${execDef.method}: no pr`,
    };
  }

  // Execute the method
  try {
    let resultTaskId = taskId;
    let prUrl: string | undefined;

    switch (execDef.method) {
      case "cancel": {
        const job = await cancel(taskId);
        if (!job) {
          const reply = renderTemplate(
            execDef.reply_failed || "⚠️ Couldn't perform action on `{{task_id:0:8}}…`.",
            tplCtx(action, ctx, { task_id: taskId }),
          );
          return {
            reply: appendReply(action.reply, reply),
            actionTaken: `${execDef.method}: no-op`,
          };
        }
        break;
      }

      case "retry": {
        const newJob = await retry(taskId);
        if (!newJob) {
          const reply = renderTemplate(
            execDef.reply_failed || "⚠️ Couldn't perform action on `{{task_id:0:8}}…`.",
            tplCtx(action, ctx, { task_id: taskId }),
          );
          return {
            reply: appendReply(action.reply, reply),
            actionTaken: `${execDef.method}: not eligible`,
          };
        }
        resultTaskId = newJob.task_id;
        break;
      }

      case "confirm": {
        await confirmJob(taskId, action.args.revised_task_text);
        break;
      }

      case "promote": {
        prUrl = existing?.pr_urls?.[0];
        if (prUrl) {
          const { promotePr: ghPromotePr } = await import("../../worker/executor/pr.js");
          ghPromotePr(prUrl, action.args.reviewers);
        }
        await promotePr(taskId, action.args.reviewers);
        break;
      }
    }

    const reply = renderTemplate(
      execDef.reply_success || "✅ Done.",
      tplCtx(action, ctx, { task_id: resultTaskId, pr_url: prUrl }),
    );
    return {
      reply: appendReply(action.reply, reply),
      actionTaken: `${execDef.method}: ${resultTaskId}`,
      taskId: resultTaskId,
    };
  } catch (err: unknown) {
    log.error(`Failed to ${execDef.method} job`, { error: (err as Error).message });
    const reply = renderTemplate(
      execDef.reply_error || "⚠️ Failed: {{error}}",
      tplCtx(action, ctx, { task_id: taskId, error: (err as Error).message }),
    );
    return {
      reply: appendReply(action.reply, reply),
      actionTaken: `${execDef.method} failed`,
    };
  }
}

// --- Executor: job_query ---

async function executeJobQuery(
  action: RoutedAction,
  ctx: CommandContext,
  execDef: JobQueryExecution,
): Promise<CommandResult> {
  const taskId = await resolveTaskId(action.args.task_id || "");
  if (!taskId) {
    const reply = renderTemplate(
      execDef.reply_not_found || "❓ Couldn't find a job matching `{{args.task_id}}`.",
      tplCtx(action, ctx),
    );
    return { reply: appendReply(action.reply, reply), actionTaken: "job_query: not found" };
  }

  const job = await findJobByTaskId(taskId);
  if (!job) {
    const reply = renderTemplate(
      execDef.reply_not_found || "❓ Job `{{task_id:0:8}}…` not found.",
      tplCtx(action, ctx, { task_id: taskId }),
    );
    return { reply: appendReply(action.reply, reply), actionTaken: "job_query: not found" };
  }

  const template =
    execDef.reply_template || "📊 *`{{task_id:0:8}}…`* — *{{status}}*\nTask: {{task_text:0:120}}";

  const reply = renderTemplate(
    template,
    tplCtx(action, ctx, {
      task_id: job.task_id,
      status: job.status,
      task_text: job.task_text,
      claimed_by: job.claimed_by,
      pr_urls_joined: job.pr_urls?.join(", "),
      pr_url: job.pr_urls?.[0],
      error_message: job.error?.message,
    }),
  );
  return { reply: appendReply(action.reply, reply), actionTaken: `job_status: ${taskId}` };
}

// --- Executor: job_list ---

async function executeJobList(
  action: RoutedAction,
  _ctx: CommandContext,
  execDef: JobListExecution,
): Promise<CommandResult> {
  const limit = action.args.limit || execDef.default_limit || 5;
  const { jobs } = await queryJobs({ limit });

  if (!jobs.length) {
    const empty = execDef.reply_empty || "_(No jobs found)_";
    return {
      reply: appendReply(action.reply, empty),
      actionTaken: "list_jobs: empty",
    };
  }

  const template =
    execDef.item_template || "• `{{task_id:0:8}}…` *{{status}}* — {{task_text:0:60}}";

  // biome-ignore lint/suspicious/noExplicitAny: dynamic config type
  const lines = jobs.map((j: any) =>
    renderTemplate(template, {
      task_id: j.task_id,
      status: j.status,
      task_text: j.task_text,
      pr_url: j.pr_urls?.[0],
      pr_urls_joined: j.pr_urls?.join(", "),
    }),
  );

  return {
    reply: appendReply(action.reply, lines.join("\n")),
    actionTaken: `list_jobs: ${jobs.length} results`,
  };
}

// --- Executor: create_respond_job ---

async function executeCreateRespondJob(
  action: RoutedAction,
  ctx: CommandContext,
  execDef: CreateRespondJobExecution,
): Promise<CommandResult> {
  try {
    let prUrl: string | undefined = action.args.pr_url;
    let parentTaskId: string | undefined;

    if (action.args.task_id && !prUrl) {
      const taskId = await resolveTaskId(action.args.task_id);
      if (!taskId) {
        const reply = renderTemplate(
          execDef.reply_not_found || "❓ Couldn't find a job matching `{{args.task_id}}`.",
          tplCtx(action, ctx),
        );
        return {
          reply: appendReply(action.reply, reply),
          actionTaken: "respond_to_pr_comments: not found",
        };
      }
      const parentJob = await findJobByTaskId(taskId);
      if (!parentJob?.pr_urls?.length) {
        const reply = renderTemplate(
          execDef.reply_no_pr || "⚠️ No PR URL on `{{task_id:0:8}}…`.",
          tplCtx(action, ctx, { task_id: taskId }),
        );
        return {
          reply: appendReply(action.reply, reply),
          actionTaken: "respond_to_pr_comments: no pr",
        };
      }
      prUrl = parentJob.pr_urls[0];
      parentTaskId = taskId;
    }

    if (!prUrl) {
      const reply = renderTemplate(
        execDef.reply_missing_input ||
          "⚠️ I need either a task_id or a PR URL to respond to comments.",
        tplCtx(action, ctx),
      );
      return {
        reply: appendReply(action.reply, reply),
        actionTaken: "respond_to_pr_comments: missing input",
      };
    }

    const slackThread =
      ctx.source === "slack" && ctx.slack
        ? { channel_id: ctx.slack.channelId, thread_ts: ctx.slack.threadTs }
        : undefined;
    const discordThread =
      ctx.source === "discord" && ctx.discord
        ? {
            channel_id: ctx.discord.channelId,
            thread_id: ctx.discord.threadId,
            guild_id: ctx.discord.guildId,
          }
        : undefined;
    const job = await createRespondToCommentsJob(
      { requested_by: ctx.ownerId, pr_url: prUrl, parent_task_id: parentTaskId },
      ctx.source,
      slackThread,
      discordThread,
    );

    const reply = renderTemplate(
      execDef.reply_success ||
        "📋 Respond-to-comments job queued: `{{task_id:0:8}}…`\nPR: {{pr_url}}",
      tplCtx(action, ctx, { task_id: job.task_id, pr_url: prUrl }),
    );
    return {
      reply: appendReply(action.reply, reply),
      actionTaken: `respond_to_pr_comments: ${job.task_id}`,
      taskId: job.task_id,
    };
  } catch (err: unknown) {
    log.error("Failed to create respond-to-comments job", { error: (err as Error).message });
    const reply = renderTemplate(
      execDef.reply_error || "⚠️ Failed: {{error}}",
      tplCtx(action, ctx, { error: (err as Error).message }),
    );
    return {
      reply: appendReply(action.reply, reply),
      actionTaken: "respond_to_pr_comments failed",
    };
  }
}

// --- Executor: github_query ---

async function executeGithubQuery(
  action: RoutedAction,
  ctx: CommandContext,
  execDef: GithubQueryExecution,
): Promise<CommandResult> {
  const queryType = action.args.query_type as GithubQueryType;
  if (!queryType) {
    return {
      reply: appendReply(action.reply, "⚠️ Missing query_type for GitHub query."),
      actionTaken: "github: missing query_type",
    };
  }

  const instantTypes = execDef.instant_types || [...GITHUB_INSTANT_QUERIES];
  const summaryTypes = execDef.summary_types || [...GITHUB_SUMMARY_QUERIES];

  // Instant queries — read from MongoDB
  if (instantTypes.includes(queryType)) {
    try {
      const result = await executeInstantQueryFromMongo(queryType, {
        githubUsername: ctx.githubUsername,
        org: action.args.org || ctx.githubOrg,
        team_slug: action.args.team_slug || ctx.githubTeamSlug,
        time_range: action.args.time_range,
      });
      const formatted = formatInstantQueryFromMongo(result);
      return {
        reply: action.reply ? appendReply(action.reply, formatted) : formatted,
        actionTaken: `github: ${queryType} (${result.prs.length} results)`,
      };
    } catch (err: unknown) {
      log.error("GitHub instant query failed", { queryType, error: (err as Error).message });
      const reply = renderTemplate(
        execDef.reply_error || "⚠️ GitHub query failed: {{error}}",
        tplCtx(action, ctx, { error: (err as Error).message }),
      );
      return {
        reply: appendReply(action.reply, reply),
        actionTaken: `github: ${queryType} failed`,
      };
    }
  }

  // Summary queries — execute inline via MongoDB + LLM provider
  if (summaryTypes.includes(queryType)) {
    if (!recapLlmProvider) {
      log.warn("Recap requested but LLM provider not initialized");
      return {
        reply: appendReply(action.reply, "⚠️ Recap unavailable — LLM provider not configured."),
        actionTaken: `github: ${queryType} no_llm`,
      };
    }

    try {
      const formatted = await executeRecapInline(
        queryType as "my_recap" | "team_recap" | "user_recap",
        {
          org: action.args.org || ctx.githubOrg,
          team_slug: action.args.team_slug || ctx.githubTeamSlug,
          github_username: action.args.github_username || ctx.githubUsername,
          time_range: action.args.time_range,
        },
        recapLlmProvider,
      );
      return {
        reply: action.reply ? appendReply(action.reply, formatted) : formatted,
        actionTaken: `github: ${queryType} (inline)`,
      };
    } catch (err: unknown) {
      log.error("GitHub inline recap failed", { queryType, error: (err as Error).message });
      const reply = renderTemplate(
        execDef.reply_error || "⚠️ Recap generation failed: {{error}}",
        tplCtx(action, ctx, { error: (err as Error).message }),
      );
      return {
        reply: appendReply(action.reply, reply),
        actionTaken: `github: ${queryType} failed`,
      };
    }
  }

  const reply = renderTemplate(
    execDef.reply_unknown_type || "⚠️ Unknown GitHub query type: {{query_type}}",
    tplCtx(action, ctx, { query_type: queryType }),
  );
  return {
    reply: appendReply(action.reply, reply),
    actionTaken: `github: unknown query_type ${queryType}`,
  };
}

// --- Executor: shell ---

async function executeShell(
  action: RoutedAction,
  ctx: CommandContext,
  execDef: ShellExecution,
): Promise<CommandResult> {
  const command = renderTemplate(execDef.command, tplCtx(action, ctx));
  const timeout = (execDef.timeout_seconds || 30) * 1000;

  return new Promise((resolve) => {
    execFile("sh", ["-c", command], { timeout }, (err, stdout, stderr) => {
      if (err) {
        log.error("Shell execution failed", { command, error: (err as Error).message });
        const reply = renderTemplate(
          execDef.reply_error || "⚠️ Command failed: {{error}}",
          tplCtx(action, ctx, { error: (err as Error).message, stderr }),
        );
        resolve({
          reply: appendReply(action.reply, reply),
          actionTaken: "shell: failed",
        });
        return;
      }

      const trimmed = stdout.trim();
      if (!trimmed && execDef.reply_empty) {
        resolve({
          reply: appendReply(action.reply, execDef.reply_empty),
          actionTaken: "shell: empty",
        });
        return;
      }

      const reply = renderTemplate(
        execDef.reply_template || "{{stdout}}",
        tplCtx(action, ctx, { stdout: trimmed, stderr: stderr.trim() }),
      );
      resolve({
        reply: appendReply(action.reply, reply),
        actionTaken: "shell: ok",
      });
    });
  });
}

// --- Executor: webhook ---

async function executeWebhook(
  action: RoutedAction,
  ctx: CommandContext,
  execDef: WebhookExecution,
): Promise<CommandResult> {
  try {
    const tc = tplCtx(action, ctx);
    const url = renderTemplate(execDef.url, tc);
    const method = execDef.method || "POST";

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (execDef.headers) {
      for (const [k, v] of Object.entries(execDef.headers)) {
        headers[k] = renderTemplate(v, tc);
      }
    }

    const body = execDef.body
      ? JSON.parse(renderTemplate(JSON.stringify(execDef.body), tc))
      : undefined;

    const res = await fetch(url, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${res.status}: ${text}`);
    }

    const reply = renderTemplate(
      execDef.reply_success || "✅ Done.",
      tplCtx(action, ctx, { response_status: res.status }),
    );
    return { reply: appendReply(action.reply, reply), actionTaken: "webhook: ok" };
  } catch (err: unknown) {
    log.error("Webhook execution failed", { error: (err as Error).message });
    const reply = renderTemplate(
      execDef.reply_error || "⚠️ Webhook failed: {{error}}",
      tplCtx(action, ctx, { error: (err as Error).message }),
    );
    return { reply: appendReply(action.reply, reply), actionTaken: "webhook: failed" };
  }
}

// --- Executor: agent_task ---

async function executeAgentTask(
  action: RoutedAction,
  ctx: CommandContext,
  execDef: AgentTaskExecution,
): Promise<CommandResult> {
  try {
    const tc = tplCtx(action, ctx);
    const instructions = renderTemplate(execDef.instructions, tc);
    const taskText = action.args.task_text || instructions.slice(0, 200);
    const repoHint = execDef.repo_hint
      ? renderTemplate(execDef.repo_hint, tc)
      : action.args.repo_hint;

    let job: JobDoc;
    if (ctx.source === "slack" && ctx.slack) {
      job = (
        await createJobFromSlack({
          event_id: ctx.eventId,
          requested_by: ctx.userId,
          slack_requester: ctx.userId,
          task_text: taskText,
          channel_id: ctx.slack.channelId,
          thread_ts: ctx.slack.threadTs,
          message_ts: ctx.slack.messageTs,
          repo_hint: repoHint,
          // biome-ignore lint/suspicious/noExplicitAny: dynamic config type
          test_level: (execDef.test_level || action.args.test_level) as any,
          reviewers: execDef.reviewers || action.args.reviewers,
          attachments: ctx.attachments,
          custom_instructions: instructions,
        })
      ).job;
    } else if (ctx.source === "discord" && ctx.discord) {
      job = (
        await createJobFromDiscord({
          event_id: ctx.eventId,
          requested_by: ctx.userId,
          discord_requester: ctx.userId,
          task_text: taskText,
          channel_id: ctx.discord.channelId,
          thread_id: ctx.discord.threadId,
          message_id: ctx.discord.messageId,
          guild_id: ctx.discord.guildId,
          repo_hint: repoHint,
          // biome-ignore lint/suspicious/noExplicitAny: dynamic config type
          test_level: (execDef.test_level || action.args.test_level) as any,
          reviewers: execDef.reviewers || action.args.reviewers,
          attachments: ctx.attachments,
          custom_instructions: instructions,
        })
      ).job;
    } else {
      job = await createJobFromWeb({
        requested_by: ctx.ownerId,
        task_text: taskText,
        repo_hint: repoHint,
        // biome-ignore lint/suspicious/noExplicitAny: dynamic config type
        test_level: (execDef.test_level || action.args.test_level) as any,
        reviewers: execDef.reviewers || action.args.reviewers,
        custom_instructions: instructions,
      });
    }

    const reply = renderTemplate(
      execDef.reply_queued || "📋 Task queued: `{{task_id:0:8}}…`",
      tplCtx(action, ctx, { task_id: job.task_id }),
    );
    return {
      reply: appendReply(action.reply, reply),
      actionTaken: `agent_task: ${job.task_id}`,
      taskId: job.task_id,
    };
  } catch (err: unknown) {
    log.error("Failed to create agent task", { error: (err as Error).message });
    const reply = renderTemplate(
      execDef.reply_error || "⚠️ Failed: {{error}}",
      tplCtx(action, ctx, { error: (err as Error).message }),
    );
    return { reply: appendReply(action.reply, reply), actionTaken: "agent_task: failed" };
  }
}

// --- Executor: leave_channel ---

async function executeLeaveChannel(
  action: RoutedAction,
  ctx: CommandContext,
  execDef: LeaveChannelExecution,
): Promise<CommandResult> {
  if (ctx.source !== "slack" || !ctx.slack) {
    const reply = renderTemplate(
      execDef.reply_not_slack || "I can only leave Slack channels — this doesn't appear to be one.",
      tplCtx(action, ctx),
    );
    return { reply: appendReply(action.reply, reply), actionTaken: "leave_channel: not slack" };
  }

  try {
    const botToken = process.env.SLACK_BOT_TOKEN;
    if (!botToken) {
      throw new Error("SLACK_BOT_TOKEN not configured");
    }
    const { WebClient } = await import("@slack/web-api");
    const client = new WebClient(botToken);
    await client.conversations.leave({ channel: ctx.slack.channelId });

    const reply = renderTemplate(
      execDef.reply_success || "Alright, I'm out. ✌️",
      tplCtx(action, ctx),
    );
    return {
      reply: appendReply(action.reply, reply),
      actionTaken: `leave_channel: ${ctx.slack.channelId}`,
    };
  } catch (err: unknown) {
    log.error("Failed to leave channel", {
      error: (err as Error).message,
      channel: ctx.slack.channelId,
    });
    const reply = renderTemplate(
      execDef.reply_error || "Couldn't leave the channel: {{error}}",
      tplCtx(action, ctx, { error: (err as Error).message }),
    );
    return { reply: appendReply(action.reply, reply), actionTaken: "leave_channel: failed" };
  }
}

// --- KB-enriched image prompt ---

const DEFAULT_KB_MIN_SCORE = 0.5;

/**
 * Search KBs with the image prompt, filter by score threshold, run the
 * research evaluator to keep only "correct" chunks, then use an LLM call
 * to rewrite the prompt with KB context baked in.
 *
 * Returns the original prompt unchanged when:
 * - No KB results found
 * - All results below the score threshold
 * - Evaluator finds no "correct" chunks
 * - Any step fails (graceful fallback)
 */
async function enrichImagePromptWithKB(
  prompt: string,
  scopes: string[],
  minScore: number,
): Promise<string> {
  try {
    // 1. Vector search using the image prompt as query
    // biome-ignore lint/suspicious/noExplicitAny: KBScope is a string union
    const results = await searchKnowledgeBases({ query: prompt, scopes: scopes as any[] });
    if (!results.length) {
      log.info("No KB results for image prompt enrichment, using original prompt");
      return prompt;
    }

    // 2. Filter by minimum similarity score
    const aboveThreshold = results.filter((r) => r.score >= minScore);
    if (!aboveThreshold.length) {
      log.info("All KB results below score threshold, skipping enrichment", {
        threshold: minScore,
        top_score: results[0].score,
      });
      return prompt;
    }

    // 3. Run the research evaluator to classify chunks as correct/incorrect/ambiguous
    let relevantChunks = aboveThreshold;
    try {
      const researchLLM = getResearchLLMClient();
      // Create a no-op StepRecorder (throwaway session for audit purposes)
      const noopSession = {
        session_id: "image-enrich",
        original_query: prompt,
        scopes: [],
        config: {} as ResearchConfig,
        steps: [],
        status: "running" as const,
        created_at: new Date(),
      };
      const recorder = new StepRecorder("evaluation", 0, noopSession);
      const evaluation = await runEvaluator(
        prompt,
        aboveThreshold.slice(0, 10),
        { enable_crag: false } as ResearchConfig,
        researchLLM,
        recorder,
      );

      // Keep chunks not classified as "incorrect" (same criteria as research pipeline)
      const relevantEvals = evaluation.evaluations
        .filter((e) => e.relevance !== "incorrect")
        .map((e) => e.chunk);

      if (!relevantEvals.length) {
        log.info("Evaluator found no relevant chunks for image enrichment", {
          total: aboveThreshold.length,
          incorrect: evaluation.incorrect_count,
        });
        return prompt;
      }

      relevantChunks = relevantEvals;
      log.info("Evaluator filtered KB chunks for image enrichment", {
        input: aboveThreshold.length,
        kept: relevantEvals.length,
        incorrect: evaluation.incorrect_count,
      });
    } catch (evalErr: unknown) {
      log.warn("Evaluator failed, using score-filtered chunks for enrichment", {
        error: (evalErr as Error).message,
        chunks: aboveThreshold.length,
      });
      // Fall back to score-filtered chunks without evaluation
      relevantChunks = aboveThreshold.slice(0, 5);
    }

    // 4. Enrichment LLM call — rewrite the prompt with KB context
    const kbContext = relevantChunks
      .slice(0, 5)
      .map((r) => r.content)
      .join("\n---\n");

    const enrichmentModel = getModelForRole("research");
    const response = await recapLlmProvider!.chat({
      model: enrichmentModel,
      maxTokens: 1024,
      system:
        "You are an image prompt writer. You will receive an image generation prompt and relevant context " +
        "from a knowledge base. Rewrite the prompt to incorporate any useful visual details from the context. " +
        "Output ONLY the rewritten prompt — no commentary, no preamble.",
      tools: [],
      messages: [
        {
          role: "user",
          content: `Image prompt:\n${prompt}\n\nKnowledge base context:\n${kbContext}`,
        },
      ],
    });

    const enriched = response.text?.trim();
    if (enriched) {
      log.info("Image prompt enriched with KB context", {
        original_length: prompt.length,
        enriched_length: enriched.length,
        kb_chunks_used: relevantChunks.length,
      });
      return enriched;
    }
    return prompt;
  } catch (err: unknown) {
    log.warn("KB prompt enrichment failed, using original prompt", {
      error: (err as Error).message,
    });
    return prompt;
  }
}

// --- Executor: generate_image ---

async function executeGenerateImage(
  action: RoutedAction,
  ctx: CommandContext,
  execDef: GenerateImageExecution,
): Promise<CommandResult> {
  if (!imageGenProvider?.generateImage) {
    const reply = renderTemplate(
      execDef.reply_unsupported ||
        "⚠️ Image generation isn't available with the current model provider.",
      tplCtx(action, ctx),
    );
    return { reply: appendReply(action.reply, reply), actionTaken: "generate_image: unsupported" };
  }

  try {
    const model = getModelForRole("imageGeneration");
    let prompt = action.args.prompt || "";
    if (!prompt.trim()) {
      return {
        reply: appendReply(action.reply, "⚠️ I need a description of what to generate."),
        actionTaken: "generate_image: missing prompt",
      };
    }

    // Enrich prompt with KB context when kb_scopes is configured
    if (execDef.kb_scopes?.length && recapLlmProvider) {
      const minScore = execDef.kb_min_score ?? DEFAULT_KB_MIN_SCORE;
      prompt = await enrichImagePromptWithKB(prompt, execDef.kb_scopes, minScore);
    }

    const size = action.args.size || execDef.default_size || undefined;
    const quality = action.args.quality || execDef.default_quality || undefined;

    log.info("Generating image", { model, prompt: prompt.slice(0, 100), size, quality });

    const images = await imageGenProvider.generateImage({
      model,
      prompt,
      // biome-ignore lint/suspicious/noExplicitAny: dynamic param from YAML config
      size: size as any,
      // biome-ignore lint/suspicious/noExplicitAny: dynamic param from YAML config
      quality: quality as any,
    });

    if (!images.length || !images[0].base64) {
      return {
        reply: appendReply(action.reply, "⚠️ Image generation returned no results."),
        actionTaken: "generate_image: empty",
      };
    }

    const img = images[0];
    const conversationId = ctx.web?.conversationId;
    const imageRef = await storeGeneratedImage({
      base64: img.base64,
      mediaType: img.mediaType,
      prompt,
      revisedPrompt: img.revisedPrompt,
      model,
      createdBy: ctx.ownerId,
      conversationId,
    });

    const replyText = action.reply || img.revisedPrompt || "Here you go.";
    return {
      reply: replyText,
      actionTaken: "generate_image",
      images: [imageRef],
    };
  } catch (err: unknown) {
    log.error("Image generation failed", { error: (err as Error).message });
    const reply = renderTemplate(
      execDef.reply_error || "⚠️ Image generation failed: {{error}}",
      tplCtx(action, ctx, { error: (err as Error).message }),
    );
    return { reply: appendReply(action.reply, reply), actionTaken: "generate_image: failed" };
  }
}

// --- Executor: dispatch ---

async function executeDispatch(
  action: RoutedAction,
  ctx: CommandContext,
  execDef: DispatchExecution,
): Promise<CommandResult> {
  // Resolve the dispatch key from args (e.g. "args.query_type" → action.args.query_type)
  const keyPath = execDef.on;
  let dispatchValue: string | undefined;
  if (keyPath.startsWith("args.")) {
    dispatchValue = action.args[keyPath.slice(5)];
  } else {
    dispatchValue = action.args[keyPath];
  }

  if (!dispatchValue || !execDef.routes[dispatchValue]) {
    const reply = renderTemplate(
      execDef.reply_unknown || "⚠️ Unknown dispatch value: {{dispatch_value}}",
      tplCtx(action, ctx, { dispatch_value: dispatchValue }),
    );
    return { reply: appendReply(action.reply, reply), actionTaken: "dispatch: unknown" };
  }

  const subExecDef = execDef.routes[dispatchValue];
  return executeAction(action, ctx, subExecDef);
}

// --- Owner-only guard for job-mutating actions ---

const OWNER_ONLY_EXEC_TYPES = new Set([
  "create_job",
  "job_action",
  "create_respond_job",
  "agent_task",
]);

function requireOwner(ctx: CommandContext, execDef: ExecutionDef): CommandResult | null {
  if (!OWNER_ONLY_EXEC_TYPES.has(execDef.type)) return null;
  if (ctx.source === "web") return null; // web chat is always the owner
  if (ctx.userId === ctx.ownerId) return null;
  log.warn("Non-owner attempted job action", {
    userId: ctx.userId,
    ownerId: ctx.ownerId,
    source: ctx.source,
    execType: execDef.type,
  });
  return {
    reply: "⛔ Sorry, only the primary user can create or manage jobs.",
    actionTaken: "owner_only: denied",
  };
}

// --- Main dispatch function ---

/**
 * Execute an action based on its ExecutionDef from the YAML config.
 * This is the generic replacement for the switch statement in commandExecutor.ts.
 */
export async function executeAction(
  action: RoutedAction,
  ctx: CommandContext,
  execDef: ExecutionDef,
): Promise<CommandResult> {
  const denied = requireOwner(ctx, execDef);
  if (denied) return denied;

  switch (execDef.type) {
    case "reply":
      return executeReply(action, ctx, execDef);
    case "create_job":
      return executeCreateJob(action, ctx, execDef);
    case "job_action":
      return executeJobAction(action, ctx, execDef);
    case "job_query":
      return executeJobQuery(action, ctx, execDef);
    case "job_list":
      return executeJobList(action, ctx, execDef);
    case "create_respond_job":
      return executeCreateRespondJob(action, ctx, execDef);
    case "github_query":
      return executeGithubQuery(action, ctx, execDef);
    case "shell":
      return executeShell(action, ctx, execDef);
    case "webhook":
      return executeWebhook(action, ctx, execDef);
    case "agent_task":
      return executeAgentTask(action, ctx, execDef);
    case "leave_channel":
      return executeLeaveChannel(action, ctx, execDef);
    case "dispatch":
      return executeDispatch(action, ctx, execDef);
    case "generate_image":
      return executeGenerateImage(action, ctx, execDef);
    case "research":
      return executeResearch(action, ctx, execDef);
    default:
      // biome-ignore lint/suspicious/noExplicitAny: dynamic config type
      log.warn("Unknown execution type", { type: (execDef as any).type });
      return { reply: action.reply, actionTaken: "unknown_execution_type" };
  }
}
