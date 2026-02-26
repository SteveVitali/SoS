import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateDefaultConfig } from "./defaultConfig.js";
import {
  getRoutingConfig,
  getRoutingConfigPath,
  getRoutingConfigRaw,
  initRoutingConfig,
  reloadRoutingConfig,
  saveRoutingConfig,
} from "./routingConfig.js";

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sos-routing-test-"));
  configPath = join(tmpDir, "routing-config.yaml");
});

describe("initRoutingConfig", () => {
  it("generates default config when file does not exist", () => {
    expect(existsSync(configPath)).toBe(false);
    const config = initRoutingConfig(configPath);
    expect(existsSync(configPath)).toBe(true);
    expect(config.system_prompt).toContain("Steve");
    expect(Object.keys(config.actions).length).toBeGreaterThan(5);
  });

  it("loads existing config from file", () => {
    writeFileSync(configPath, generateDefaultConfig(), "utf-8");
    const config = initRoutingConfig(configPath);
    expect(config.actions.create_job).toBeDefined();
    expect(config.actions.create_job.enabled).toBe(true);
  });

  it("parses all built-in action types correctly", () => {
    writeFileSync(configPath, generateDefaultConfig(), "utf-8");
    const config = initRoutingConfig(configPath);

    expect(config.actions.create_job.execution.type).toBe("create_job");
    expect(config.actions.cancel_job.execution.type).toBe("job_action");
    expect(config.actions.job_status.execution.type).toBe("job_query");
    expect(config.actions.list_jobs.execution.type).toBe("job_list");
    expect(config.actions.chat.execution.type).toBe("reply");
    expect(config.actions.no_op.execution.type).toBe("reply");
    expect(config.actions.github.execution.type).toBe("github_query");
    expect(config.actions.respond_to_pr_comments.execution.type).toBe("create_respond_job");
  });

  it("parses custom_actions as empty object by default", () => {
    writeFileSync(configPath, generateDefaultConfig(), "utf-8");
    const config = initRoutingConfig(configPath);
    expect(config.custom_actions).toEqual({});
  });
});

describe("getRoutingConfig", () => {
  it("returns cached config after init", () => {
    writeFileSync(configPath, generateDefaultConfig(), "utf-8");
    initRoutingConfig(configPath);
    const config = getRoutingConfig();
    expect(config.system_prompt).toContain("Steve");
  });
});

describe("getRoutingConfigPath", () => {
  it("returns the file path after init", () => {
    writeFileSync(configPath, generateDefaultConfig(), "utf-8");
    initRoutingConfig(configPath);
    expect(getRoutingConfigPath()).toBe(configPath);
  });
});

describe("reloadRoutingConfig", () => {
  it("reloads config from disk", () => {
    writeFileSync(configPath, generateDefaultConfig(), "utf-8");
    initRoutingConfig(configPath);

    // Modify the file directly
    const raw = readFileSync(configPath, "utf-8");
    writeFileSync(configPath, raw.replace("claude-sonnet-4-20250514", "test-model"), "utf-8");

    const reloaded = reloadRoutingConfig();
    expect(reloaded.model).toBe("test-model");
  });
});

describe("saveRoutingConfig", () => {
  it("writes config to disk and reloads cache", () => {
    writeFileSync(configPath, generateDefaultConfig(), "utf-8");
    initRoutingConfig(configPath);

    const raw = getRoutingConfigRaw();
    raw.model = "custom-model";
    saveRoutingConfig(raw);

    const config = getRoutingConfig();
    expect(config.model).toBe("custom-model");

    // Verify it was written to disk
    const diskRaw = readFileSync(configPath, "utf-8");
    expect(diskRaw).toContain("custom-model");
  });
});

describe("getRoutingConfigRaw", () => {
  it("returns parsed YAML data", () => {
    writeFileSync(configPath, generateDefaultConfig(), "utf-8");
    initRoutingConfig(configPath);

    const raw = getRoutingConfigRaw();
    expect(raw.system_prompt).toBeDefined();
    expect(raw.actions).toBeDefined();
    expect(raw.actions.create_job).toBeDefined();
  });
});

describe("generateDefaultConfig", () => {
  it("produces valid YAML that can be parsed", () => {
    const yaml = generateDefaultConfig();
    expect(yaml).toContain("system_prompt:");
    expect(yaml).toContain("actions:");
    expect(yaml).toContain("custom_actions:");
    expect(yaml).toContain("{ACTIONS}");
    expect(yaml).toContain("{JOBS_CONTEXT}");
  });

  it("includes all expected built-in actions", () => {
    const yaml = generateDefaultConfig();
    const expectedActions = [
      "create_job",
      "plan_job",
      "confirm_job",
      "job_status",
      "cancel_job",
      "retry_job",
      "promote_pr",
      "respond_to_pr_comments",
      "github",
      "list_jobs",
      "chat",
      "no_op",
    ];
    for (const action of expectedActions) {
      expect(yaml).toContain(`  ${action}:`);
    }
  });
});
