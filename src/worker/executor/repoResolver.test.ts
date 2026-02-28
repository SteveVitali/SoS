import { describe, expect, it } from "vitest";
import type { RepoEntry, RepoRegistry } from "./repoRegistry.js";
import { resolveRepo } from "./repoResolver.js";

function makeRepo(id: string, keywords: string[] = []): RepoEntry {
  return {
    id,
    clone: `git@github.com:org/${id}.git`,
    default_branch: "main",
    max_worktrees: 1,
    clean_mode: "light",
    detect: { keywords },
  };
}

function makeRegistry(...repos: RepoEntry[]): RepoRegistry {
  const map = new Map<string, RepoEntry>();
  for (const r of repos) map.set(r.id, r);
  return { repos: map };
}

describe("resolveRepo", () => {
  const frontend = makeRepo("frontend", ["react", "css", "ui"]);
  const backend = makeRepo("backend", ["api", "database", "server"]);
  const infra = makeRepo("infra", ["terraform", "deploy"]);
  const registry = makeRegistry(frontend, backend, infra);

  describe("hint matching", () => {
    it("resolves by exact repo hint", () => {
      const result = resolveRepo(registry, "anything", "backend");
      expect(result).not.toBeNull();
      expect(result?.repo.id).toBe("backend");
      expect(result?.method).toBe("hint");
      expect(result?.score).toBe(1);
    });

    it("returns null for non-existent hint and falls through to keywords", () => {
      const result = resolveRepo(registry, "no keywords here", "nonexistent");
      expect(result).toBeNull();
    });

    it("falls through to keyword match when hint is invalid but text has keywords", () => {
      const result = resolveRepo(registry, "fix the react component", "nonexistent");
      expect(result).not.toBeNull();
      expect(result?.repo.id).toBe("frontend");
      expect(result?.method).toBe("keyword");
    });
  });

  describe("keyword matching", () => {
    it("matches a single keyword", () => {
      const result = resolveRepo(registry, "fix the terraform module");
      expect(result).not.toBeNull();
      expect(result?.repo.id).toBe("infra");
      expect(result?.score).toBe(1);
    });

    it("scores higher with more keyword matches", () => {
      const result = resolveRepo(registry, "fix the react ui css issue");
      expect(result).not.toBeNull();
      expect(result?.repo.id).toBe("frontend");
      expect(result?.score).toBe(3); // react + css + ui
    });

    it("is case-insensitive", () => {
      const result = resolveRepo(registry, "Fix the REACT UI");
      expect(result).not.toBeNull();
      expect(result?.repo.id).toBe("frontend");
    });

    it("returns null when no keywords match", () => {
      const result = resolveRepo(registry, "do something with kubernetes");
      expect(result).toBeNull();
    });

    it("picks highest scorer when multiple repos match", () => {
      // "api" matches backend, "react" matches frontend — one each, but let's make backend win
      const result = resolveRepo(registry, "fix the api server database connection");
      expect(result).not.toBeNull();
      expect(result?.repo.id).toBe("backend");
      expect(result?.score).toBe(3); // api + database + server
    });
  });

  describe("ambiguity", () => {
    it("warns when top two repos have the same score", () => {
      // One keyword each: "react" → frontend, "api" → backend
      const result = resolveRepo(registry, "fix the react api integration");
      expect(result).not.toBeNull();
      expect(result?.warning).toBeDefined();
      expect(result?.warning).toContain("Ambiguous");
    });

    it("no warning when there is a clear winner", () => {
      const result = resolveRepo(registry, "fix the react ui css");
      expect(result).not.toBeNull();
      expect(result?.warning).toBeUndefined();
    });
  });

  describe("empty registry", () => {
    it("returns null with empty registry", () => {
      const empty = makeRegistry();
      expect(resolveRepo(empty, "fix everything")).toBeNull();
    });
  });
});
