/**
 * Octokit client factory with throttling plugin.
 * Centralizes GitHub REST API access for the sync engine.
 */

import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import { createLogger } from "../../shared/logger.js";
import { RateLimitBudget } from "./rateLimitBudget.js";

const log = createLogger("github:octokit");

// biome-ignore lint/suspicious/noExplicitAny: Octokit plugin composition produces complex inferred type
const ThrottledOctokit: any = Octokit.plugin(throttling);

let client: InstanceType<typeof ThrottledOctokit> | null = null;
let budget: RateLimitBudget | null = null;

/** Get or create the shared Octokit instance. */
export function getOctokit(token: string): InstanceType<typeof ThrottledOctokit> {
  if (client) return client;

  client = new ThrottledOctokit({
    auth: token,
    throttle: {
      onRateLimit: (retryAfter: number, options: any, _octokit: any, retryCount: number) => {
        log.warn("Rate limit hit", {
          retryAfter,
          endpoint: options?.url,
          retryCount,
        });
        // Retry twice
        return retryCount < 2;
      },
      onSecondaryRateLimit: (
        retryAfter: number,
        options: any,
        _octokit: any,
        retryCount: number,
      ) => {
        log.warn("Secondary rate limit hit", {
          retryAfter,
          endpoint: options?.url,
        });
        return retryCount < 1;
      },
    },
  });

  return client;
}

/** Get or create the shared RateLimitBudget instance. */
export function getRateLimitBudget(): RateLimitBudget {
  if (!budget) {
    budget = new RateLimitBudget();
  }
  return budget;
}

/** Reset client (for testing or token change). */
export function resetOctokitClient(): void {
  client = null;
}

/**
 * Helper to extract rate limit headers from an Octokit response
 * and update the budget.
 */
export function updateBudgetFromResponse(
  response: { headers: Record<string, string | undefined> },
  rateBudget: RateLimitBudget,
): void {
  const headers = {
    "x-ratelimit-remaining": response.headers["x-ratelimit-remaining"],
    "x-ratelimit-limit": response.headers["x-ratelimit-limit"],
    "x-ratelimit-reset": response.headers["x-ratelimit-reset"],
    "x-ratelimit-resource": response.headers["x-ratelimit-resource"],
  };
  rateBudget.updateFromHeaders(headers as any);
}
