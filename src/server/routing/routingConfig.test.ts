import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
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
    expect(config.actions.leave_channel.execution.type).toBe("leave_channel");
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

    // Modify the file directly — replace the commented model line with an uncommented one
    const raw = readFileSync(configPath, "utf-8");
    writeFileSync(configPath, raw.replace(/^#\s*model:.*$/m, "model: test-model"), "utf-8");

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

describe("backfillMissingActions", () => {
  it("adds missing built-in actions to an existing config", () => {
    // Write a config that is missing leave_channel
    const defaultYaml = generateDefaultConfig();
    writeFileSync(configPath, defaultYaml, "utf-8");

    // Remove leave_channel from the YAML file to simulate an old config
    const raw = readFileSync(configPath, "utf-8");
    const lines = raw.split("\n");
    const filtered: string[] = [];
    let skipping = false;
    for (const line of lines) {
      if (/^\s{2}leave_channel:/.test(line)) {
        skipping = true;
        continue;
      }
      if (skipping && /^\s{2}\w/.test(line)) {
        skipping = false;
      }
      if (!skipping) {
        filtered.push(line);
      }
    }
    writeFileSync(configPath, filtered.join("\n"), "utf-8");

    // Verify leave_channel is missing from the file
    const beforeRaw = readFileSync(configPath, "utf-8");
    expect(beforeRaw).not.toContain("leave_channel:");

    // Init should backfill it
    const config = initRoutingConfig(configPath);
    expect(config.actions.leave_channel).toBeDefined();
    expect(config.actions.leave_channel.execution.type).toBe("leave_channel");

    // Verify it was persisted to disk
    const afterRaw = readFileSync(configPath, "utf-8");
    expect(afterRaw).toContain("leave_channel");
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
      "leave_channel",
      "chat",
      "no_op",
    ];
    for (const action of expectedActions) {
      expect(yaml).toContain(`  ${action}:`);
    }
  });
});
