import { createLogger } from "../../shared/logger.js";
import type { GithubQueryType, JobAttachment } from "../../shared/types.js";
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
import type { RoutedAction } from "./messageRouter.js";

const log = createLogger("server:slack:commands");

export interface CommandResult {
  reply: string;
  actionTaken: string;
  taskId?: string;
}

export interface CommandContext {
  userId: string;
  ownerId: string;
  source: "slack" | "web";
  eventId: string;
  attachments?: JobAttachment[];
  slack?: { channelId: string; threadTs: string; messageTs: string };
  web?: { conversationId: string };
  githubUsername?: string;
  githubOrg?: string;
  githubTeamSlug?: string;
}

async function resolveTaskId(partial: string): Promise<string | null> {
  // Try exact match first
  const exact = await findJobByTaskId(partial);
  if (exact) return exact.task_id;

  // Try prefix match via query
  const { jobs } = await queryJobs({ limit: 50 });
  const match = jobs.find((j: any) => j.task_id.startsWith(partial));
  return match?.task_id || null;
}

export async function executeCommand(
  action: RoutedAction,
  ctx: CommandContext,
): Promise<CommandResult> {
  const { command, args, reply } = action;

  switch (command) {
    case "create_job": {
      try {
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
                })
              ).job
            : await createJobFromWeb({
                requested_by: ctx.ownerId,
                task_text: args.task_text || "(no task description)",
                repo_hint: args.repo_hint,
                test_level: args.test_level,
                reviewers: args.reviewers,
              });
        return {
          reply: `${reply}\n\n📋 Task queued: \`${job.task_id.slice(0, 8)}…\``,
          actionTaken: `created job ${job.task_id}`,
          taskId: job.task_id,
        };
      } catch (err: any) {
        log.error("Failed to create job", { error: err.message });
        return {
          reply: `${reply}\n\n⚠️ Failed to queue task: ${err.message}`,
          actionTaken: "create_job failed",
        };
      }
    }

    case "plan_job": {
      try {
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
                  needs_plan: true,
                })
              ).job
            : await createJobFromWeb({
                requested_by: ctx.ownerId,
                task_text: args.task_text || "(no task description)",
                repo_hint: args.repo_hint,
                test_level: args.test_level,
                reviewers: args.reviewers,
                needs_plan: true,
              });
        return {
          reply: `${reply}\n\n📋 Planning task: \`${job.task_id.slice(0, 8)}…\` — I'll analyze the codebase and propose a plan.`,
          actionTaken: `plan_job ${job.task_id}`,
          taskId: job.task_id,
        };
      } catch (err: any) {
        log.error("Failed to create plan job", { error: err.message });
        return {
          reply: `${reply}\n\n⚠️ Failed to queue planning task: ${err.message}`,
          actionTaken: "plan_job failed",
        };
      }
    }

    case "confirm_job": {
      const taskId = await resolveTaskId(args.task_id || "");
      if (!taskId) {
        return {
          reply: `${reply}\n\n❓ Couldn't find a job matching \`${args.task_id}\`.`,
          actionTaken: "confirm_job: not found",
        };
      }
      const existing = await findJobByTaskId(taskId);
      if (!existing || existing.status !== "PENDING_CONFIRMATION") {
        return {
          reply: `${reply}\n\n⚠️ \`${taskId.slice(0, 8)}…\` isn't awaiting confirmation (status: ${existing?.status || "not found"}).`,
          actionTaken: "confirm_job: wrong status",
        };
      }
      try {
        await confirmJob(taskId, args.revised_task_text);
        return {
          reply: `${reply}\n\n✅ Plan confirmed — executing \`${taskId.slice(0, 8)}…\``,
          actionTaken: `confirm_job: ${taskId}`,
          taskId,
        };
      } catch (err: any) {
        log.error("Failed to confirm job", { error: err.message });
        return {
          reply: `${reply}\n\n⚠️ Failed to confirm: ${err.message}`,
          actionTaken: "confirm_job failed",
        };
      }
    }

    case "job_status": {
      const taskId = await resolveTaskId(args.task_id || "");
      if (!taskId) {
        return {
          reply: `${reply}\n\n❓ Couldn't find a job matching \`${args.task_id}\`.`,
          actionTaken: "job_status: not found",
        };
      }
      const job = await findJobByTaskId(taskId);
      if (!job) {
        return {
          reply: `${reply}\n\n❓ Job \`${taskId.slice(0, 8)}…\` not found.`,
          actionTaken: "job_status: not found",
        };
      }
      const prs = job.pr_urls?.length ? `\nPRs: ${job.pr_urls.join(", ")}` : "";
      const err = job.error?.message ? `\nError: ${job.error.message.slice(0, 200)}` : "";
      const claimed = job.claimed_by ? ` (worker: \`${job.claimed_by}\`)` : "";
      return {
        reply: `${reply}\n\n📊 *\`${taskId.slice(0, 8)}…\`* — *${job.status}*${claimed}\nTask: ${job.task_text?.slice(0, 120)}${prs}${err}`,
        actionTaken: `job_status: ${taskId}`,
      };
    }

    case "cancel_job": {
      const taskId = await resolveTaskId(args.task_id || "");
      if (!taskId) {
        return {
          reply: `${reply}\n\n❓ Couldn't find a job matching \`${args.task_id}\`.`,
          actionTaken: "cancel_job: not found",
        };
      }
      const job = await cancel(taskId);
      if (!job) {
        return {
          reply: `${reply}\n\n⚠️ Couldn't cancel \`${taskId.slice(0, 8)}…\` — it may already be done or canceled.`,
          actionTaken: "cancel_job: no-op",
        };
      }
      return {
        reply: `${reply}\n\n⛔ Canceled \`${taskId.slice(0, 8)}…\`.`,
        actionTaken: `cancel_job: ${taskId}`,
      };
    }

    case "retry_job": {
      const taskId = await resolveTaskId(args.task_id || "");
      if (!taskId) {
        return {
          reply: `${reply}\n\n❓ Couldn't find a job matching \`${args.task_id}\`.`,
          actionTaken: "retry_job: not found",
        };
      }
      const newJob = await retry(taskId);
      if (!newJob) {
        return {
          reply: `${reply}\n\n⚠️ Couldn't retry \`${taskId.slice(0, 8)}…\` — only failed or canceled jobs can be retried.`,
          actionTaken: "retry_job: not eligible",
        };
      }
      return {
        reply: `${reply}\n\n🔄 Retried as \`${newJob.task_id.slice(0, 8)}…\`.`,
        actionTaken: `retry_job: ${newJob.task_id}`,
      };
    }

    case "promote_pr": {
      const taskId = await resolveTaskId(args.task_id || "");
      if (!taskId) {
        return {
          reply: `${reply}\n\n❓ Couldn't find a job matching \`${args.task_id}\`.`,
          actionTaken: "promote_pr: not found",
        };
      }
      const existing = await findJobByTaskId(taskId);
      if (!existing || existing.status !== "WAITING_FOR_APPROVAL") {
        return {
          reply: `${reply}\n\n⚠️ \`${taskId.slice(0, 8)}…\` isn't waiting for approval (status: ${existing?.status || "not found"}).`,
          actionTaken: "promote_pr: wrong status",
        };
      }
      if (!existing.pr_urls?.length) {
        return {
          reply: `${reply}\n\n⚠️ No PR URL on \`${taskId.slice(0, 8)}…\`.`,
          actionTaken: "promote_pr: no pr",
        };
      }
      try {
        const { promotePr: ghPromotePr } = await import("../../worker/executor/pr.js");
        ghPromotePr(existing.pr_urls[0], args.reviewers);
        await promotePr(taskId, args.reviewers);
        return {
          reply: `${reply}\n\n✅ PR promoted to ready-for-review: ${existing.pr_urls[0]}`,
          actionTaken: `promote_pr: ${taskId}`,
        };
      } catch (err: any) {
        log.error("Failed to promote PR", { error: err.message });
        return {
          reply: `${reply}\n\n⚠️ Failed to promote PR: ${err.message}`,
          actionTaken: "promote_pr failed",
        };
      }
    }

    case "respond_to_pr_comments": {
      try {
        let prUrl: string | undefined = args.pr_url;
        let parentTaskId: string | undefined;

        // If task_id provided, resolve PR URL from the parent job
        if (args.task_id && !prUrl) {
          const taskId = await resolveTaskId(args.task_id);
          if (!taskId) {
            return {
              reply: `${reply}\n\n❓ Couldn't find a job matching \`${args.task_id}\`.`,
              actionTaken: "respond_to_pr_comments: not found",
            };
          }
          const parentJob = await findJobByTaskId(taskId);
          if (!parentJob?.pr_urls?.length) {
            return {
              reply: `${reply}\n\n⚠️ No PR URL on \`${taskId.slice(0, 8)}…\`.`,
              actionTaken: "respond_to_pr_comments: no pr",
            };
          }
          prUrl = parentJob.pr_urls[0];
          parentTaskId = taskId;
        }

        if (!prUrl) {
          return {
            reply: `${reply}\n\n⚠️ I need either a task_id or a PR URL to respond to comments.`,
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
        return {
          reply: `${reply}\n\n📋 Respond-to-comments job queued: \`${job.task_id.slice(0, 8)}…\`\nPR: ${prUrl}`,
          actionTaken: `respond_to_pr_comments: ${job.task_id}`,
          taskId: job.task_id,
        };
      } catch (err: any) {
        log.error("Failed to create respond-to-comments job", { error: err.message });
        return {
          reply: `${reply}\n\n⚠️ Failed: ${err.message}`,
          actionTaken: "respond_to_pr_comments failed",
        };
      }
    }

    case "github": {
      const queryType = args.query_type as GithubQueryType;
      if (!queryType) {
        return {
          reply: `${reply}\n\n⚠️ Missing query_type for GitHub query.`,
          actionTaken: "github: missing query_type",
        };
      }

      // Instant queries — execute directly and return results
      if ((GITHUB_INSTANT_QUERIES as readonly string[]).includes(queryType)) {
        try {
          const result = executeInstantQuery(queryType, {
            githubUsername: ctx.githubUsername,
            org: args.org || ctx.githubOrg,
            team_slug: args.team_slug || ctx.githubTeamSlug,
            time_range: args.time_range,
          });
          const formatted = formatInstantQueryResult(result);
          return {
            reply: reply ? `${reply}\n\n${formatted}` : formatted,
            actionTaken: `github: ${queryType} (${result.prs?.length ?? 0} results)`,
          };
        } catch (err: any) {
          log.error("GitHub instant query failed", { queryType, error: err.message });
          const isRateLimit = err instanceof GithubRateLimitError;
          const msg = isRateLimit
            ? "⏳ GitHub API rate limit reached — try again in a minute or two."
            : `⚠️ GitHub query failed: ${err.message}`;
          return {
            reply: `${reply}\n\n${msg}`,
            actionTaken: `github: ${queryType} ${isRateLimit ? "rate_limited" : "failed"}`,
          };
        }
      }

      // Summary queries — queue as a github_summary job
      if ((GITHUB_SUMMARY_QUERIES as readonly string[]).includes(queryType)) {
        try {
          const slackThread =
            ctx.source === "slack" && ctx.slack
              ? { channel_id: ctx.slack.channelId, thread_ts: ctx.slack.threadTs }
              : undefined;
          const job = await createGithubSummaryJob(
            {
              requested_by: ctx.ownerId,
              query_type: queryType as "my_recap" | "team_recap",
              time_range: args.time_range,
              org: args.org || ctx.githubOrg,
              team_slug: args.team_slug || ctx.githubTeamSlug,
              github_username: ctx.githubUsername,
            },
            ctx.source,
            slackThread,
          );
          return {
            reply: `${reply}\n\n📊 Recap queued: \`${job.task_id.slice(0, 8)}…\` — I'll crunch the numbers and post the summary shortly.`,
            actionTaken: `github: ${queryType} job ${job.task_id}`,
            taskId: job.task_id,
          };
        } catch (err: any) {
          log.error("GitHub summary job creation failed", { queryType, error: err.message });
          return {
            reply: `${reply}\n\n⚠️ Failed to queue recap: ${err.message}`,
            actionTaken: `github: ${queryType} failed`,
          };
        }
      }

      return {
        reply: `${reply}\n\n⚠️ Unknown GitHub query type: ${queryType}`,
        actionTaken: `github: unknown query_type ${queryType}`,
      };
    }

    case "list_jobs": {
      const limit = args.limit || 5;
      const { jobs } = await queryJobs({ limit });
      if (!jobs.length) {
        return { reply: `${reply}\n\n_(No jobs found)_`, actionTaken: "list_jobs: empty" };
      }
      const lines = jobs.map((j: any) => {
        const prs = j.pr_urls?.length ? ` | ${j.pr_urls[0]}` : "";
        return `• \`${j.task_id.slice(0, 8)}…\` *${j.status}* — ${j.task_text?.slice(0, 60)}${prs}`;
      });
      return {
        reply: `${reply}\n\n${lines.join("\n")}`,
        actionTaken: `list_jobs: ${jobs.length} results`,
      };
    }

    case "no_op":
      return { reply: "", actionTaken: `no_op: ${args.reason || "not relevant"}` };
    default:
      return { reply, actionTaken: "chat" };
  }
}
