import { v4 as uuidv4 } from "uuid";
import { createLogger } from "../../shared/logger.js";
import { addSeconds, nowDate } from "../../shared/time.js";
import type {
  CIInfo,
  JobDoc,
  JobError,
  JobEvent,
  JobMetrics,
  WorkerEventType,
} from "../../shared/types.js";
import { SLACK_NOTIFY_EVENTS } from "../../shared/types.js";
import { notifyConversations } from "../chat/conversationNotifier.js";
import type { SlackPoster } from "../slack/slackClient.js";
import { checkIdempotent } from "./idempotency.js";
import type {
  CreateAddReviewComments,
  CreateGithubSummary,
  CreateJobFromSlack,
  CreateJobFromWeb,
  CreateRespondToCommentsFromWeb,
  CreateSelfReviewPr,
} from "./jobModel.js";
import {
  appendEvent,
  findJobByTaskId,
  findPollableJobs,
  getDistinctRequestedBy,
  insertJob,
  queryJobs,
  awaitApprovalJob as repoAwaitApprovalJob,
  cancelJob as repoCancelJob,
  completeJob as repoCompleteJob,
  confirmJobPlan as repoConfirmJobPlan,
  failJob as repoFailJob,
  promoteJob as repoPromoteJob,
  requeueJob as repoRequeueJob,
  softDeleteJob as repoSoftDeleteJob,
  submitPlanJob as repoSubmitPlanJob,
  updateJobFields,
} from "./jobRepo.js";
import { claimJob, extendLease } from "./lease.js";
import { generateTitle } from "./titleGenerator.js";

const log = createLogger("server:jobService");

let slackPoster: SlackPoster | null = null;

export function setSlackPoster(poster: SlackPoster) {
  slackPoster = poster;
}

// --- Create from Slack ---
export async function createJobFromSlack(
  input: CreateJobFromSlack,
): Promise<{ job: JobDoc; created: boolean }> {
  // Idempotency check
  const existing = await checkIdempotent(input.event_id);
  if (existing) {
    log.info("Duplicate Slack event, returning existing job", {
      event_id: input.event_id,
      task_id: existing.task_id,
    });
    return { job: existing, created: false };
  }

  const now = nowDate();
  const taskId = uuidv4();

  const doc: JobDoc = {
    task_id: taskId,
    source: { type: "slack_app_mention", event_id: input.event_id },
    requested_by: input.requested_by,
    slack_requester: input.slack_requester,
    status: "QUEUED",
    created_at: now,
    updated_at: now,
    slack: {
      channel_id: input.channel_id,
      thread_ts: input.thread_ts,
      message_ts: input.message_ts,
    },
    task_text: input.task_text,
    repo_hint: input.repo_hint,
    test_level: input.test_level,
    ci_fix_enabled: input.ci_fix_enabled ?? true,
    reviewers: input.reviewers,
    attachments: input.attachments,
    ...(input.needs_plan ? { needs_plan: true } : {}),
    ...(input.custom_instructions ? { custom_instructions: input.custom_instructions } : {}),
    events: [{ at: now, type: "QUEUED", payload: { source: "slack" } }],
  };

  try {
    const job = await insertJob(doc);
    log.info("Job created from Slack", {
      task_id: taskId,
      event_id: input.event_id,
      attachments: input.attachments?.length || 0,
    });

    // Post queued message to Slack
    if (slackPoster && job.slack?.channel_id && job.slack?.thread_ts) {
      await slackPoster.postQueued(job);
    }

    // Fire-and-forget title generation
    generateTitle(taskId, input.task_text).catch(() => {});

    return { job, created: true };
  } catch (err: unknown) {
    // Handle duplicate key error (race condition on event_id)
    if ((err as { code?: number }).code === 11000) {
      const existing = await checkIdempotent(input.event_id);
      if (existing) return { job: existing, created: false };
    }
    throw err;
  }
}

