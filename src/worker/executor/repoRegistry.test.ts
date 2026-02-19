import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadRegistry } from "./repoRegistry.js";

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
});
