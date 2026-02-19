import type { JobDoc } from "../../shared/types.js";

export function fmtQueued(job: JobDoc): string {
  const userId = job.slack_requester || job.requested_by;
  const user = userId ? `<@${userId}>` : "unknown";
  return `Queued ✅ \`task_id=${job.task_id}\` (workers: local, user: ${user})${
    job.parent_task_id ? `\n_Retry of \`${job.parent_task_id}\`_` : ""
  }`;
}

export function fmtClaimed(job: JobDoc): string {
  return `Claimed 🔧 \`task_id=${job.task_id}\` by \`${job.claimed_by}\` (attempt ${job.attempt || 1})`;
}

export function fmtPrCreated(job: JobDoc, url: string): string {
  return `PR Created 🔗 \`task_id=${job.task_id}\`\n${url}`;
}

export function fmtCiFailed(job: JobDoc, payload: any): string {
  const attempt = payload?.attempt ?? "?";
  const summary = payload?.summary ? `\n\`\`\`${truncate(payload.summary, 500)}\`\`\`` : "";
  return `CI Failed ❌ \`task_id=${job.task_id}\` (attempt ${attempt})${summary}`;
}

export function fmtCiGreen(job: JobDoc, payload: any): string {
  const url = payload?.url ? `\n${payload.url}` : "";
  return `CI Green ✅ \`task_id=${job.task_id}\`${url}`;
}

export function fmtDone(job: JobDoc): string {
  const prs = job.pr_urls?.length ? `\nPRs: ${job.pr_urls.join(", ")}` : "";
  const summary = job.result_summary ? `\n${truncate(job.result_summary, 500)}` : "";
  return `Done ✅ \`task_id=${job.task_id}\`${prs}${summary}`;
}

export function fmtFailed(job: JobDoc): string {
  const errMsg = job.error?.message ? `\n\`\`\`${truncate(job.error.message, 500)}\`\`\`` : "";
  const prs = job.pr_urls?.length ? `\nPRs: ${job.pr_urls.join(", ")}` : "";
  return `Failed ❌ \`task_id=${job.task_id}\`${errMsg}${prs}`;
}

export function fmtAwaitingApproval(job: JobDoc, payload: any): string {
  const msg = payload?.message;
  if (msg) return msg;
  const prs = job.pr_urls?.length ? `\nDraft PR: ${job.pr_urls.join(", ")}` : "";
  return `Awaiting approval ⏳ \`task_id=${job.task_id}\`${prs}\nReply here to promote, or use the web dashboard.`;
}

export function fmtPrPromoted(job: JobDoc, payload: any): string {
  const msg = payload?.message;
  if (msg) return msg;
  const prs = job.pr_urls?.length ? `\n${job.pr_urls.join(", ")}` : "";
  return `PR promoted to ready-for-review ✅ \`task_id=${job.task_id}\`${prs}`;
}

export function fmtPlan(job: JobDoc): string {
  const plan = job.plan?.summary ? `\n${truncate(job.plan.summary, 2000)}` : "";
  return `📝 *Plan for \`${job.task_id.slice(0, 8)}…\`*${plan}\n\n_Reply "go" to confirm, or ask questions._`;
}

export function fmtCanceled(job: JobDoc): string {
  return `Canceled ⛔ \`task_id=${job.task_id}\``;
}

export function fmtEvent(job: JobDoc, type: string, payload: any): string {
  switch (type) {
    case "PR_CREATED":
      return fmtPrCreated(job, payload?.url || "");
    case "CI_FAILED":
      return fmtCiFailed(job, payload);
    case "CI_STATUS":
      if (payload?.conclusion === "success") return fmtCiGreen(job, payload);
      return `CI Status \`task_id=${job.task_id}\`: ${payload?.status || "unknown"}${
        payload?.conclusion ? ` (${payload.conclusion})` : ""
      }`;
    case "DONE":
      return fmtDone(job);
    case "FAILED":
      return fmtFailed(job);
    case "PLAN_GENERATED":
      return fmtPlan(job);
    case "WAITING_FOR_APPROVAL":
      return fmtAwaitingApproval(job, payload);
    case "PR_PROMOTED":
      return fmtPrPromoted(job, payload);
    case "CANCELED":
      return fmtCanceled(job);
    default:
      return `Event \`${type}\` for \`task_id=${job.task_id}\``;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
