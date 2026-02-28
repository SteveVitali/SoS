/**
 * Loads and caches the routing configuration from a YAML file.
 * Watches for file changes and reloads automatically.
 */

import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createLogger } from "../../shared/logger.js";
import { generateDefaultConfig } from "./defaultConfig.js";
import type { ActionDef, ExecutionDef, ParamDef, RoutingConfig } from "./routingTypes.js";

const log = createLogger("server:routing:config");

let cachedConfig: RoutingConfig | null = null;
let configPath: string | null = null;
let watcherActive = false;
let suppressNextWatch = false;

/**
 * Parse a raw YAML action definition into a typed ActionDef.
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic config type
function parseActionDef(raw: any): ActionDef {
  const params: Record<string, ParamDef> = {};
  if (raw.parameters && typeof raw.parameters === "object") {
    for (const [name, pRaw] of Object.entries(raw.parameters)) {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic config type
      const p = pRaw as any;
      params[name] = {
        type: p.type || "string",
        description: p.description,
        required: p.required ?? false,
        enum: p.enum,
        items: p.items,
      };
    }
  }

  return {
    enabled: raw.enabled !== false,
    description: raw.description || "",
    routing_hint: raw.routing_hint,
    parameters: params,
    execution: (raw.execution || { type: "reply" }) as ExecutionDef,
    defaults: raw.defaults,
  };
}

/**
 * Parse raw YAML data into a typed RoutingConfig.
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic config type
function parseRoutingConfig(data: any): RoutingConfig {
  const actions: Record<string, ActionDef> = {};
  if (data?.actions && typeof data.actions === "object") {
    for (const [name, raw] of Object.entries(data.actions)) {
      actions[name] = parseActionDef(raw);
    }
  }

  const customActions: Record<string, ActionDef> = {};
  if (data?.custom_actions && typeof data.custom_actions === "object") {
    for (const [name, raw] of Object.entries(data.custom_actions)) {
      customActions[name] = parseActionDef(raw);
    }
  }

  return {
    model: data?.model,
    system_prompt: data?.system_prompt || "",
    actions,
    custom_actions: customActions,
  };
}

/**
 * Load the routing config from the YAML file path.
 */
function loadFromFile(filePath: string): RoutingConfig {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = parseYaml(raw);
    const config = parseRoutingConfig(data);
    const actionCount = Object.keys(config.actions).length;
    const customCount = Object.keys(config.custom_actions).length;
    log.info("Routing config loaded", {
      path: filePath,
      actions: actionCount,
      custom: customCount,
    });
    return config;
  } catch (err: unknown) {
    log.error("Failed to load routing config", { path: filePath, error: (err as Error).message });
    throw err;
  }
}

/**
 * Backfill any built-in actions that were added to defaultConfig after the
 * user's YAML was originally generated. Missing actions are inserted and
 * the file is persisted so this only happens once per new action.
 */
function backfillMissingActions(filePath: string, config: RoutingConfig): RoutingConfig {
  const defaultYaml = generateDefaultConfig();
  const defaultData = parseYaml(defaultYaml);
  const defaultConfig = parseRoutingConfig(defaultData);

  const missing: string[] = [];
  for (const [name, actionDef] of Object.entries(defaultConfig.actions)) {
    if (!(name in config.actions)) {
      config.actions[name] = actionDef;
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    log.info("Backfilled missing built-in actions into routing config", {
      actions: missing,
    });
    // Persist so this only runs once: read raw YAML, add missing action blocks, rewrite
    const rawData = parseYaml(readFileSync(filePath, "utf-8")) || {};
    if (!rawData.actions) rawData.actions = {};
    const defaultRawActions = defaultData.actions || {};
    for (const name of missing) {
      rawData.actions[name] = defaultRawActions[name];
    }
    suppressNextWatch = true;
    writeFileSync(filePath, stringifyYaml(rawData, { lineWidth: 120 }), "utf-8");
    log.info("Updated routing config file with backfilled actions", { path: filePath });
  }

  return config;
}

/**
 * Initialize the routing config system. Call once at server startup.
 * If the file doesn't exist, generates a default config.
 */
export function initRoutingConfig(filePath: string): RoutingConfig {
  configPath = filePath;

  if (!existsSync(filePath)) {
    log.info("Routing config not found, generating default", { path: filePath });
    const defaultYaml = generateDefaultConfig();
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, defaultYaml, "utf-8");
    log.info("Default routing config written", { path: filePath });
  }

  cachedConfig = loadFromFile(filePath);
  cachedConfig = backfillMissingActions(filePath, cachedConfig);

  // Watch for file changes
  if (!watcherActive) {
    try {
      watch(filePath, (eventType) => {
        if (eventType === "change") {
          if (suppressNextWatch) {
            suppressNextWatch = false;
            return;
          }
          log.info("Routing config file changed, reloading");
          try {
            cachedConfig = loadFromFile(filePath);
          } catch (err: unknown) {
            log.error("Failed to reload routing config, keeping previous", {
              error: (err as Error).message,
            });
          }
        }
      });
      watcherActive = true;
    } catch {
      log.warn("Could not watch routing config file for changes");
    }
  }

  return cachedConfig;
}

/**
 * Get the current routing config. Returns cached version.
 * Throws if initRoutingConfig hasn't been called.
 */
export function getRoutingConfig(): RoutingConfig {
  if (!cachedConfig) {
    throw new Error("Routing config not initialized. Call initRoutingConfig() first.");
  }
  return cachedConfig;
}

/**
 * Get the file path of the routing config (for API routes).
 */
export function getRoutingConfigPath(): string | null {
  return configPath;
}

/**
 * Reload the routing config from disk. Used by API routes after edits.
 */
export function reloadRoutingConfig(): RoutingConfig {
  if (!configPath) {
    throw new Error("Routing config not initialized.");
  }
  cachedConfig = loadFromFile(configPath);
  return cachedConfig;
}

/**
 * Save routing config data to disk as YAML.
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic config type
export function saveRoutingConfig(data: any): void {
  if (!configPath) {
    throw new Error("Routing config not initialized.");
  }
  const yaml = stringifyYaml(data, { lineWidth: 120 });
  suppressNextWatch = true;
  writeFileSync(configPath, yaml, "utf-8");
  log.info("Routing config saved", { path: configPath });
  // Reload the cache
  cachedConfig = loadFromFile(configPath);
}

/**
 * Get the raw YAML data (for API responses).
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic config type
export function getRoutingConfigRaw(): any {
  if (!configPath) {
    throw new Error("Routing config not initialized.");
  }
  const raw = readFileSync(configPath, "utf-8");
  return parseYaml(raw);
}
