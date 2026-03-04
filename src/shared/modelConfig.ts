/**
 * Centralized model configuration registry.
 *
 * This is the **single source of truth** for which LLM model is used for each
 * function in the application. Every role can be overridden via its dedicated
 * environment variable, making it easy to tweak models without code changes.
 *
 * ┌──────────────────────┬──────────────────────────────┬──────────────────────────────────┐
 * │ Role                 │ Default model                │ Env override                     │
 * ├──────────────────────┼──────────────────────────────┼──────────────────────────────────┤
 * │ routing              │ claude-sonnet-4-20250514     │ SOS_LLM_MODEL                    │
 * │ titleGeneration      │ (inherits routing)           │ SOS_TITLE_MODEL                  │
 * │ research             │ bedrock/amazon.nova-pro-v1:0 │ SOS_RESEARCH_LLM_MODEL           │
 * │ raptorSummarization  │ (inherits research)          │ SOS_RAPTOR_MODEL                 │
 * │ embedding            │ text-embedding-3-small       │ SOS_EMBEDDING_MODEL              │
 * └──────────────────────┴──────────────────────────────┴──────────────────────────────────┘
 */

// ─── Types ──────────────────────────────────────────────────────

export interface ModelRole {
  /** The resolved model identifier (e.g. "claude-sonnet-4-20250514") */
  model: string;
  /** Human-readable description of what this role does */
  description: string;
  /** The primary environment variable that overrides this role's model */
  envVar: string;
}

export type ModelRoleName =
  | "routing"
  | "titleGeneration"
  | "research"
  | "raptorSummarization"
  | "embedding";

// ─── Defaults ───────────────────────────────────────────────────

const DEFAULT_ROUTING_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_RESEARCH_MODEL = "bedrock/amazon.nova-pro-v1:0";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

// ─── Registry ───────────────────────────────────────────────────

/**
 * Build the full model registry, resolving env overrides and inheritance.
 * Call this at startup or whenever you need to inspect the active configuration.
 */
export function getModelRegistry(): Record<ModelRoleName, ModelRole> {
  const routing = process.env.SOS_LLM_MODEL || DEFAULT_ROUTING_MODEL;
  const research = process.env.SOS_RESEARCH_LLM_MODEL || DEFAULT_RESEARCH_MODEL;

  return {
    routing: {
      model: routing,
      description: "Slack message routing, intent classification, and tool-calling",
      envVar: "SOS_LLM_MODEL",
    },
    titleGeneration: {
      model: process.env.SOS_TITLE_MODEL || routing,
      description: "Job and chat conversation title generation",
      envVar: "SOS_TITLE_MODEL",
    },
    research: {
      model: research,
      description: "Research pipeline reasoning calls (query analysis, evaluation, synthesis)",
      envVar: "SOS_RESEARCH_LLM_MODEL",
    },
    raptorSummarization: {
      model: process.env.SOS_RAPTOR_MODEL || research,
      description: "RAPTOR tree cluster summarization",
      envVar: "SOS_RAPTOR_MODEL",
    },
    embedding: {
      model: process.env.SOS_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL,
      description: "Vector embeddings for knowledge base indexing and search",
      envVar: "SOS_EMBEDDING_MODEL",
    },
  };
}

/**
 * Get the model identifier for a specific role.
 */
export function getModelForRole(role: ModelRoleName): string {
  return getModelRegistry()[role].model;
}
