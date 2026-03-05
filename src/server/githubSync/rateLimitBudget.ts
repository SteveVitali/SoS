/**
 * Dual rate limit budget manager for GitHub REST API.
 *
 * Tracks two independent limits:
 * 1. Core REST API: 5,000 requests/hour
 * 2. Search API: 30 requests/minute (token bucket)
 *
 * Reserves 20% of core budget for interactive/on-demand requests.
 */

import { createLogger } from "../../shared/logger.js";

const log = createLogger("github:rateLimitBudget");

const INTERACTIVE_RESERVE_FRACTION = 0.2;

export class RateLimitBudget {
  // --- Core REST API (5,000/hour) ---
  private restRemaining = 5000;
  private restLimit = 5000;
  private restResetsAt: Date = new Date(Date.now() + 3600_000);

  // --- Search API (30/minute, token bucket) ---
  private searchTokens = 30;
  private searchLimit = 30;
  private searchLastRefill = Date.now();
  private static readonly SEARCH_REFILL_INTERVAL_MS = 2000; // 1 token per 2s = 30/min

  /** Update from X-RateLimit-* response headers after every REST call. */
  updateFromHeaders(headers: {
    "x-ratelimit-remaining"?: string;
    "x-ratelimit-limit"?: string;
    "x-ratelimit-reset"?: string;
    "x-ratelimit-resource"?: string;
  }): void {
    const remaining = headers["x-ratelimit-remaining"];
    const limit = headers["x-ratelimit-limit"];
    const reset = headers["x-ratelimit-reset"];
    const resource = headers["x-ratelimit-resource"];

    if (resource === "search") {
      // Search rate limit is handled by token bucket; just log
      if (remaining !== undefined) {
        log.debug("Search rate limit header", { remaining, reset });
      }
      return;
    }

    if (remaining !== undefined) {
      this.restRemaining = parseInt(remaining, 10);
    }
    if (limit !== undefined) {
      this.restLimit = parseInt(limit, 10);
    }
    if (reset !== undefined) {
      this.restResetsAt = new Date(parseInt(reset, 10) * 1000);
    }
  }

  /** How many core REST requests are reserved for interactive use. */
  get interactiveReserve(): number {
    return Math.floor(this.restLimit * INTERACTIVE_RESERVE_FRACTION);
  }

  /** How many core REST requests are available for background sync. */
  get backgroundBudget(): number {
    return Math.max(0, this.restRemaining - this.interactiveReserve);
  }

  /** Can we afford `cost` background REST requests right now? */
  canSpendRest(cost: number): boolean {
    return this.backgroundBudget >= cost;
  }

  /** Can we afford `cost` interactive REST requests right now? */
  canSpendInteractive(cost: number): boolean {
    return this.restRemaining >= cost;
  }

  /** How many ms until the core REST limit resets. */
  get msUntilRestReset(): number {
    return Math.max(0, this.restResetsAt.getTime() - Date.now());
  }

  // --- Search API Token Bucket ---

  private refillSearchTokens(): void {
    const elapsed = Date.now() - this.searchLastRefill;
    const newTokens = Math.floor(elapsed / RateLimitBudget.SEARCH_REFILL_INTERVAL_MS);
    if (newTokens > 0) {
      this.searchTokens = Math.min(this.searchLimit, this.searchTokens + newTokens);
      this.searchLastRefill += newTokens * RateLimitBudget.SEARCH_REFILL_INTERVAL_MS;
    }
  }

  /** Check if a search API token is available (non-blocking). */
  canSearch(): boolean {
    this.refillSearchTokens();
    return this.searchTokens >= 1;
  }

  /** Acquire a search API token. Blocks (async) until one is available. */
  async acquireSearch(): Promise<void> {
    this.refillSearchTokens();
    while (this.searchTokens < 1) {
      await sleep(RateLimitBudget.SEARCH_REFILL_INTERVAL_MS);
      this.refillSearchTokens();
    }
    this.searchTokens--;
  }

  /** Consume a core REST request from the budget. */
  consumeRest(count = 1): void {
    this.restRemaining = Math.max(0, this.restRemaining - count);
  }

  /** Get a snapshot for UI display. */
  getStatus(): {
    rest: { remaining: number; limit: number; resets_at: string };
    search: { tokens_available: number; limit: number };
    backfill_budget_available: number;
  } {
    this.refillSearchTokens();
    return {
      rest: {
        remaining: this.restRemaining,
        limit: this.restLimit,
        resets_at: this.restResetsAt.toISOString(),
      },
      search: {
        tokens_available: Math.floor(this.searchTokens),
        limit: this.searchLimit,
      },
      backfill_budget_available: this.backgroundBudget,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
