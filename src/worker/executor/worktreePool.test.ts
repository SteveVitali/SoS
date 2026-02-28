import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoEntry } from "./repoRegistry.js";

// Mock child_process and fs before importing the module
vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn(() => ""),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Import after mocks are set up
const { worktreePool } = await import("./worktreePool.js");
const { existsSync, readFileSync, readdirSync } = await import("node:fs");
const { execSync } = await import("node:child_process");

function makeRepo(overrides: Partial<RepoEntry> = {}): RepoEntry {
  return {
    id: "my-repo",
    clone: "git@github.com:org/my-repo.git",
    default_branch: "main",
    max_worktrees: 2,
    clean_mode: "light",
    ...overrides,
  };
}

describe("WorktreePool", () => {
  beforeEach(() => {
    // Re-init pool for each test with a clean workspace root
    // Access the private slots map to reset state between tests
    // biome-ignore lint/suspicious/noExplicitAny: test mock type
    (worktreePool as any).slots = new Map();
    worktreePool.init("/tmp/test-workspace");

    // Default: existsSync returns true (worktree dir exists), readdirSync returns empty
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.mocked(execSync).mockImplementation(() => "");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("acquire", () => {
    it("creates a new slot when pool is empty", () => {
      const repo = makeRepo({ max_worktrees: 2 });
      const slot = worktreePool.acquire(repo, "/tmp/clones/my-repo", "task-1", "sos/fix-bug");

      expect(slot).not.toBeNull();
      expect(slot?.slotName as string).toBe("my-repo-n-1");
      expect(slot?.slotIndex).toBe(1);
      expect(slot?.repoId).toBe("my-repo");
      expect(slot?.worktreePath).toContain("worktrees/my-repo-n-1");
    });

    it("creates a second slot when first is in use", () => {
      const repo = makeRepo({ max_worktrees: 2 });
      worktreePool.acquire(repo, "/tmp/clones/my-repo", "task-1", "sos/branch-1");
      const slot2 = worktreePool.acquire(repo, "/tmp/clones/my-repo", "task-2", "sos/branch-2");

      expect(slot2).not.toBeNull();
      expect(slot2?.slotName as string).toBe("my-repo-n-2");
      expect(slot2?.slotIndex).toBe(2);
    });

    it("returns null when all slots are occupied and at max", () => {
      const repo = makeRepo({ max_worktrees: 1 });
      worktreePool.acquire(repo, "/tmp/clones/my-repo", "task-1", "sos/branch-1");
      const slot2 = worktreePool.acquire(repo, "/tmp/clones/my-repo", "task-2", "sos/branch-2");

      expect(slot2).toBeNull();
    });

    it("reuses a released slot", () => {
      const repo = makeRepo({ max_worktrees: 1 });
      const slot1 = worktreePool.acquire(repo, "/tmp/clones/my-repo", "task-1", "sos/branch-1");
      expect(slot1).not.toBeNull();

      worktreePool.release("my-repo", slot1?.slotName as string);

      const slot2 = worktreePool.acquire(repo, "/tmp/clones/my-repo", "task-2", "sos/branch-2");
      expect(slot2).not.toBeNull();
      expect(slot2?.slotName as string).toBe(slot1?.slotName as string); // same slot reused
    });
  });

  describe("release", () => {
    it("marks a slot as available", () => {
      const repo = makeRepo({ max_worktrees: 1 });
      const slot = worktreePool.acquire(repo, "/tmp/clones/my-repo", "task-1", "sos/branch-1");
      expect(worktreePool.isInUse("my-repo", slot?.slotName as string)).toBe(true);

      worktreePool.release("my-repo", slot?.slotName as string);
      expect(worktreePool.isInUse("my-repo", slot?.slotName as string)).toBe(false);
    });

    it("is a no-op for unknown repo", () => {
      // Should not throw
      worktreePool.release("nonexistent", "fake-slot");
    });

    it("parks worktree on base branch and deletes feature branch", () => {
      const repo = makeRepo({ max_worktrees: 1 });
      const slot = worktreePool.acquire(repo, "/tmp/clones/my-repo", "task-1", "sos/branch-1");
      expect(slot).not.toBeNull();

      vi.mocked(execSync).mockClear();
      worktreePool.release("my-repo", slot?.slotName as string);

      const calls = vi.mocked(execSync).mock.calls.map((c) => c[0]);
      // Should fetch origin main
      expect(calls.some((c) => (c as string).includes("git fetch origin main"))).toBe(true);
      // Should checkout base branch
      expect(
        calls.some((c) => (c as string).includes("checkout -B worktree/my-repo-n-1-base")),
      ).toBe(true);
      // Should delete the feature branch
      expect(calls.some((c) => (c as string).includes("branch -D sos/branch-1"))).toBe(true);
    });

    it("does not throw if park fails", () => {
      const repo = makeRepo({ max_worktrees: 1 });
      const slot = worktreePool.acquire(repo, "/tmp/clones/my-repo", "task-1", "sos/branch-1");
      expect(slot).not.toBeNull();

      // Make git commands fail during release
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error("git failed");
      });

      // Should not throw — park is best-effort
      expect(() => worktreePool.release("my-repo", slot?.slotName as string)).not.toThrow();
      expect(worktreePool.isInUse("my-repo", slot?.slotName as string)).toBe(false);
    });
  });

  describe("isInUse", () => {
    it("returns false for unknown repo", () => {
      expect(worktreePool.isInUse("unknown", "slot")).toBe(false);
    });

    it("returns correct state after acquire and release", () => {
      const repo = makeRepo();
      const slot = worktreePool.acquire(repo, "/tmp/clones/my-repo", "task-1", "sos/branch-1");

      expect(worktreePool.isInUse("my-repo", slot?.slotName as string)).toBe(true);
      worktreePool.release("my-repo", slot?.slotName as string);
      expect(worktreePool.isInUse("my-repo", slot?.slotName as string)).toBe(false);
    });
  });

  describe("discovery of existing worktrees", () => {
    it("picks up existing worktree directories on first access", () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock type
      vi.mocked(readdirSync).mockReturnValue(["my-repo-n-1" as any, "my-repo-n-2" as any]);

      const repo = makeRepo({ max_worktrees: 3 });
      // First acquire should discover the 2 existing slots, reuse one
      const slot = worktreePool.acquire(repo, "/tmp/clones/my-repo", "task-1", "sos/branch-1");

      expect(slot).not.toBeNull();
      expect(slot?.slotName as string).toBe("my-repo-n-1"); // reuses first discovered
    });

    it("respects max_worktrees even with discovered slots", () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock type
      vi.mocked(readdirSync).mockReturnValue(["my-repo-n-1" as any, "my-repo-n-2" as any]);

      const repo = makeRepo({ max_worktrees: 2 });
      // Acquire both discovered slots
      worktreePool.acquire(repo, "/tmp/clones/my-repo", "task-1", "sos/b1");
      worktreePool.acquire(repo, "/tmp/clones/my-repo", "task-2", "sos/b2");

      // Third should return null — at max
      const slot3 = worktreePool.acquire(repo, "/tmp/clones/my-repo", "task-3", "sos/b3");
      expect(slot3).toBeNull();
    });
  });

  describe("independent repo pools", () => {
    it("manages slots independently per repo", () => {
      const repo1 = makeRepo({ id: "repo-a", max_worktrees: 1 });
      const repo2 = makeRepo({ id: "repo-b", max_worktrees: 1 });

      const slot1 = worktreePool.acquire(repo1, "/tmp/clones/repo-a", "t1", "sos/b1");
      const slot2 = worktreePool.acquire(repo2, "/tmp/clones/repo-b", "t2", "sos/b2");

      expect(slot1).not.toBeNull();
      expect(slot2).not.toBeNull();
      expect(slot1?.repoId).toBe("repo-a");
      expect(slot2?.repoId).toBe("repo-b");
    });
  });

  describe("file-based locking", () => {
    it("denies acquire when lockfile held by a live process", () => {
      // Discover one existing slot on disk
      // biome-ignore lint/suspicious/noExplicitAny: test mock type
      vi.mocked(readdirSync).mockReturnValue(["my-repo-n-1" as any]);

      // Simulate a lockfile from another live process (use our own PID + 1 won't work
      // reliably, so we simulate by returning a lock with current PID but we'll
      // test the "another process" path by using a known-alive PID: PID 1 (launchd/init))
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ pid: 1, taskId: "other-task", acquiredAt: new Date().toISOString() }),
      );

      const repo = makeRepo({ max_worktrees: 1 });
      const slot = worktreePool.acquire(repo, "/tmp/clones/my-repo", "task-1", "sos/b1");

      // PID 1 is always alive, so the slot should be denied
      expect(slot).toBeNull();
    });

    it("reclaims slot when lockfile held by a dead process", () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock type
      vi.mocked(readdirSync).mockReturnValue(["my-repo-n-1" as any]);

      // Use a PID that is almost certainly dead (very high number)
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          pid: 999999999,
          taskId: "dead-task",
          acquiredAt: new Date().toISOString(),
        }),
      );

      const repo = makeRepo({ max_worktrees: 1 });
      const slot = worktreePool.acquire(repo, "/tmp/clones/my-repo", "task-1", "sos/b1");

      // Dead PID → stale lock removed → slot available
      expect(slot).not.toBeNull();
      expect(slot?.slotName as string).toBe("my-repo-n-1");
    });

    it("allows acquire when lockfile is from our own process", () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock type
      vi.mocked(readdirSync).mockReturnValue(["my-repo-n-1" as any]);

      // Lockfile from our own PID — should trust in-memory state (which is free)
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          pid: process.pid,
          taskId: "old-task",
          acquiredAt: new Date().toISOString(),
        }),
      );

      const repo = makeRepo({ max_worktrees: 1 });
      const slot = worktreePool.acquire(repo, "/tmp/clones/my-repo", "task-1", "sos/b1");

      expect(slot).not.toBeNull();
      expect(slot?.slotName as string).toBe("my-repo-n-1");
    });
  });
});
