import { createLogger } from "../../../shared/logger.js";
import type { CIProvider, CICheckResult } from "./ciProvider.js";

const log = createLogger("worker:ci:jenkins");

// Stub implementation for Jenkins CI provider
// To be implemented in a future version
export class JenkinsProvider implements CIProvider {
  name = "jenkins";

  async pollChecks(_worktreePath: string, _branch: string): Promise<CICheckResult> {
    log.warn("Jenkins CI provider is not yet implemented");
    return { status: "completed", conclusion: "neutral" };
  }

  async getFailureSummary(_worktreePath: string, _branch: string): Promise<string> {
    return "Jenkins CI provider is not yet implemented.";
  }
}
