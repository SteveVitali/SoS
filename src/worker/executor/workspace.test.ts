import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}));

vi.mock("./repoLock.js", () => ({
  // biome-ignore lint/suspicious/noExplicitAny: test mock type
  withRepoLock: vi.fn(async (_repoId: string, fn: () => any) => fn()),
}));

const { ensureClone } = await import("./workspace.js");
const { existsSync } = await import("node:fs");
const { execSync } = await import("node:child_process");
const { withRepoLock } = await import("./repoLock.js");

describe("ensureClone", () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(execSync).mockImplementation(() => "");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("clones when directory does not exist", async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const repo = {
      id: "my-repo",
      clone: "git@github.com:org/my-repo.git",
      default_branch: "main",
      max_worktrees: 2,
      clean_mode: "light" as const,
    };
    const result = await ensureClone("/workspace", repo);

    expect(result).toBe("/workspace/clones/my-repo");
    const calls = vi.mocked(execSync).mock.calls.map((c) => c[0]);
    expect(calls.some((c) => (c as string).includes("git clone"))).toBe(true);
  });

  it("fetches when directory already exists", async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const repo = {
      id: "my-repo",
      clone: "git@github.com:org/my-repo.git",
      default_branch: "main",
      max_worktrees: 2,
      clean_mode: "light" as const,
    };
    const result = await ensureClone("/workspace", repo);

    expect(result).toBe("/workspace/clones/my-repo");
    const calls = vi.mocked(execSync).mock.calls.map((c) => c[0]);
    expect(calls.some((c) => (c as string).includes("git fetch origin"))).toBe(true);
    expect(calls.some((c) => (c as string).includes("git clone"))).toBe(false);
  });

  it("wraps operations in withRepoLock", async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const repo = {
      id: "my-repo",
      clone: "git@github.com:org/my-repo.git",
      default_branch: "main",
      max_worktrees: 2,
      clean_mode: "light" as const,
    };
    await ensureClone("/workspace", repo);

    expect(withRepoLock).toHaveBeenCalledWith("my-repo", expect.any(Function));
  });

  it("returns clone dir even if fetch throws (lock released)", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("fetch failed");
    });

    const repo = {
      id: "my-repo",
      clone: "git@github.com:org/my-repo.git",
      default_branch: "main",
      max_worktrees: 2,
      clean_mode: "light" as const,
    };
    await expect(ensureClone("/workspace", repo)).rejects.toThrow("fetch failed");
  });
});
