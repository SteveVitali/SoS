import { v4 as uuidv4 } from "uuid";
import { createLogger } from "../../shared/logger.js";
import type { JobDoc } from "../../shared/types.js";
import type { ConversationMessage } from "./conversationRepo.js";
import { appendMessage, findConversationsByTaskId } from "./conversationRepo.js";

const log = createLogger("server:chat:notifier");

/** Format a job status change as a human-readable system message. */
function formatStatusMessage(job: JobDoc, eventType: string): string {
  const tid = job.task_id.slice(0, 8);
  switch (eventType) {
    case "CLAIMED":
      return `Job \`${tid}…\` picked up by worker \`${job.claimed_by}\``;
    case "DONE": {
      const prs = job.pr_urls?.length ? `\nPRs: ${job.pr_urls.join(", ")}` : "";
      const summaryLimit = job.job_type === "github_summary" ? 5000 : 300;
      const summary = job.result_summary ? `\n${job.result_summary.slice(0, summaryLimit)}` : "";
      return `Job \`${tid}…\` completed successfully${prs}${summary}`;
    }
    case "FAILED": {
      const err = job.error?.message ? `\n${job.error.message.slice(0, 200)}` : "";
      return `Job \`${tid}…\` failed${err}`;
    }
    case "CANCELED":
      return `Job \`${tid}…\` was canceled`;
    case "PR_CREATED":
      return `PR created for job \`${tid}…\`: ${job.pr_urls?.slice(-1)[0] || ""}`;
    case "WAITING_FOR_APPROVAL": {
      const prs = job.pr_urls?.length ? `\nDraft PR: ${job.pr_urls.join(", ")}` : "";
      return `Job \`${tid}…\` awaiting approval${prs}`;
    }
    case "PENDING_CONFIRMATION": {
      const planPreview = job.plan?.summary
        ? ` ${job.plan.summary.replace(/\n/g, " ").slice(0, 200)}…`
        : "";
      return `📝 Plan ready for job \`${tid}…\`${planPreview}\n\n_Reply "go" to confirm, or ask questions._`;
    }
    case "PLAN_CONFIRMED":
      return `✅ Plan confirmed for job \`${tid}…\` — executing`;
    case "PR_PROMOTED":
      return `PR promoted to ready-for-review for job \`${tid}…\``;
    default:
      return `Job \`${tid}…\` — ${eventType}`;
  }
}

/**
 * Notify any conversations linked to this job about a status change.
 * Fire-and-forget — errors are logged but never thrown.
 */
export async function notifyConversations(job: JobDoc, eventType: string): Promise<void> {
  try {
    const conversations = await findConversationsByTaskId(job.task_id);
    if (conversations.length === 0) return;

    const text = formatStatusMessage(job, eventType);
    const message: ConversationMessage = {
      id: uuidv4(),
      role: "system",
      text,
      at: new Date(),
      action: { command: eventType.toLowerCase(), task_id: job.task_id },
    };

    await Promise.all(conversations.map((c) => appendMessage(c.conversation_id, message)));
    log.info("Notified conversations", {
      task_id: job.task_id,
      event: eventType,
      count: conversations.length,
    });
  } catch (err: any) {
    log.warn("Failed to notify conversations", {
      task_id: job.task_id,
      event: eventType,
      error: err.message,
    });
  }
}
