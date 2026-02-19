import { createLogger } from "../shared/logger.js";
import type { CIInfo, JobDoc, JobError, WorkerEventType } from "../shared/types.js";

const log = createLogger("worker:apiClient");

export class WorkerApiClient {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private async request<T>(method: string, path: string, body?: any): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(`API ${method} ${path} => ${res.status}: ${text}`);
      (err as any).status = res.status;
      throw err;
    }

    return res.json() as Promise<T>;
  }

  async poll(requestedBy: string, limit = 10): Promise<JobDoc[]> {
    const data = await this.request<{ jobs: JobDoc[] }>(
      "GET",
      `/api/worker/jobs/poll?requested_by=${encodeURIComponent(requestedBy)}&limit=${limit}`,
    );
    return data.jobs;
  }

  async claim(
    taskId: string,
    requestedBy: string,
    nodeId: string,
    leaseSeconds: number,
  ): Promise<JobDoc | null> {
    try {
      const data = await this.request<{ job: JobDoc }>("POST", `/api/worker/jobs/${taskId}/claim`, {
        requested_by: requestedBy,
        node_id: nodeId,
        lease_seconds: leaseSeconds,
      });
      return data.job;
    } catch (err: any) {
      if (err.status === 409) return null;
      throw err;
    }
  }

  async heartbeat(taskId: string, nodeId: string, extendSeconds: number): Promise<boolean> {
    try {
      await this.request("POST", `/api/worker/jobs/${taskId}/heartbeat`, {
        node_id: nodeId,
        extend_seconds: extendSeconds,
      });
      return true;
    } catch (err: any) {
      if (err.status === 409) return false;
      log.warn("Heartbeat request failed", { task_id: taskId, error: err.message });
      return false;
    }
  }

  async sendEvent(
    taskId: string,
    nodeId: string,
    type: WorkerEventType,
    payload?: any,
  ): Promise<void> {
    await this.request("POST", `/api/worker/jobs/${taskId}/events`, {
      node_id: nodeId,
      type,
      payload,
    });
  }

  async complete(
    taskId: string,
    nodeId: string,
    data: { result_summary: string; pr_urls?: string[]; ci?: CIInfo },
  ): Promise<JobDoc | null> {
    try {
      const res = await this.request<{ job: JobDoc }>(
        "POST",
        `/api/worker/jobs/${taskId}/complete`,
        { node_id: nodeId, ...data },
      );
      return res.job;
    } catch (err: any) {
      if (err.status === 409) return null;
      throw err;
    }
  }

  async fail(
    taskId: string,
    nodeId: string,
    data: { error: JobError; pr_urls?: string[]; ci?: CIInfo },
  ): Promise<JobDoc | null> {
    try {
      const res = await this.request<{ job: JobDoc }>("POST", `/api/worker/jobs/${taskId}/fail`, {
        node_id: nodeId,
        ...data,
      });
      return res.job;
    } catch (err: any) {
      if (err.status === 409) return null;
      throw err;
    }
  }

  async requeue(taskId: string, nodeId: string, reason: string): Promise<JobDoc | null> {
    try {
      const res = await this.request<{ job: JobDoc }>(
        "POST",
        `/api/worker/jobs/${taskId}/requeue`,
        { node_id: nodeId, reason },
      );
      return res.job;
    } catch (err: any) {
      if (err.status === 409) return null;
      throw err;
    }
  }

  async getJobStatus(taskId: string): Promise<string | null> {
    try {
      const data = await this.request<{ status: string }>(
        "GET",
        `/api/worker/jobs/${taskId}/status`,
      );
      return data.status;
    } catch {
      return null;
    }
  }

  async fetchSlackThread(channelId: string, threadTs: string): Promise<any[]> {
    try {
      const data = await this.request<{ messages: any[] }>(
        "GET",
        `/api/worker/slack/thread?channel_id=${encodeURIComponent(channelId)}&thread_ts=${encodeURIComponent(threadTs)}`,
      );
      return data.messages;
    } catch (err: any) {
      log.warn("Failed to fetch Slack thread", { error: err.message });
      return [];
    }
  }
}