// --- Create from Web ---
export async function createJobFromWeb(input: CreateJobFromWeb): Promise<JobDoc> {
  const now = nowDate();
  const taskId = uuidv4();

  const doc: JobDoc = {
    task_id: taskId,
    source: { type: "web_create" },
    requested_by: input.requested_by,
    status: "QUEUED",
    created_at: now,
    updated_at: now,
    task_text: input.task_text,
    repo_hint: input.repo_hint,
    test_level: input.test_level,
    ci_fix_enabled: input.ci_fix_enabled ?? true,
    reviewers: input.reviewers,
    ...(input.needs_plan ? { needs_plan: true } : {}),
    ...(input.custom_instructions ? { custom_instructions: input.custom_instructions } : {}),
    events: [{ at: now, type: "QUEUED", payload: { source: "web" } }],
  };

  const job = await insertJob(doc);
  log.info("Job created from web", { task_id: taskId });

  // Fire-and-forget title generation
  generateTitle(taskId, input.task_text).catch(() => {});

  return job;
}

function extractPrLabel(prUrl: string): { prNum: string; repoName: string } {
  const prMatch = prUrl.match(/\/pull\/(\d+)/);
  const prNum = prMatch ? `#${prMatch[1]}` : "";
  const repoMatch = prUrl.match(/github\.com\/[^/]+\/([^/]+)/);
  const repoName = repoMatch ? repoMatch[1] : "";
  return { prNum, repoName };
}

// --- Create Respond-to-Comments Job ---
export async function createRespondToCommentsJob(
  input: CreateRespondToCommentsFromWeb,
  source: "web" | "slack" = "web",
  slack?: { channel_id: string; thread_ts: string },
): Promise<JobDoc> {
  const now = nowDate();
  const taskId = uuidv4();
  const { prNum, repoName } = extractPrLabel(input.pr_url);
  const title = `Respond to PR comments — ${repoName}${prNum}`;

  const doc: JobDoc = {
    task_id: taskId,
    job_type: "respond_to_pr_comments",
    source: { type: source === "slack" ? "slack_app_mention" : "web_create" },
    requested_by: input.requested_by,
    status: "QUEUED",
    created_at: now,
    updated_at: now,
    title,
    task_text: `Respond to unresolved PR review comments on ${input.pr_url}`,
    pr_url: input.pr_url,
    parent_task_id: input.parent_task_id,
    ...(slack ? { slack: { channel_id: slack.channel_id, thread_ts: slack.thread_ts } } : {}),
    events: [{ at: now, type: "QUEUED", payload: { source } }],
  };

  const job = await insertJob(doc);
  log.info("Respond-to-comments job created", {
    task_id: taskId,
    pr_url: input.pr_url,
    status: job.status,
  });

  if (slackPoster && job.slack?.channel_id && job.slack?.thread_ts) {
    await slackPoster.postQueued(job);
  }

  return job;
}

// --- Create Self-Review PR Job ---
export async function createSelfReviewPrJob(input: CreateSelfReviewPr): Promise<JobDoc> {
  const now = nowDate();
  const taskId = uuidv4();
  const { prNum, repoName } = extractPrLabel(input.pr_url);
  const title = `Self-review PR — ${repoName}${prNum}`;

  const doc: JobDoc = {
    task_id: taskId,
    job_type: "self_review_pr",
    source: { type: "web_create" },
    requested_by: input.requested_by,
    status: "QUEUED",
    created_at: now,
    updated_at: now,
    title,
    task_text: `Self-review and fix issues in PR ${input.pr_url}`,
    pr_url: input.pr_url,
    events: [{ at: now, type: "QUEUED", payload: { source: "web" } }],
  };

  const job = await insertJob(doc);
  log.info("Self-review PR job created", {
    task_id: taskId,
    pr_url: input.pr_url,
    status: job.status,
  });
  return job;
}

// --- Create Add-Review-Comments Job ---
export async function createAddReviewCommentsJob(input: CreateAddReviewComments): Promise<JobDoc> {
  const now = nowDate();
  const taskId = uuidv4();
  const { prNum, repoName } = extractPrLabel(input.pr_url);
  const title = `Add review comments — ${repoName}${prNum}`;

  const doc: JobDoc = {
    task_id: taskId,
    job_type: "add_pr_review_comments",
    source: { type: "web_create" },
    requested_by: input.requested_by,
    status: "QUEUED",
    created_at: now,
    updated_at: now,
    title,
    task_text: `Analyze and post inline review comments on PR ${input.pr_url}`,
    pr_url: input.pr_url,
    events: [{ at: now, type: "QUEUED", payload: { source: "web" } }],
  };

  const job = await insertJob(doc);
  log.info("Add-review-comments job created", {
    task_id: taskId,
    pr_url: input.pr_url,
    status: job.status,
  });
  return job;
}

