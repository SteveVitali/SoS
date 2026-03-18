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
 * │ routing              │ claude-opus-4.5     │ SOS_LLM_MODEL                    │
 * │ titleGeneration      │ (inherits routing)           │ SOS_TITLE_MODEL                  │
 * │ research             │ claude-opus-4.5     │ SOS_RESEARCH_LLM_MODEL           │
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
  | "embedding"
  | "imageGeneration"
  | "memory";

export type LLMProviderType = "anthropic" | "openai_compatible";

const VALID_PROVIDERS = new Set<string>(["anthropic", "openai_compatible"]);

export interface ProviderSettings {
  provider?: LLMProviderType;
  base_url?: string;
  api_key?: string;
}

export interface ResolvedProviderSettings {
  provider: LLMProviderType;
  base_url: string;
  api_key: string;
  source: { provider: string; base_url: string; api_key: string };
}

// ─── Defaults ───────────────────────────────────────────────────

const DEFAULT_ROUTING_MODEL = "claude-opus-4.5";
const DEFAULT_RESEARCH_MODEL = "claude-opus-4.5";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_IMAGE_MODEL = "gpt-image-1";
const DEFAULT_MEMORY_MODEL = "gpt-4.1-mini";

const VALID_ROLES: ModelRoleName[] = [
  "routing",
  "titleGeneration",
  "research",
  "raptorSummarization",
  "embedding",
  "imageGeneration",
  "memory",
];

// ─── File-based override layer ──────────────────────────────────

let cachedOverrides: Partial<Record<ModelRoleName, string>> = {};
let cachedProvider: ProviderSettings = {};
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
    `# imageGeneration: ${DEFAULT_IMAGE_MODEL}            # Env: SOS_IMAGE_MODEL`,
    "",
  ].join("\n");
}

interface ParsedConfig {
  overrides: Partial<Record<ModelRoleName, string>>;
  provider: ProviderSettings;
}

/**
 * Parse the YAML file into model overrides + provider settings.
 * Model role keys go into overrides; provider/base_url/api_key go into provider.
 */
function parseConfigFile(filePath: string): ParsedConfig {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = parseYaml(raw);
    if (!data || typeof data !== "object") return { overrides: {}, provider: {} };

    const overrides: Partial<Record<ModelRoleName, string>> = {};
    for (const role of VALID_ROLES) {
      if (typeof data[role] === "string" && data[role].trim()) {
        overrides[role] = data[role].trim();
      }
    }

    const provider: ProviderSettings = {};
    if (typeof data.provider === "string" && data.provider.trim()) {
      const raw = data.provider.trim();
      if (VALID_PROVIDERS.has(raw)) {
        provider.provider = raw as LLMProviderType;
      } else {
        log.warn("Unknown provider in model config, ignoring", { provider: raw });
      }
    }
    if (typeof data.base_url === "string" && data.base_url.trim()) {
      provider.base_url = data.base_url.trim();
    }
    if (typeof data.api_key === "string" && data.api_key.trim()) {
      provider.api_key = data.api_key.trim();
    }

    return { overrides, provider };
  } catch (err: unknown) {
    log.error("Failed to parse model config file", {
      path: filePath,
      error: (err as Error).message,
    });
    return { overrides: {}, provider: {} };
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

  const parsed = parseConfigFile(filePath);
  cachedOverrides = parsed.overrides;
  cachedProvider = parsed.provider;
  const overrideCount = Object.keys(cachedOverrides).length;
  log.info("Model config loaded", {
    path: filePath,
    overrides: overrideCount,
    provider: cachedProvider.provider || "(not set)",
  });

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
            const parsed = parseConfigFile(filePath);
            cachedOverrides = parsed.overrides;
            cachedProvider = parsed.provider;
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
  return { ...cachedOverrides };
}

/**
 * Get the provider settings from model-config.yaml.
 */
export function getProviderSettings(): ProviderSettings {
  return { ...cachedProvider };
}

/**
 * Get the resolved provider settings (YAML > env > default).
 */
