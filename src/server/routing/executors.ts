/**
 * Generic execution primitives for YAML-driven action routing.
 *
 * Each executor is a small function that reads its configuration from the YAML
 * ExecutionDef and performs the corresponding action. The switch statement in
 * commandExecutor.ts is replaced by a lookup into this map.
 */

import { execFile } from "node:child_process";
import { createLogger } from "../../shared/logger.js";
import type { GithubQueryType } from "../../shared/types.js";
import { GITHUB_INSTANT_QUERIES, GITHUB_SUMMARY_QUERIES } from "../../shared/types.js";
import {
  executeInstantQuery,
  formatInstantQueryResult,
  GithubRateLimitError,
} from "../github/index.js";
import {
  cancel,
  confirmJob,
  createGithubSummaryJob,
  createJobFromSlack,
  createJobFromWeb,
  createRespondToCommentsJob,
  findJobByTaskId,
  promotePr,
  queryJobs,
  retry,
} from "../jobs/jobService.js";
import type { CommandContext, CommandResult } from "../slack/commandExecutor.js";
import type { RoutedAction } from "../slack/messageRouter.js";
import type {
  AgentTaskExecution,
  CreateJobExecution,
  CreateRespondJobExecution,
  DispatchExecution,
  ExecutionDef,
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

// --- Shared helpers ---

async function resolveTaskId(partial: string): Promise<string | null> {
  const exact = await findJobByTaskId(partial);
  if (exact) return exact.task_id;
  const { jobs } = await queryJobs({ limit: 50 });
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
    const job =
      ctx.source === "slack" && ctx.slack
        ? (
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
              custom_instructions: execDef.custom_instructions
                ? renderTemplate(execDef.custom_instructions, tplCtx(action, ctx))
                : undefined,
            })
          ).job
        : await createJobFromWeb({
            requested_by: ctx.ownerId,
            task_text: args.task_text || "(no task description)",
            repo_hint: args.repo_hint,
            test_level: args.test_level,
            reviewers: args.reviewers,
            needs_plan: execDef.needs_plan,
            custom_instructions: execDef.custom_instructions
              ? renderTemplate(execDef.custom_instructions, tplCtx(action, ctx))
              : undefined,
          });

    const reply = renderTemplate(
      execDef.reply_success || "📋 Task queued: `{{task_id:0:8}}…`",
      tplCtx(action, ctx, { task_id: job.task_id }),
    );
    return {
      reply: appendReply(action.reply, reply),
      actionTaken: `created job ${job.task_id}`,
      taskId: job.task_id,
    };
  } catch (err: any) {
    log.error("Failed to create job", { error: err.message });
    const reply = renderTemplate(
      execDef.reply_error || "⚠️ Failed to queue task: {{error}}",
      tplCtx(action, ctx, { error: err.message }),
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
  } catch (err: any) {
    log.error(`Failed to ${execDef.method} job`, { error: err.message });
    const reply = renderTemplate(
      execDef.reply_error || "⚠️ Failed: {{error}}",
      tplCtx(action, ctx, { task_id: taskId, error: err.message }),
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
  ctx: CommandContext,
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
    const job = await createRespondToCommentsJob(
      { requested_by: ctx.ownerId, pr_url: prUrl, parent_task_id: parentTaskId },
      ctx.source,
      slackThread,
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
  } catch (err: any) {
    log.error("Failed to create respond-to-comments job", { error: err.message });
    const reply = renderTemplate(
      execDef.reply_error || "⚠️ Failed: {{error}}",
      tplCtx(action, ctx, { error: err.message }),
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

  // Instant queries
  if (instantTypes.includes(queryType)) {
    try {
      const result = executeInstantQuery(queryType, {
        githubUsername: ctx.githubUsername,
        org: action.args.org || ctx.githubOrg,
        team_slug: action.args.team_slug || ctx.githubTeamSlug,
        time_range: action.args.time_range,
      });
      const formatted = formatInstantQueryResult(result);
      return {
        reply: action.reply ? appendReply(action.reply, formatted) : formatted,
        actionTaken: `github: ${queryType} (${result.prs?.length ?? 0} results)`,
      };
    } catch (err: any) {
      log.error("GitHub instant query failed", { queryType, error: err.message });
      const isRateLimit = err instanceof GithubRateLimitError;
      const template = isRateLimit
        ? execDef.reply_rate_limited ||
          "⏳ GitHub API rate limit reached — try again in a minute or two."
        : execDef.reply_error || "⚠️ GitHub query failed: {{error}}";
      const reply = renderTemplate(template, tplCtx(action, ctx, { error: err.message }));
      return {
        reply: appendReply(action.reply, reply),
        actionTaken: `github: ${queryType} ${isRateLimit ? "rate_limited" : "failed"}`,
      };
    }
  }

  // Summary queries
  if (summaryTypes.includes(queryType)) {
    try {
      const slackThread =
        ctx.source === "slack" && ctx.slack
          ? { channel_id: ctx.slack.channelId, thread_ts: ctx.slack.threadTs }
          : undefined;
      const job = await createGithubSummaryJob(
        {
          requested_by: ctx.ownerId,
          query_type: queryType as "my_recap" | "team_recap",
          time_range: action.args.time_range,
          org: action.args.org || ctx.githubOrg,
          team_slug: action.args.team_slug || ctx.githubTeamSlug,
          github_username: ctx.githubUsername,
        },
        ctx.source,
        slackThread,
      );
      const reply = renderTemplate(
        execDef.reply_summary_queued || "📊 Recap queued: `{{task_id:0:8}}…`",
        tplCtx(action, ctx, { task_id: job.task_id, query_type: queryType }),
      );
      return {
        reply: appendReply(action.reply, reply),
        actionTaken: `github: ${queryType} job ${job.task_id}`,
        taskId: job.task_id,
      };
    } catch (err: any) {
      log.error("GitHub summary job creation failed", { queryType, error: err.message });
      const reply = renderTemplate(
        execDef.reply_error || "⚠️ Failed to queue recap: {{error}}",
        tplCtx(action, ctx, { error: err.message }),
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
        log.error("Shell execution failed", { command, error: err.message });
        const reply = renderTemplate(
          execDef.reply_error || "⚠️ Command failed: {{error}}",
          tplCtx(action, ctx, { error: err.message, stderr }),
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
  } catch (err: any) {
    log.error("Webhook execution failed", { error: err.message });
    const reply = renderTemplate(
      execDef.reply_error || "⚠️ Webhook failed: {{error}}",
      tplCtx(action, ctx, { error: err.message }),
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

    const job =
      ctx.source === "slack" && ctx.slack
        ? (
            await createJobFromSlack({
              event_id: ctx.eventId,
              requested_by: ctx.userId,
              slack_requester: ctx.userId,
              task_text: taskText,
              channel_id: ctx.slack.channelId,
              thread_ts: ctx.slack.threadTs,
              message_ts: ctx.slack.messageTs,
              repo_hint: repoHint,
              test_level: (execDef.test_level || action.args.test_level) as any,
              reviewers: execDef.reviewers || action.args.reviewers,
              attachments: ctx.attachments,
              custom_instructions: instructions,
            })
          ).job
        : await createJobFromWeb({
            requested_by: ctx.ownerId,
            task_text: taskText,
            repo_hint: repoHint,
            test_level: (execDef.test_level || action.args.test_level) as any,
            reviewers: execDef.reviewers || action.args.reviewers,
            custom_instructions: instructions,
          });

    const reply = renderTemplate(
      execDef.reply_queued || "📋 Task queued: `{{task_id:0:8}}…`",
      tplCtx(action, ctx, { task_id: job.task_id }),
    );
    return {
      reply: appendReply(action.reply, reply),
      actionTaken: `agent_task: ${job.task_id}`,
      taskId: job.task_id,
    };
  } catch (err: any) {
    log.error("Failed to create agent task", { error: err.message });
    const reply = renderTemplate(
      execDef.reply_error || "⚠️ Failed: {{error}}",
      tplCtx(action, ctx, { error: err.message }),
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
  } catch (err: any) {
    log.error("Failed to leave channel", { error: err.message, channel: ctx.slack.channelId });
    const reply = renderTemplate(
      execDef.reply_error || "Couldn't leave the channel: {{error}}",
      tplCtx(action, ctx, { error: err.message }),
    );
    return { reply: appendReply(action.reply, reply), actionTaken: "leave_channel: failed" };
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
    default:
      log.warn("Unknown execution type", { type: (execDef as any).type });
      return { reply: action.reply, actionTaken: "unknown_execution_type" };
  }
}