// --- Create GitHub Summary Job ---
export async function createGithubSummaryJob(
  input: CreateGithubSummary,
  source: "web" | "slack" = "web",
  slack?: { channel_id: string; thread_ts: string },
): Promise<JobDoc> {
  const now = nowDate();
  const taskId = uuidv4();

  const queryLabel = input.query_type === "my_recap" ? "My recap" : "Team recap";
  const range = input.time_range || "7d";
  const title = `${queryLabel} (${range})`;

  const doc: JobDoc = {
    task_id: taskId,
    job_type: "github_summary",
    source: { type: source === "slack" ? "slack_app_mention" : "web_create" },
    requested_by: input.requested_by,
    status: "QUEUED",
    created_at: now,
    updated_at: now,
    title,
    task_text: `Generate ${queryLabel.toLowerCase()} for the past ${range}`,
    github_query: {
      query_type: input.query_type,
      time_range: input.time_range,
      org: input.org,
      team_slug: input.team_slug,
      github_username: input.github_username,
    },
    ...(slack ? { slack: { channel_id: slack.channel_id, thread_ts: slack.thread_ts } } : {}),
    events: [{ at: now, type: "QUEUED", payload: { source } }],
  };

  const job = await insertJob(doc);
  log.info("GitHub summary job created", { task_id: taskId, query_type: input.query_type });

  if (slackPoster && job.slack?.channel_id && job.slack?.thread_ts) {
    await slackPoster.postQueued(job);
  }

  return job;
}

// --- Poll ---
export async function pollJobs(requestedBy: string, limit: number) {
  return findPollableJobs(requestedBy, limit);
}

// --- Claim ---
export async function claim(
  taskId: string,
  requestedBy: string,
  nodeId: string,
  leaseSeconds: number,
) {
  const job = await claimJob(taskId, requestedBy, nodeId, leaseSeconds);
  if (job) {
    if (slackPoster && job.slack?.channel_id && job.slack?.thread_ts) {
      // Only post "Claimed" on first real claim to avoid spamming on requeue cycles
      if ((job.attempt || 1) <= 1) {
        await slackPoster.postClaimed(job);
      }
    }
    if ((job.attempt || 1) <= 1) {
      notifyConversations(job, "CLAIMED").catch(() => {});
    }
  }
  return job;
}

// --- Heartbeat ---
export async function heartbeat(taskId: string, nodeId: string, extendSeconds: number) {
  return extendLease(taskId, nodeId, extendSeconds);
}

// --- Worker Event ---
export async function handleWorkerEvent(
  taskId: string,
  nodeId: string,
  type: string,
  // biome-ignore lint/suspicious/noExplicitAny: dynamic payload type
  payload?: any,
) {
  const now = nowDate();
  const event: JobEvent = { at: now, node_id: nodeId, type, payload };
  await appendEvent(taskId, event);

  // Fetch job once for field updates and Slack notifications
  const needsJob =
    type === "PR_CREATED" ||
    type === "REPO_RESOLVED" ||
    SLACK_NOTIFY_EVENTS.includes(type as WorkerEventType);
  const job = needsJob ? await findJobByTaskId(taskId) : null;

  // Update job fields based on event type
  const updates: Partial<JobDoc> = {};
  if (type === "PR_CREATED" && payload?.url) {
    const existing = job?.pr_urls || [];
    if (!existing.includes(payload.url)) {
      updates.pr_urls = [...existing, payload.url];
    }
  }
  if (type === "CI_STATUS" && payload) {
    updates.ci = payload;
  }
  if (type === "REPO_RESOLVED" && payload?.repoId) {
    const existing = job?.repos_resolved || [];
    if (!existing.includes(payload.repoId)) {
      updates.repos_resolved = [...existing, payload.repoId];
    }
  }
  if (type === "WORKTREE_READY") {
    if (payload?.branch) updates.branch_name = payload.branch;
    if (payload?.worktree_slot) updates.worktree_slot = payload.worktree_slot;
  }
  if (type === "CI_FIX_STARTED") {
    updates.status = "FIXING_CI";
  }

  if (Object.keys(updates).length > 0) {
    await updateJobFields(taskId, updates);
  }

  // Slack notifications for key events
  if (SLACK_NOTIFY_EVENTS.includes(type as WorkerEventType) && slackPoster && job) {
    if (job.slack?.channel_id && job.slack?.thread_ts) {
      await slackPoster.postEvent(job, type, payload);
    }
  }

  // Conversation notifications for key events
  if (["PR_CREATED", "CI_FAILED"].includes(type) && job) {
    notifyConversations(job, type).catch(() => {});
  }
}

