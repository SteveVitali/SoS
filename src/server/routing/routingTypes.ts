/**
 * TypeScript types for the YAML-driven routing configuration.
 *
 * The routing config is the single source of truth for:
 * - Steve's system prompt / personality
 * - Available actions (tools the LLM can choose)
 * - Execution definitions (what happens when an action is triggered)
 * - Custom actions defined by the user
 */

// --- Parameter Definition ---

export interface ParamDef {
  type: "string" | "number" | "boolean" | "array";
  description?: string;
  required?: boolean;
  enum?: string[];
  items?: { type: string };
}

// --- Execution Definitions ---

/** Just return the LLM's reply text (or nothing for silent). */
export interface ReplyExecution {
  type: "reply";
  silent?: boolean;
}

/** Create a new coding job (or plan job). */
export interface CreateJobExecution {
  type: "create_job";
  needs_plan?: boolean;
  arg_map?: Record<string, string>;
  custom_instructions?: string;
  reply_success?: string;
  reply_error?: string;
}

/** Resolve task_id and call a job lifecycle method (cancel, retry, confirm, promote). */
export interface JobActionExecution {
  type: "job_action";
  method: "cancel" | "retry" | "confirm" | "promote";
  require_status?: string;
  require_pr?: boolean;
  extra_args?: string[];
  reply_success?: string;
  reply_not_found?: string;
  reply_wrong_status?: string;
  reply_no_pr?: string;
  reply_failed?: string;
  reply_error?: string;
}

/** Resolve task_id and render job info with a template. */
export interface JobQueryExecution {
  type: "job_query";
  reply_template?: string;
  reply_not_found?: string;
}

/** List recent jobs and render each with a template. */
export interface JobListExecution {
  type: "job_list";
  default_limit?: number;
  item_template?: string;
  reply_empty?: string;
}

/** Create a respond-to-PR-comments job. */
export interface CreateRespondJobExecution {
  type: "create_respond_job";
  reply_success?: string;
  reply_not_found?: string;
  reply_no_pr?: string;
  reply_missing_input?: string;
  reply_error?: string;
}

/** Dispatch to GitHub instant queries or inline recap execution. */
export interface GithubQueryExecution {
  type: "github_query";
  instant_types?: string[];
  summary_types?: string[];
  reply_error?: string;
  reply_unknown_type?: string;
}

/** Run a shell command and return stdout. */
export interface ShellExecution {
  type: "shell";
  command: string;
  timeout_seconds?: number;
  reply_template?: string;
  reply_empty?: string;
  reply_error?: string;
}

/** HTTP request to an external URL. */
export interface WebhookExecution {
  type: "webhook";
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  reply_success?: string;
  reply_error?: string;
}

/** Create an agent task job with YAML-defined instructions. */
export interface AgentTaskExecution {
  type: "agent_task";
  instructions: string;
  repo_hint?: string;
  test_level?: string;
  reviewers?: string[];
  reply_queued?: string;
  reply_error?: string;
}

/** Leave the current Slack channel. */
export interface LeaveChannelExecution {
  type: "leave_channel";
  reply_success?: string;
  reply_error?: string;
  reply_not_slack?: string;
}

/** Dispatch to sub-executions based on a parameter value. */
export interface DispatchExecution {
  type: "dispatch";
  on: string;
  routes: Record<string, ExecutionDef>;
  reply_unknown?: string;
}

/** Run the advanced research pipeline against knowledge bases. */
export interface ResearchExecution {
  type: "research";
  scopes?: string[];
  default_strategy?: "simple" | "deep" | "agent";
  show_trace?: boolean;
  timeout_ms?: number;
  reply_template?: string;
  reply_error?: string;
}

export type ExecutionDef =
  | ReplyExecution
  | CreateJobExecution
  | JobActionExecution
  | JobQueryExecution
  | JobListExecution
  | CreateRespondJobExecution
  | GithubQueryExecution
  | ShellExecution
  | WebhookExecution
  | AgentTaskExecution
  | LeaveChannelExecution
  | DispatchExecution
  | ResearchExecution;

// --- Knowledge Base Config (per-action) ---

export interface ActionKBConfig {
  scopes?: string[];
  max_chunks?: number;
  min_score?: number;
}

// --- Action Definition ---

export interface ActionDef {
  enabled: boolean;
  description: string;
  routing_hint?: string;
  parameters: Record<string, ParamDef>;
  execution: ExecutionDef;
  defaults?: Record<string, unknown>;
  knowledge_bases?: ActionKBConfig;
}

// --- Top-level Routing Config ---

export interface RoutingConfig {
  model?: string;
  system_prompt: string;
  actions: Record<string, ActionDef>;
  custom_actions: Record<string, ActionDef>;
  kb_context_max_tokens?: number;
  kb_research_strategy?: "simple" | "deep" | "agent";
}
