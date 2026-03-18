import { createLogger } from "../shared/logger.js";
import type { CIInfo, JobDoc, JobError, JobMetrics, WorkerEventType } from "../shared/types.js";

const log = createLogger("worker:apiClient");

interface ResearchChunk {
  content: string;
  source_file: string;
  kb_name: string;
  kb_id: string;
  score: number;
  metadata: { section?: string; page?: number };
}

interface ResearchMetrics {
  total_duration_ms: number;
  iterations: number;
  llm_calls: number;
  retrieval_calls: number;
  chunks_retrieved: number;
  chunks_used: number;
  prompt_tokens: number;
  completion_tokens: number;
  estimated_cost_usd: number;
}

interface ResearchResponse {
  context: string;
  chunks: ResearchChunk[];
  metrics: ResearchMetrics;
  session_id: string;
}

function emptyResearchResponse(): ResearchResponse {
  return {
    context: "",
    chunks: [],
    metrics: {
      total_duration_ms: 0,
      iterations: 0,
      llm_calls: 0,
      retrieval_calls: 0,
      chunks_retrieved: 0,
      chunks_used: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      estimated_cost_usd: 0,
    },
    session_id: "",
  };
}

export class WorkerApiClient {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private async requestWithRetry<T>(
    method: string,
    path: string,
    // biome-ignore lint/suspicious/noExplicitAny: dynamic API type
    body?: any,
    retries = 3,
    baseDelayMs = 1000,
  ): Promise<T> {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic API type
    let lastErr: any;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.request<T>(method, path, body);
      } catch (err: unknown) {
        lastErr = err;
        // Don't retry client errors (4xx) — they won't succeed on retry
        const errStatus = (err as { status?: number }).status;
        if (errStatus && errStatus >= 400 && errStatus < 500) throw err;
        if (attempt < retries) {
          const delay = baseDelayMs * 2 ** attempt;
          log.warn("Transient API error, retrying", {
            method,
            path,
            attempt: attempt + 1,
            maxRetries: retries,
            delayMs: delay,
            error: (err as Error).message,
          });
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastErr;
  }

  // biome-ignore lint/suspicious/noExplicitAny: dynamic API type
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
      // biome-ignore lint/suspicious/noExplicitAny: dynamic API type
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
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 409) return null;
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
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 409) return false; // Lease genuinely lost
      throw err; // Network/transient error — let caller decide
    }
  }

  async sendEvent(
    taskId: string,
    nodeId: string,
    type: WorkerEventType,
    // biome-ignore lint/suspicious/noExplicitAny: dynamic API type
    payload?: any,
  ): Promise<void> {
    await this.requestWithRetry("POST", `/api/worker/jobs/${taskId}/events`, {
      node_id: nodeId,
      type,
      payload,
    });
  }

  async complete(
    taskId: string,
    nodeId: string,
    data: { result_summary: string; pr_urls?: string[]; ci?: CIInfo; metrics?: JobMetrics },
  ): Promise<JobDoc | null> {
    try {
      const res = await this.requestWithRetry<{ job: JobDoc }>(
        "POST",
        `/api/worker/jobs/${taskId}/complete`,
        { node_id: nodeId, ...data },
        5, // more retries for completion — this is critical
        2000,
      );
      return res.job;
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 409) return null;
      throw err;
    }
  }

  async fail(
    taskId: string,
    nodeId: string,
    data: { error: JobError; pr_urls?: string[]; ci?: CIInfo; metrics?: JobMetrics },
  ): Promise<JobDoc | null> {
    try {
      const res = await this.requestWithRetry<{ job: JobDoc }>(
        "POST",
        `/api/worker/jobs/${taskId}/fail`,
        { node_id: nodeId, ...data },
        5,
        2000,
      );
      return res.job;
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 409) return null;
      throw err;
    }
  }

  async requeue(taskId: string, nodeId: string, reason: string): Promise<JobDoc | null> {
    try {
      const res = await this.requestWithRetry<{ job: JobDoc }>(
        "POST",
        `/api/worker/jobs/${taskId}/requeue`,
        { node_id: nodeId, reason },
      );
      return res.job;
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 409) return null;
      throw err;
    }
  }

  async awaitApproval(
    taskId: string,
    nodeId: string,
    data: { result_summary: string; pr_urls?: string[]; ci?: CIInfo; metrics?: JobMetrics },
  ): Promise<JobDoc | null> {
    try {
      const res = await this.requestWithRetry<{ job: JobDoc }>(
        "POST",
        `/api/worker/jobs/${taskId}/await-approval`,
        { node_id: nodeId, ...data },
      );
      return res.job;
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 409) return null;
      throw err;
    }
  }

  async submitPlan(
    taskId: string,
    nodeId: string,
    data: { plan_summary: string; metrics?: JobMetrics },
  ): Promise<JobDoc | null> {
    try {
      const res = await this.requestWithRetry<{ job: JobDoc }>(
        "POST",
        `/api/worker/jobs/${taskId}/submit-plan`,
        { node_id: nodeId, ...data },
        5,
        2000,
      );
      return res.job;
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 409) return null;
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

  // --- Worker Registry ---

  async registerWorker(data: {
    worker_id: string;
    hostname: string;
    pid: number;
    version?: string;
  }): Promise<void> {
    await this.request("POST", "/api/worker/register", data);
  }

  async deregisterWorker(workerId: string): Promise<void> {
    await this.request("POST", "/api/worker/deregister", { worker_id: workerId });
  }

  async reportStatus(
    workerId: string,
    loops: Array<{
      index: number;
      status: string;
      task_id?: string;
      worktree_slot?: string;
      busy_since?: string;
    }>,
  ): Promise<void> {
    await this.request("POST", "/api/worker/status", { worker_id: workerId, loops });
  }

  // --- Knowledge Base ---

  async searchKnowledgeBases(
    query: string,
    scopes: string[],
    maxChunks?: number,
  ): Promise<
    Array<{
      content: string;
      source_file: string;
      kb_name: string;
      score: number;
      metadata: { section?: string; page?: number };
    }>
  > {
    try {
      const data = await this.request<{
        results: Array<{
          content: string;
          source_file: string;
          kb_name: string;
          score: number;
          metadata: { section?: string; page?: number };
        }>;
      }>("POST", "/api/worker/kb/search", { query, scopes, max_chunks: maxChunks });
      return data.results;
    } catch (err: unknown) {
      log.warn("KB search failed (non-fatal)", { error: (err as Error).message });
      return [];
    }
  }

  async researchKnowledgeBases(params: {
    query: string;
    scopes: string[];
    strategy?: string;
    consumer?: { type: string; id?: string };
  }): Promise<ResearchResponse> {
    try {
      return await this.request("POST", "/api/worker/kb/research", {
        query: params.query,
        scopes: params.scopes,
        strategy: params.strategy || "deep",
        consumer: params.consumer,
      });
    } catch (err: unknown) {
      log.warn("KB research failed (non-fatal)", { error: (err as Error).message });
      return emptyResearchResponse();
    }
  }

  async researchKnowledgeBasesStreaming(
    params: {
      query: string;
      scopes: string[];
      strategy?: string;
      consumer?: { type: string; id?: string };
    },
    onEvent: (event: Record<string, unknown>) => void,
  ): Promise<ResearchResponse> {
    const url = `${this.baseUrl}/api/worker/kb/research`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
        Accept: "text/x-ndjson",
      },
      body: JSON.stringify({
        query: params.query,
        scopes: params.scopes,
        strategy: params.strategy || "deep",
        consumer: params.consumer,
      }),
    });

    if (!res.ok) {
      throw new Error(`Research streaming failed: ${res.status} ${res.statusText}`);
    }

    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.trim());

    // biome-ignore lint/suspicious/noExplicitAny: dynamic NDJSON events
    let finalResult: any = null;

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === "result") {
          finalResult = event;
        } else {
          onEvent(event);
        }
      } catch {
        log.warn("Failed to parse NDJSON line", { line: line.slice(0, 100) });
      }
    }

    if (finalResult) {
      return {
        context: finalResult.context || "",
        chunks: finalResult.chunks || [],
        metrics: finalResult.metrics || emptyResearchResponse().metrics,
        session_id: finalResult.session_id || "",
      };
    }

    return emptyResearchResponse();
  }

  // --- Unified Context ---

  async getUnifiedContext(params: {
    query: string;
    owner: string;
    scopes: string[];
    allowDeep?: boolean;
    maxTokens?: number;
  }): Promise<{
    context: string;
    profile: string;
    metadata: {
      kb_items_used: number;
      memory_items_used: number;
      reranker_called: boolean;
      deep_escalation: boolean;
      total_duration_ms: number;
    };
  }> {
    try {
      return await this.request("POST", "/api/worker/context", {
        query: params.query,
        owner: params.owner,
        scopes: params.scopes,
        allowDeep: params.allowDeep ?? false,
        maxTokens: params.maxTokens,
      });
    } catch (err: unknown) {
      log.warn("Unified context fetch failed (non-fatal)", { error: (err as Error).message });
      return {
        context: "",
        profile: "",
        metadata: {
          kb_items_used: 0,
          memory_items_used: 0,
          reranker_called: false,
          deep_escalation: false,
          total_duration_ms: 0,
        },
      };
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: Slack API type
  async fetchSlackThread(channelId: string, threadTs: string): Promise<any[]> {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic API type
      const data = await this.request<{ messages: any[] }>(
        "GET",
        `/api/worker/slack/thread?channel_id=${encodeURIComponent(channelId)}&thread_ts=${encodeURIComponent(threadTs)}`,
      );
      return data.messages;
    } catch (err: unknown) {
      log.warn("Failed to fetch Slack thread", { error: (err as Error).message });
      return [];
    }
  }
}
