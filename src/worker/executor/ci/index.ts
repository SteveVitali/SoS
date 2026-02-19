import { createLogger } from "../../../shared/logger.js";
import type { CIProvider } from "./ciProvider.js";
import { GitHubActionsProvider } from "./githubActions.js";
import { JenkinsProvider } from "./jenkins.js";

const log = createLogger("worker:ci");

/**
 * Create the appropriate CI provider based on the repo config.
 * Returns null if no CI provider is configured — caller should skip CI monitoring.
 */
export function createCIProvider(providerName?: string): CIProvider | null {
  switch (providerName) {
    case "github_actions":
      return new GitHubActionsProvider();
    case "jenkins":
      return new JenkinsProvider();
    case undefined:
    case "":
    case "none":
      log.info("No CI provider configured, CI monitoring will be skipped");
      return null;
    default:
      log.warn("Unknown CI provider, CI monitoring will be skipped", { provider: providerName });
      return null;
  }
}
