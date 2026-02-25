import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRegistry, mergeMcpServers } from "./repoRegistry.js";

function writeTempYaml(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sos-test-"));
  const file = path.join(dir, "registry.yaml");
  writeFileSync(file, content, "utf-8");
  return file;
}

describe("loadRegistry", () => {
  it("loads a valid multi-repo registry", () => {
    const file = writeTempYaml(`
repos:
  frontend:
    clone: git@github.com:org/frontend.git
    default_branch: develop
    max_worktrees: 3
    clean_mode: full
    detect:
      keywords: [react, ui]
    commands:
      lint: [npm run lint]
      test_fast: [npm test]
    ci:
      provider: github_actions
  backend:
    clone: git@github.com:org/backend.git
`);
    const registry = loadRegistry(file);
    expect(registry.repos.size).toBe(2);

    const fe = registry.repos.get("frontend")!;
    expect(fe.id).toBe("frontend");
    expect(fe.clone).toBe("git@github.com:org/frontend.git");
    expect(fe.default_branch).toBe("develop");
    expect(fe.max_worktrees).toBe(3);
    expect(fe.clean_mode).toBe("full");
    expect(fe.detect?.keywords).toEqual(["react", "ui"]);
    expect(fe.ci?.provider).toBe("github_actions");
  });

  it("applies default values for optional fields", () => {
    const file = writeTempYaml(`
repos:
  myrepo:
    clone: git@github.com:org/myrepo.git
`);
    const registry = loadRegistry(file);
    const repo = registry.repos.get("myrepo")!;
    expect(repo.default_branch).toBe("main");
    expect(repo.max_worktrees).toBe(1);
    expect(repo.clean_mode).toBe("light");
  });

  it("coerces invalid clean_mode to light", () => {
    const file = writeTempYaml(`
repos:
  myrepo:
    clone: git@github.com:org/myrepo.git
    clean_mode: invalid_value
`);
    const repo = loadRegistry(file).repos.get("myrepo")!;
    expect(repo.clean_mode).toBe("light");
  });

  it("returns empty registry for missing repos key", () => {
    const file = writeTempYaml("settings:\n  foo: bar\n");
    const registry = loadRegistry(file);
    expect(registry.repos.size).toBe(0);
  });

  it("returns empty registry for empty file", () => {
    const file = writeTempYaml("");
    const registry = loadRegistry(file);
    expect(registry.repos.size).toBe(0);
  });

  it("returns empty registry for non-existent file", () => {
    const registry = loadRegistry("/tmp/does-not-exist-sos-test.yaml");
    expect(registry.repos.size).toBe(0);
  });

  it("returns empty registry for malformed YAML", () => {
    const file = writeTempYaml(":::not valid yaml[[[");
    const registry = loadRegistry(file);
    expect(registry.repos.size).toBe(0);
  });

  it("sets the id field from the YAML key", () => {
    const file = writeTempYaml(`
repos:
  my-custom-id:
    clone: git@github.com:org/repo.git
`);
    const repo = loadRegistry(file).repos.get("my-custom-id")!;
    expect(repo.id).toBe("my-custom-id");
  });

  it("parses per-repo stdio MCP servers", () => {
    const file = writeTempYaml(`
repos:
  myrepo:
    clone: git@github.com:org/myrepo.git
    mcp_servers:
      linear:
        transport: stdio
        command: npx
        args: ["-y", "@anthropic/linear-mcp-server"]
        allowed_tools: [search_issues, get_issue]
`);
    const repo = loadRegistry(file).repos.get("myrepo")!;
    expect(repo.mcp_servers).toBeDefined();
    expect(repo.mcp_servers!.linear.transport).toBe("stdio");
    expect(repo.mcp_servers!.linear.command).toBe("npx");
    expect(repo.mcp_servers!.linear.args).toEqual(["-y", "@anthropic/linear-mcp-server"]);
    expect(repo.mcp_servers!.linear.allowed_tools).toEqual(["search_issues", "get_issue"]);
  });

  it("parses http and sse MCP transports", () => {
    const file = writeTempYaml(`
repos:
  myrepo:
    clone: git@github.com:org/myrepo.git
    mcp_servers:
      sentry:
        transport: http
        url: "https://mcp.sentry.dev/mcp"
      legacy:
        transport: sse
        url: "https://old.example.com/sse"
`);
    const repo = loadRegistry(file).repos.get("myrepo")!;
    expect(repo.mcp_servers!.sentry.transport).toBe("http");
    expect(repo.mcp_servers!.sentry.url).toBe("https://mcp.sentry.dev/mcp");
    expect(repo.mcp_servers!.legacy.transport).toBe("sse");
    expect(repo.mcp_servers!.legacy.url).toBe("https://old.example.com/sse");
  });

  it("interpolates ${VAR} in env and headers from process.env", () => {
    const orig = process.env.TEST_MCP_SECRET;
    process.env.TEST_MCP_SECRET = "s3cret";
    try {
      const file = writeTempYaml(`
repos:
  myrepo:
    clone: git@github.com:org/myrepo.git
    mcp_servers:
      svc:
        transport: stdio
        command: node
        args: [server.js]
        env:
          API_KEY: "\${TEST_MCP_SECRET}"
`);
      const repo = loadRegistry(file).repos.get("myrepo")!;
      expect(repo.mcp_servers!.svc.env!.API_KEY).toBe("s3cret");
    } finally {
      if (orig === undefined) delete process.env.TEST_MCP_SECRET;
      else process.env.TEST_MCP_SECRET = orig;
    }
  });

  it("merges global MCP servers with per-repo servers", () => {
    const file = writeTempYaml(`
mcp_servers:
  global-svc:
    transport: stdio
    command: global-cmd
repos:
  myrepo:
    clone: git@github.com:org/myrepo.git
    mcp_servers:
      repo-svc:
        transport: http
        url: "https://example.com/mcp"
`);
    const registry = loadRegistry(file);
    const repo = registry.repos.get("myrepo")!;
    expect(repo.mcp_servers!["global-svc"]).toBeDefined();
    expect(repo.mcp_servers!["global-svc"].command).toBe("global-cmd");
    expect(repo.mcp_servers!["repo-svc"]).toBeDefined();
    expect(repo.mcp_servers!["repo-svc"].url).toBe("https://example.com/mcp");
  });

  it("repo-level MCP server overrides global by name", () => {
    const file = writeTempYaml(`
mcp_servers:
  shared:
    transport: stdio
    command: global-cmd
repos:
  myrepo:
    clone: git@github.com:org/myrepo.git
    mcp_servers:
      shared:
        transport: http
        url: "https://override.com/mcp"
`);
    const repo = loadRegistry(file).repos.get("myrepo")!;
    expect(repo.mcp_servers!.shared.transport).toBe("http");
    expect(repo.mcp_servers!.shared.url).toBe("https://override.com/mcp");
    expect(repo.mcp_servers!.shared.command).toBeUndefined();
  });

  it("repos without mcp_servers still inherit global MCP servers", () => {
    const file = writeTempYaml(`
mcp_servers:
  global-svc:
    transport: stdio
    command: global-cmd
repos:
  myrepo:
    clone: git@github.com:org/myrepo.git
`);
    const repo = loadRegistry(file).repos.get("myrepo")!;
    expect(repo.mcp_servers!["global-svc"]).toBeDefined();
  });

  it("returns no mcp_servers when none configured", () => {
    const file = writeTempYaml(`
repos:
  myrepo:
    clone: git@github.com:org/myrepo.git
`);
    const repo = loadRegistry(file).repos.get("myrepo")!;
    expect(repo.mcp_servers).toBeUndefined();
  });
});

describe("mergeMcpServers", () => {
  it("returns undefined when both inputs are undefined", () => {
    expect(mergeMcpServers(undefined, undefined)).toBeUndefined();
  });

  it("returns global when repo is undefined", () => {
    const global = { svc: { transport: "stdio" as const, command: "cmd" } };
    expect(mergeMcpServers(global, undefined)).toEqual(global);
  });

  it("returns repo when global is undefined", () => {
    const repo = { svc: { transport: "http" as const, url: "https://x.com" } };
    expect(mergeMcpServers(undefined, repo)).toEqual(repo);
  });

  it("repo overrides global by name", () => {
    const global = { svc: { transport: "stdio" as const, command: "old" } };
    const repo = { svc: { transport: "http" as const, url: "https://new.com" } };
    const merged = mergeMcpServers(global, repo)!;
    expect(merged.svc.transport).toBe("http");
    expect(merged.svc.url).toBe("https://new.com");
  });
});
