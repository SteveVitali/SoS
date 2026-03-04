/**
 * Centralized model configuration registry.
 *
 * This is the **single source of truth** for which LLM model is used for each
 * function in the application. Models are resolved in this precedence order:
 *
 *   1. model-config.yaml file override  (highest priority)
 *   2. Environment variable override
 *   3. Hardcoded default / inheritance
 *
 * ┌──────────────────────┬──────────────────────────────┬──────────────────────────────────┐
 * │ Role                 │ Default model                │ Env override                     │
 * ├──────────────────────┼──────────────────────────────┼──────────────────────────────────┤
 * │ routing              │ claude-opus-4-0-20250514     │ SOS_LLM_MODEL                    │
 * │ titleGeneration      │ (inherits routing)           │ SOS_TITLE_MODEL                  │
 * │ research             │ claude-opus-4-0-20250514     │ SOS_RESEARCH_LLM_MODEL           │
 * │ raptorSummarization  │ (inherits research)          │ SOS_RAPTOR_MODEL                 │
 * │ embedding            │ text-embedding-3-small       │ SOS_EMBEDDING_MODEL              │
 * └──────────────────────┴──────────────────────────────┴──────────────────────────────────┘
 */

import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createLogger } from "./logger.js";

const log = createLogger("shared:modelConfig");

// ─── Types ──────────────────────────────────────────────────────

export interface ModelRole {
  /** The resolved model identifier (e.g. "claude-sonnet-4-20250514") */
  model: string;
  /** Human-readable description of what this role does */
  description: string;
  /** The primary environment variable that overrides this role's model */
  envVar: string;
  /** The hardcoded default model (or inherited parent role name) */
  default: string;
  /** Value from model-config.yaml, if any */
  fileOverride?: string;
  /** Value from the environment variable, if any */
  envOverride?: string;
  /** Which precedence layer determined the effective model */
  source: "default" | "file" | "env";
}

export type ModelRoleName =
  | "routing"
  | "titleGeneration"
  | "research"
  | "raptorSummarization"
  | "embedding";

// ─── Defaults ───────────────────────────────────────────────────

const DEFAULT_ROUTING_MODEL = "claude-opus-4-0-20250514";
const DEFAULT_RESEARCH_MODEL = "claude-opus-4-0-20250514";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

const VALID_ROLES: ModelRoleName[] = [
  "routing",
  "titleGeneration",
  "research",
  "raptorSummarization",
  "embedding",
];

// ─── File-based override layer ──────────────────────────────────

let cachedOverrides: Partial<Record<ModelRoleName, string>> = {};
let modelConfigPath: string | null = null;
let watcherActive = false;
let suppressNextWatch = false;

/**
 * Generate the default model-config.yaml content (all roles commented out).
 */
export function generateDefaultModelConfig(): string {
  return [
    "# Model Config — override model assignments per role.",
    "# Values here take precedence over env vars and hardcoded defaults.",
    "# Uncomment and change values as needed.",
    "",
    `# routing: ${DEFAULT_ROUTING_MODEL}              # Env: SOS_LLM_MODEL`,
    "# titleGeneration: (inherits routing)         # Env: SOS_TITLE_MODEL",
    `# research: ${DEFAULT_RESEARCH_MODEL}  # Env: SOS_RESEARCH_LLM_MODEL`,
    "# raptorSummarization: (inherits research)    # Env: SOS_RAPTOR_MODEL",
    `# embedding: ${DEFAULT_EMBEDDING_MODEL}       # Env: SOS_EMBEDDING_MODEL`,
    "",
  ].join("\n");
}

/**
 * Parse the YAML file into an overrides map.
 * Only keeps keys that are valid ModelRoleName values with string model values.
 */
function parseOverrides(filePath: string): Partial<Record<ModelRoleName, string>> {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = parseYaml(raw);
    if (!data || typeof data !== "object") return {};

    const result: Partial<Record<ModelRoleName, string>> = {};
    for (const role of VALID_ROLES) {
      if (typeof data[role] === "string" && data[role].trim()) {
        result[role] = data[role].trim();
      }
    }
    return result;
  } catch (err: unknown) {
    log.error("Failed to parse model config file", {
      path: filePath,
      error: (err as Error).message,
    });
    return {};
  }
}

/**
 * Initialize the model config file system. Call once at server startup.
 * If the file doesn't exist, writes a default (all-commented) template.
 */