// --- Await Approval ---
export async function awaitApproval(
  taskId: string,
  nodeId: string,
  data: { result_summary: string; pr_urls?: string[]; ci?: CIInfo; metrics?: JobMetrics },
) {
  const job = await repoAwaitApprovalJob(taskId, nodeId, data);
  if (job) {
    await appendEvent(taskId, {
      at: nowDate(),
      node_id: nodeId,
      type: "WAITING_FOR_APPROVAL",
      payload: { pr_urls: data.pr_urls },
    });
    if (slackPoster && job.slack?.channel_id && job.slack?.thread_ts) {
      const prs = job.pr_urls?.length ? `\nDraft PR: ${job.pr_urls.join(", ")}` : "";
      await slackPoster.postEvent(job, "WAITING_FOR_APPROVAL", {
        message: `Awaiting approval ⏳ \`task_id=${job.task_id}\`${prs}\nReply here to promote, or use the web dashboard.`,
      });
    }
    notifyConversations(job, "WAITING_FOR_APPROVAL").catch(() => {});
  }
  return job;
}

// --- Promote PR ---
export async function promotePr(taskId: string, reviewers?: string[]) {
  const job = await repoPromoteJob(taskId);
  if (job) {
    await appendEvent(taskId, {
      at: nowDate(),
      type: "PR_PROMOTED",
      payload: { reviewers },
    });
    if (slackPoster && job.slack?.channel_id && job.slack?.thread_ts) {
      const prs = job.pr_urls?.length ? `\n${job.pr_urls.join(", ")}` : "";
      await slackPoster.postEvent(job, "PR_PROMOTED", {
        message: `PR promoted to ready-for-review ✅ \`task_id=${job.task_id}\`${prs}`,
      });
    }
    notifyConversations(job, "PR_PROMOTED").catch(() => {});
  }
  return job;
}

// --- Complete ---
export async function complete(
  taskId: string,
  nodeId: string,
  data: { result_summary: string; pr_urls?: string[]; ci?: CIInfo; metrics?: JobMetrics },
) {
  const job = await repoCompleteJob(taskId, nodeId, data);
  if (job) {
    await appendEvent(taskId, {
      at: nowDate(),
      node_id: nodeId,
      type: "DONE",
      payload: { summary: data.result_summary },
    });
    if (slackPoster && job.slack?.channel_id && job.slack?.thread_ts) {
      await slackPoster.postDone(job);
    }
    notifyConversations(job, "DONE").catch(() => {});
  }
  return job;
}

// --- Fail ---
export async function fail(
  taskId: string,
  nodeId: string,
  data: { error: JobError; pr_urls?: string[]; ci?: CIInfo; metrics?: JobMetrics },
) {
  const job = await repoFailJob(taskId, nodeId, data);
  if (job) {
    await appendEvent(taskId, {
      at: nowDate(),
      node_id: nodeId,
      type: "FAILED",
      payload: data.error,
    });
    if (slackPoster && job.slack?.channel_id && job.slack?.thread_ts) {
      await slackPoster.postFailed(job);
    }
    notifyConversations(job, "FAILED").catch(() => {});
  }
  return job;
}