export function getResolvedProviderSettings(): ResolvedProviderSettings {
  const fileProvider = cachedProvider.provider;
  const envProvider = process.env.SOS_LLM_PROVIDER as LLMProviderType | undefined;
  const provider = fileProvider || envProvider || "openai_compatible";
  const providerSource = fileProvider ? "file" : envProvider ? "env" : "default";

  const fileBaseUrl = cachedProvider.base_url;
  const envBaseUrl = process.env.SOS_LLM_BASE_URL;
  const base_url = fileBaseUrl || envBaseUrl || "";
  const baseUrlSource = fileBaseUrl ? "file" : envBaseUrl ? "env" : "default";

  const fileApiKey = cachedProvider.api_key;
  const envApiKey = process.env.SOS_LLM_API_KEY || process.env.ANTHROPIC_API_KEY;
  const api_key = fileApiKey || envApiKey || "";
  const apiKeySource = fileApiKey ? "file" : envApiKey ? "env" : "default";

  return {
    provider,
    base_url,
    api_key,
    source: { provider: providerSource, base_url: baseUrlSource, api_key: apiKeySource },
  };
}

/**
 * Save model overrides and provider settings to disk as YAML and reload the cache.
 */
export function saveModelConfig(
  overrides: Partial<Record<ModelRoleName, string>>,
  providerSettings?: ProviderSettings,
): void {
  if (!modelConfigPath) {
    throw new Error("Model config not initialized. Call initModelConfig() first.");
  }
  // Filter out empty/invalid model role values
  const clean: Record<string, string> = {};
  for (const role of VALID_ROLES) {
    const val = overrides[role];
    if (typeof val === "string" && val.trim()) {
      clean[role] = val.trim();
    }
  }

  // Merge provider settings
  const providerToSave = providerSettings ?? cachedProvider;
  const combined: Record<string, string> = {};
  if (providerToSave.provider?.trim()) combined.provider = providerToSave.provider.trim();
  if (providerToSave.base_url?.trim()) combined.base_url = providerToSave.base_url.trim();
  if (providerToSave.api_key?.trim()) combined.api_key = providerToSave.api_key.trim();
  Object.assign(combined, clean);

  const yaml =
    Object.keys(combined).length > 0
      ? stringifyYaml(combined, { lineWidth: 120 })
      : generateDefaultModelConfig();

  suppressNextWatch = true;
  writeFileSync(modelConfigPath, yaml, "utf-8");
  log.info("Model config saved", {
    path: modelConfigPath,
    overrides: Object.keys(clean),
    provider: !!providerSettings,
  });
  const parsed = parseConfigFile(modelConfigPath);
  cachedOverrides = parsed.overrides;
  cachedProvider = parsed.provider;
}

/**
 * Force-reload model config from disk.
 */
export function reloadModelConfig(): void {
  if (!modelConfigPath) {
    throw new Error("Model config not initialized.");
  }
  const parsed = parseConfigFile(modelConfigPath);
  cachedOverrides = parsed.overrides;
  cachedProvider = parsed.provider;
  log.info("Model config reloaded", {
    overrides: Object.keys(cachedOverrides),
    provider: cachedProvider.provider || "(not set)",
  });
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

  const imageGeneration = resolveRole(
    "SOS_IMAGE_MODEL",
    "imageGeneration",
    DEFAULT_IMAGE_MODEL,
    "Image generation from text prompts",
    DEFAULT_IMAGE_MODEL,
  );

  const memory = resolveRole(
    "SOS_MEMORY_MODEL",
    "memory",
    DEFAULT_MEMORY_MODEL,
    "Memory extraction, curation, reflection, and evolution",
    DEFAULT_MEMORY_MODEL,
  );

  return {
    routing,
    titleGeneration,
    research,
    raptorSummarization,
    embedding,
    imageGeneration,
    memory,
  };
}

/**
 * Get the model identifier for a specific role.
 */
export function getModelForRole(role: ModelRoleName): string {
  return getModelRegistry()[role].model;
}