export function initModelConfig(filePath: string): void {
  modelConfigPath = filePath;

  if (!existsSync(filePath)) {
    log.info("Model config not found, generating default", { path: filePath });
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, generateDefaultModelConfig(), "utf-8");
    log.info("Default model config written", { path: filePath });
  }

  cachedOverrides = parseOverrides(filePath);
  const overrideCount = Object.keys(cachedOverrides).length;
  log.info("Model config loaded", { path: filePath, overrides: overrideCount });

  if (!watcherActive) {
    try {
      watch(filePath, (eventType) => {
        if (eventType === "change") {
          if (suppressNextWatch) {
            suppressNextWatch = false;
            return;
          }
          log.info("Model config file changed, reloading");
          try {
            cachedOverrides = parseOverrides(filePath);
          } catch (err: unknown) {
            log.error("Failed to reload model config, keeping previous", {
              error: (err as Error).message,
            });
          }
        }
      });
      watcherActive = true;
    } catch {
      log.warn("Could not watch model config file for changes");
    }
  }
}

/**
 * Get the file path of the model config (for API routes).
 */
export function getModelConfigPath(): string | null {
  return modelConfigPath;
}

/**
 * Get the raw overrides map from the YAML file.
 */
export function getModelConfigRaw(): Partial<Record<ModelRoleName, string>> {
  if (!modelConfigPath) return {};
  return parseOverrides(modelConfigPath);
}

/**
 * Save model overrides to disk as YAML and reload the cache.
 */
export function saveModelConfig(overrides: Partial<Record<ModelRoleName, string>>): void {
  if (!modelConfigPath) {
    throw new Error("Model config not initialized. Call initModelConfig() first.");
  }
  // Filter out empty/invalid values
  const clean: Record<string, string> = {};
  for (const role of VALID_ROLES) {
    const val = overrides[role];
    if (typeof val === "string" && val.trim()) {
      clean[role] = val.trim();
    }
  }

  const yaml =
    Object.keys(clean).length > 0
      ? stringifyYaml(clean, { lineWidth: 120 })
      : generateDefaultModelConfig();

  suppressNextWatch = true;
  writeFileSync(modelConfigPath, yaml, "utf-8");
  log.info("Model config saved", { path: modelConfigPath, overrides: Object.keys(clean) });
  cachedOverrides = parseOverrides(modelConfigPath);
}

/**
 * Force-reload model config from disk.
 */
export function reloadModelConfig(): void {
  if (!modelConfigPath) {
    throw new Error("Model config not initialized.");
  }
  cachedOverrides = parseOverrides(modelConfigPath);
  log.info("Model config reloaded", { overrides: Object.keys(cachedOverrides) });
}

// ─── Registry ───────────────────────────────────────────────────

/**
 * Resolve a single role's model through the three-layer precedence:
 *   env var > file override > default value.
 */
function resolveRole(
  envVar: string,
  roleName: ModelRoleName,
  defaultModel: string,
  description: string,
  defaultLabel: string,
): ModelRole {
  const envVal = process.env[envVar] || undefined;
  const fileVal = cachedOverrides[roleName];

  let model: string;
  let source: ModelRole["source"];
  if (fileVal) {
    model = fileVal;
    source = "file";
  } else if (envVal) {
    model = envVal;
    source = "env";
  } else {
    model = defaultModel;
    source = "default";
  }

  return {
    model,
    description,
    envVar,
    default: defaultLabel,
    fileOverride: fileVal,
    envOverride: envVal,
    source,
  };
}

/**
 * Build the full model registry, resolving env overrides, file overrides,
 * and inheritance.
 * Call this at startup or whenever you need to inspect the active configuration.
 */
export function getModelRegistry(): Record<ModelRoleName, ModelRole> {
  const routing = resolveRole(
    "SOS_LLM_MODEL",
    "routing",
    DEFAULT_ROUTING_MODEL,
    "Slack message routing, intent classification, and tool-calling",
    DEFAULT_ROUTING_MODEL,
  );

  const titleGeneration = resolveRole(
    "SOS_TITLE_MODEL",
    "titleGeneration",
    routing.model,
    "Job and chat conversation title generation",
    `(inherits routing: ${routing.model})`,
  );

  const research = resolveRole(
    "SOS_RESEARCH_LLM_MODEL",
    "research",
    DEFAULT_RESEARCH_MODEL,
    "Research pipeline reasoning calls (query analysis, evaluation, synthesis)",
    DEFAULT_RESEARCH_MODEL,
  );

  const raptorSummarization = resolveRole(
    "SOS_RAPTOR_MODEL",
    "raptorSummarization",
    research.model,
    "RAPTOR tree cluster summarization",
    `(inherits research: ${research.model})`,
  );

  const embedding = resolveRole(
    "SOS_EMBEDDING_MODEL",
    "embedding",
    DEFAULT_EMBEDDING_MODEL,
    "Vector embeddings for knowledge base indexing and search",
    DEFAULT_EMBEDDING_MODEL,
  );

  return { routing, titleGeneration, research, raptorSummarization, embedding };
}

/**
 * Get the model identifier for a specific role.
 */
export function getModelForRole(role: ModelRoleName): string {
  return getModelRegistry()[role].model;
}
