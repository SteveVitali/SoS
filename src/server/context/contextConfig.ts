/**
 * Configuration for the unified context assembly layer.
 * Loads settings from environment variables with sensible defaults.
 */

import { createLogger } from "../../shared/logger.js";

const log = createLogger("server:context:config");

export interface ContextConfig {
  /** Enable the LLM reranker for cross-source ranking. Default: true. */
  rerankerEnabled: boolean;
  /** Allow automatic escalation to deep research when context is insufficient. Default: true. */
  deepEscalationEnabled: boolean;
  /** Shared token budget for the final context string. Default: 3500. */
  maxTokens: number;
  /** Maximum number of candidates to feed to the reranker from each source. Default: 5. */
  maxCandidatesPerSource: number;
  /** Maximum character length per candidate content in the reranker prompt (truncation). Default: 800. */
  maxContentCharsForReranker: number;
}

export function loadContextConfig(): ContextConfig {
  const config: ContextConfig = {
    rerankerEnabled: (process.env.SOS_CONTEXT_RERANKER_ENABLED ?? "true") === "true",
    deepEscalationEnabled: (process.env.SOS_CONTEXT_DEEP_ENABLED ?? "true") === "true",
    maxTokens: parseInt(process.env.SOS_CONTEXT_MAX_TOKENS || "3500", 10),
    maxCandidatesPerSource: parseInt(process.env.SOS_CONTEXT_MAX_CANDIDATES_PER_SOURCE || "5", 10),
    maxContentCharsForReranker: parseInt(
      process.env.SOS_CONTEXT_MAX_CONTENT_CHARS_RERANKER || "800",
      10,
    ),
  };

  log.debug("Context config loaded", {
    rerankerEnabled: config.rerankerEnabled,
    deepEscalationEnabled: config.deepEscalationEnabled,
    maxTokens: config.maxTokens,
  });

  return config;
}
