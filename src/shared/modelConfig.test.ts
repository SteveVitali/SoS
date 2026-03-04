import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  generateDefaultModelConfig,
  getModelConfigPath,
  getModelConfigRaw,
  getModelRegistry,
  getProviderSettings,
  getResolvedProviderSettings,
  initModelConfig,
  type ProviderSettings,
  reloadModelConfig,
  saveModelConfig,
} from "./modelConfig.js";

// Each test gets a fresh temp directory and config file
let tempDir: string;
let configPath: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `modelconfig-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  configPath = join(tempDir, "model-config.yaml");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("initModelConfig", () => {
  it("creates a default config file when none exists", () => {
    initModelConfig(configPath);
    const content = readFileSync(configPath, "utf-8");
    expect(content).toContain("# routing:");
    expect(content).toContain("# embedding:");
  });

  it("loads existing overrides from file", () => {
    writeFileSync(configPath, "routing: my-model\n", "utf-8");
    initModelConfig(configPath);
    const raw = getModelConfigRaw();
    expect(raw.routing).toBe("my-model");
  });

  it("loads provider settings from file", () => {
    writeFileSync(
      configPath,
      "provider: openai_compatible\nbase_url: https://example.com\napi_key: sk-test\n",
      "utf-8",
    );
    initModelConfig(configPath);
    const ps = getProviderSettings();
    expect(ps.provider).toBe("openai_compatible");
    expect(ps.base_url).toBe("https://example.com");
    expect(ps.api_key).toBe("sk-test");
  });

  it("ignores unknown provider values", () => {
    writeFileSync(configPath, "provider: google_vertex\n", "utf-8");
    initModelConfig(configPath);
    const ps = getProviderSettings();
    expect(ps.provider).toBeUndefined();
  });
});

describe("getModelConfigRaw", () => {
  it("returns cached overrides (not re-reading disk)", () => {
    writeFileSync(configPath, "routing: model-a\n", "utf-8");
    initModelConfig(configPath);
    // Mutate the file on disk after init
    writeFileSync(configPath, "routing: model-b\n", "utf-8");
    // getModelConfigRaw should return cached value, not re-read
    const raw = getModelConfigRaw();
    expect(raw.routing).toBe("model-a");
  });

  it("returns a defensive copy", () => {
    writeFileSync(configPath, "routing: model-a\n", "utf-8");
    initModelConfig(configPath);
    const raw = getModelConfigRaw();
    raw.routing = "mutated";
    expect(getModelConfigRaw().routing).toBe("model-a");
  });
});

describe("getProviderSettings", () => {
  it("returns empty object when no provider is set", () => {
    initModelConfig(configPath);
    const ps = getProviderSettings();
    expect(ps).toEqual({});
  });

  it("returns a defensive copy", () => {
    writeFileSync(configPath, "provider: anthropic\n", "utf-8");
    initModelConfig(configPath);
    const ps = getProviderSettings();
    ps.provider = "openai_compatible";
    expect(getProviderSettings().provider).toBe("anthropic");
  });
});

describe("getResolvedProviderSettings", () => {
  it("defaults to openai_compatible when nothing is set", () => {
    vi.stubEnv("SOS_LLM_PROVIDER", "");
    vi.stubEnv("SOS_LLM_BASE_URL", "");
    vi.stubEnv("SOS_LLM_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    initModelConfig(configPath);

    const resolved = getResolvedProviderSettings();
    expect(resolved.provider).toBe("openai_compatible");
    expect(resolved.source.provider).toBe("default");
  });

  it("file overrides env var", () => {
    vi.stubEnv("SOS_LLM_PROVIDER", "anthropic");
    vi.stubEnv("SOS_LLM_BASE_URL", "https://env-url.com");
    writeFileSync(
      configPath,
      "provider: openai_compatible\nbase_url: https://file-url.com\n",
      "utf-8",
    );
    initModelConfig(configPath);

    const resolved = getResolvedProviderSettings();
    expect(resolved.provider).toBe("openai_compatible");
    expect(resolved.source.provider).toBe("file");
    expect(resolved.base_url).toBe("https://file-url.com");
    expect(resolved.source.base_url).toBe("file");
  });

  it("env var fills in when file has no setting", () => {
    vi.stubEnv("SOS_LLM_PROVIDER", "anthropic");
    vi.stubEnv("SOS_LLM_BASE_URL", "https://env-url.com");
    vi.stubEnv("SOS_LLM_API_KEY", "sk-env-key");
    initModelConfig(configPath);

    const resolved = getResolvedProviderSettings();
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.source.provider).toBe("env");
    expect(resolved.base_url).toBe("https://env-url.com");
    expect(resolved.source.base_url).toBe("env");
    expect(resolved.api_key).toBe("sk-env-key");
    expect(resolved.source.api_key).toBe("env");
  });

  it("falls back to ANTHROPIC_API_KEY when SOS_LLM_API_KEY is unset", () => {
    vi.stubEnv("SOS_LLM_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-anthropic");
    initModelConfig(configPath);

    const resolved = getResolvedProviderSettings();
    expect(resolved.api_key).toBe("sk-anthropic");
    expect(resolved.source.api_key).toBe("env");
  });
});

describe("saveModelConfig", () => {
  it("saves model overrides to YAML", () => {
    initModelConfig(configPath);
    saveModelConfig({ routing: "new-model", research: "research-model" });
    const content = readFileSync(configPath, "utf-8");
    expect(content).toContain("routing: new-model");
    expect(content).toContain("research: research-model");
  });

  it("saves provider settings alongside overrides", () => {
    initModelConfig(configPath);
    saveModelConfig({ routing: "my-model" }, { provider: "anthropic", base_url: "https://x.com" });

    const content = readFileSync(configPath, "utf-8");
    expect(content).toContain("provider: anthropic");
    expect(content).toContain("base_url: https://x.com");
    expect(content).toContain("routing: my-model");
  });

  it("preserves cached provider when providerSettings param is undefined", () => {
    writeFileSync(configPath, "provider: anthropic\nbase_url: https://cached.com\n", "utf-8");
    initModelConfig(configPath);

    // Save overrides only, no explicit provider
    saveModelConfig({ routing: "model-x" });

    const content = readFileSync(configPath, "utf-8");
    expect(content).toContain("provider: anthropic");
    expect(content).toContain("base_url: https://cached.com");
    expect(content).toContain("routing: model-x");
  });

  it("updates cache after save", () => {
    initModelConfig(configPath);
    saveModelConfig(
      { routing: "saved-model" },
      { provider: "openai_compatible", base_url: "https://new.com" },
    );

    expect(getModelConfigRaw().routing).toBe("saved-model");
    expect(getProviderSettings().provider).toBe("openai_compatible");
    expect(getProviderSettings().base_url).toBe("https://new.com");
  });

  it("strips empty values", () => {
    initModelConfig(configPath);
    saveModelConfig({ routing: "valid", titleGeneration: "", research: "  " });
    const raw = getModelConfigRaw();
    expect(raw.routing).toBe("valid");
    expect(raw.titleGeneration).toBeUndefined();
    expect(raw.research).toBeUndefined();
  });

  it("writes default template when all values are cleared", () => {
    initModelConfig(configPath);
    saveModelConfig({}, {});
    const content = readFileSync(configPath, "utf-8");
    expect(content).toContain("# routing:");
  });
});

describe("reloadModelConfig", () => {
  it("reloads overrides and provider from disk", () => {
    initModelConfig(configPath);
    // Write new content directly to disk
    writeFileSync(configPath, "provider: anthropic\nrouting: reloaded-model\n", "utf-8");
    reloadModelConfig();

    expect(getModelConfigRaw().routing).toBe("reloaded-model");
    expect(getProviderSettings().provider).toBe("anthropic");
  });
});

describe("getModelRegistry", () => {
  it("resolves file overrides with highest priority", () => {
    vi.stubEnv("SOS_LLM_MODEL", "env-model");
    writeFileSync(configPath, "routing: file-model\n", "utf-8");
    initModelConfig(configPath);

    const registry = getModelRegistry();
    expect(registry.routing.model).toBe("file-model");
    expect(registry.routing.source).toBe("file");
    expect(registry.routing.envOverride).toBe("env-model");
    expect(registry.routing.fileOverride).toBe("file-model");
  });

  it("falls back to env when no file override", () => {
    vi.stubEnv("SOS_LLM_MODEL", "env-model");
    initModelConfig(configPath);

    const registry = getModelRegistry();
    expect(registry.routing.model).toBe("env-model");
    expect(registry.routing.source).toBe("env");
  });

  it("titleGeneration inherits from routing", () => {
    writeFileSync(configPath, "routing: custom-routing\n", "utf-8");
    initModelConfig(configPath);

    const registry = getModelRegistry();
    expect(registry.titleGeneration.model).toBe("custom-routing");
    expect(registry.titleGeneration.source).toBe("default");
  });

  it("raptorSummarization inherits from research", () => {
    writeFileSync(configPath, "research: custom-research\n", "utf-8");
    initModelConfig(configPath);

    const registry = getModelRegistry();
    expect(registry.raptorSummarization.model).toBe("custom-research");
    expect(registry.raptorSummarization.source).toBe("default");
  });
});
