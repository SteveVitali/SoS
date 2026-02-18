export interface CICheckResult {
  status: "pending" | "in_progress" | "completed";
  conclusion?: "success" | "failure" | "cancelled" | "timed_out" | "neutral";
  url?: string;
  summary?: string;
}

export interface CIProvider {
  name: string;
  pollChecks(worktreePath: string, branch: string): Promise<CICheckResult>;
  getFailureSummary(worktreePath: string, branch: string): Promise<string>;
}