// --- Requeue (worker releasing a claimed job back to QUEUED) ---
export async function requeue(taskId: string, nodeId: string, reason: string, backoffSeconds = 30) {
  const notBefore = addSeconds(nowDate(), backoffSeconds);
  const job = await repoRequeueJob(taskId, nodeId, notBefore);
  if (job) {
    await appendEvent(taskId, {
      at: nowDate(),
      node_id: nodeId,
      type: "REQUEUED",
      payload: { reason, not_before: notBefore.toISOString() },
    });
    log.info("Job requeued with backoff", {
      task_id: taskId,
      reason,
      not_before: notBefore.toISOString(),
    });
  }
  return job;
}

// --- Cancel ---
export async function cancel(taskId: string) {
  const job = await repoCancelJob(taskId);
  if (job) {
    await appendEvent(taskId, { at: nowDate(), type: "CANCELED" });
    if (slackPoster && job.slack?.channel_id && job.slack?.thread_ts) {
      await slackPoster.postCanceled(job);
    }
    notifyConversations(job, "CANCELED").catch(() => {});
  }
  return job;
}

// --- Soft Delete ---
export async function softDelete(taskId: string) {
  return repoSoftDeleteJob(taskId);
}

// --- Retry ---
export async function retry(taskId: string): Promise<JobDoc | null> {
  const original = await findJobByTaskId(taskId);
  if (!original) return null;
  if (!["FAILED", "CANCELED"].includes(original.status)) return null;

  const now = nowDate();
  const newTaskId = uuidv4();

  const doc: JobDoc = {
    task_id: newTaskId,
    source: original.source.event_id ? { type: original.source.type } : original.source,
    requested_by: original.requested_by,
    status: "QUEUED",
    created_at: now,
    updated_at: now,
    slack: original.slack,
    title: original.title,
    task_text: original.task_text,
    repo_hint: original.repo_hint,
    test_level: original.test_level,
    ci_fix_enabled: original.ci_fix_enabled,
    reviewers: original.reviewers,
    parent_task_id: original.task_id,
    events: [{ at: now, type: "QUEUED", payload: { source: "retry", parent: original.task_id } }],
  };

  const job = await insertJob(doc);
  log.info("Job retried", { original_task_id: taskId, new_task_id: newTaskId });

  if (slackPoster && job.slack?.channel_id && job.slack?.thread_ts) {
    await slackPoster.postQueued(job);
  }

  return job;
}

// --- Submit Plan (worker finished planning, awaiting user confirmation) ---
export async function submitPlan(
  taskId: string,
  nodeId: string,
  planSummary: string,
  metrics?: JobMetrics,
) {
  const job = await repoSubmitPlanJob(taskId, nodeId, { summary: planSummary }, metrics);
  if (job) {
    await appendEvent(taskId, {
      at: nowDate(),
      node_id: nodeId,
      type: "PLAN_GENERATED",
      payload: { summary: planSummary.slice(0, 500) },
    });
    if (slackPoster && job.slack?.channel_id && job.slack?.thread_ts) {
      await slackPoster.postPlan(job);
    }
    notifyConversations(job, "PENDING_CONFIRMATION").catch(() => {});
    log.info("Plan submitted", { task_id: taskId });
  }
  return job;
}

// --- Confirm Plan (user approved, move to execution queue) ---
export async function confirmJob(taskId: string, revisedTaskText?: string) {
  const job = await repoConfirmJobPlan(taskId, revisedTaskText);
  if (job) {
    await appendEvent(taskId, {
      at: nowDate(),
      type: "PLAN_CONFIRMED",
      payload: revisedTaskText ? { revised_task_text: revisedTaskText.slice(0, 200) } : undefined,
    });
    if (slackPoster && job.slack?.channel_id && job.slack?.thread_ts) {
      await slackPoster.postQueued(job);
    }
    notifyConversations(job, "PLAN_CONFIRMED").catch(() => {});
    log.info("Plan confirmed, job re-queued", { task_id: taskId });
  }
  return job;
}

// --- Query ---
export { queryJobs, getDistinctRequestedBy, findJobByTaskId };
