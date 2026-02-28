import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createLogger } from "../../shared/logger.js";
import type { RepoEntry } from "./repoRegistry.js";

const LOCKFILE_NAME = ".sos-lock";

interface LockInfo {
  pid: number;
  taskId: string;
  acquiredAt: string;
}

/** Check whether a process with the given PID is still running. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, no actual signal sent
    return true;
  } catch (err: unknown) {
    // EPERM = process exists but we lack permission to signal it → still alive
    if ((err as { code?: string }).code === "EPERM") return true;
    // ESRCH = no such process → dead
    return false;
  }
}

function readLockfile(worktreePath: string): LockInfo | null {
  const lockPath = path.join(worktreePath, LOCKFILE_NAME);
  if (!existsSync(lockPath)) return null;
  try {
    return JSON.parse(readFileSync(lockPath, "utf-8")) as LockInfo;
  } catch {
    return null;
  }
}

function writeLockfile(worktreePath: string, taskId: string): void {
  const lockPath = path.join(worktreePath, LOCKFILE_NAME);
  const info: LockInfo = { pid: process.pid, taskId, acquiredAt: new Date().toISOString() };
  writeFileSync(lockPath, JSON.stringify(info), "utf-8");
}

function removeLockfile(worktreePath: string): void {
  const lockPath = path.join(worktreePath, LOCKFILE_NAME);
  try {
    unlinkSync(lockPath);
  } catch {
    /* may not exist */
  }
}

const log = createLogger("worker:worktreePool");

/** Canonical local branch name for a worktree slot at rest. Never pushed to remote. */
function baseBranchName(slotName: string): string {
  return `worktree/${slotName}-base`;
}

export interface WorktreeSlot {
  slotName: string; // e.g. "son-of-steve-n-1"
  slotIndex: number; // 1-based
  worktreePath: string; // absolute path on disk
  repoId: string;
}

interface SlotState {
  slot: WorktreeSlot;
  inUse: boolean;
  taskId?: string;
  /** Repo entry — set on acquire, used by release for cleanup. */
  repo?: RepoEntry;
  /** Path to the bare clone — set on acquire, used by release for fetch. */
  clonePath?: string;
  /** The feature branch checked out during the job — deleted on release. */
  currentBranch?: string;
}

/**
 * In-process worktree pool. Manages a fixed set of reusable worktree
 * slots per repo. All workers in this Node.js process share the pool.
 */
class WorktreePoolImpl {
  // repoId -> slot states
  private slots = new Map<string, SlotState[]>();
  private workspaceRoot = "";

  init(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    log.info("WorktreePool initialized", { workspaceRoot });
  }

  /**
   * Try to acquire a worktree slot for the given repo.
   * Returns the slot info or null if all slots are occupied and max is reached.
   */
  acquire(repo: RepoEntry, clonePath: string, taskId: string, branch: string): WorktreeSlot | null {
    const states = this.getOrCreateStates(repo, clonePath);

    // Reconcile in-memory state with on-disk lockfiles (handles restarts / multi-process)
    this.reconcileLocks(states);

    // 1) Find a free existing slot
    for (const state of states) {
      if (!state.inUse) {
        state.inUse = true;
        state.taskId = taskId;
        log.info("Acquired existing worktree slot", {
          slot: state.slot.slotName,
          taskId,
        });
        this.resetWorktree(state.slot, repo, clonePath, branch);
        state.repo = repo;
        state.clonePath = clonePath;
        state.currentBranch = branch;
        writeLockfile(state.slot.worktreePath, taskId);
        return state.slot;
      }
    }

    // 2) All occupied — can we create a new one?
    if (states.length < repo.max_worktrees) {
      const slotIndex = states.length + 1;
      const slot = this.createSlot(repo, clonePath, slotIndex, branch);
      writeLockfile(slot.worktreePath, taskId);
      const state: SlotState = {
        slot,
        inUse: true,
        taskId,
        repo,
        clonePath,
        currentBranch: branch,
      };
      states.push(state);
      log.info("Created new worktree slot", {
        slot: slot.slotName,
        taskId,
        total: states.length,
        max: repo.max_worktrees,
      });
      return slot;
    }

    // 3) All occupied and at max
    log.info("No worktree slots available", {
      repoId: repo.id,
      inUse: states.filter((s) => s.inUse).length,
      max: repo.max_worktrees,
      taskId,
    });
    return null;
  }

  /**
   * Acquire a slot and check out an existing remote branch (e.g. for respond_to_pr_comments).
   * Unlike acquire(), this does NOT create a new branch — it checks out an existing one.
   */
  acquireExistingBranch(
    repo: RepoEntry,
    clonePath: string,
    taskId: string,
    remoteBranch: string,
  ): WorktreeSlot | null {
    const states = this.getOrCreateStates(repo, clonePath);
    this.reconcileLocks(states);

    // Find a free slot
    for (const state of states) {
      if (!state.inUse) {
        state.inUse = true;
        state.taskId = taskId;
        log.info("Acquired existing worktree slot for existing branch", {
          slot: state.slot.slotName,
          taskId,
          branch: remoteBranch,
        });
        this.resetWorktreeToRemoteBranch(state.slot, repo, clonePath, remoteBranch);
        state.repo = repo;
        state.clonePath = clonePath;
        state.currentBranch = remoteBranch;
        writeLockfile(state.slot.worktreePath, taskId);
        return state.slot;
      }
    }

    // Create new slot if room
    if (states.length < repo.max_worktrees) {
      const slotIndex = states.length + 1;
      const slot = this.createSlotForExistingBranch(repo, clonePath, slotIndex, remoteBranch);
      writeLockfile(slot.worktreePath, taskId);
      const state: SlotState = {
        slot,
        inUse: true,
        taskId,
        repo,
        clonePath,
        currentBranch: remoteBranch,
      };
      states.push(state);
      log.info("Created new worktree slot for existing branch", {
        slot: slot.slotName,
        taskId,
        branch: remoteBranch,
      });
      return slot;
    }

    log.info("No worktree slots available", {
      repoId: repo.id,
      inUse: states.filter((s) => s.inUse).length,
      max: repo.max_worktrees,
      taskId,
    });
    return null;
  }

  /**
   * Release a worktree slot back to the pool.
   * Parks the worktree on its base branch with latest main so the feature
   * branch is freed for checkout from other repos.
   */
  release(repoId: string, slotName: string): void {
    const states = this.slots.get(repoId);
    if (!states) return;
    const state = states.find((s) => s.slot.slotName === slotName);
    if (!state) return;

    log.info("Releasing worktree slot", {
      slot: slotName,
      taskId: state.taskId,
    });
    removeLockfile(state.slot.worktreePath);

    // Best-effort: park the worktree on its base branch with latest main
    if (state.repo && state.clonePath) {
      try {
        this.parkOnBaseBranch(state.slot, state.repo, state.clonePath, state.currentBranch);
      } catch (err: unknown) {
        log.warn("Failed to park worktree on base branch during release", {
          slot: slotName,
          error: (err as Error).message,
        });
      }
    }

    state.inUse = false;
    state.taskId = undefined;
    state.currentBranch = undefined;
  }

  /**
   * Check if a specific slot is in use (for diagnostics).
   */
  isInUse(repoId: string, slotName: string): boolean {
    const states = this.slots.get(repoId);
    if (!states) return false;
    return states.find((s) => s.slot.slotName === slotName)?.inUse ?? false;
  }

  // --- Internal ---

  /**
   * Reconcile in-memory slot states with on-disk lockfiles.
   * Handles cases where another process holds a slot (lockfile exists, PID alive)
   * or a previous process crashed (lockfile exists, PID dead → stale, clean up).
   */
  private reconcileLocks(states: SlotState[]): void {
    for (const state of states) {
      const lock = readLockfile(state.slot.worktreePath);
      if (lock) {
        if (lock.pid === process.pid) {
          // Our own lock — trust in-memory state
          continue;
        }
        if (isProcessAlive(lock.pid)) {
          // Another live process holds this slot
          if (!state.inUse) {
            log.warn("Slot locked by another process, marking in-use", {
              slot: state.slot.slotName,
              lockPid: lock.pid,
              lockTaskId: lock.taskId,
            });
            state.inUse = true;
            state.taskId = lock.taskId;
          }
        } else {
          // Stale lockfile from a dead process — clean up
          log.warn("Removing stale lockfile from dead process", {
            slot: state.slot.slotName,
            stalePid: lock.pid,
            staleTaskId: lock.taskId,
          });
          removeLockfile(state.slot.worktreePath);
          state.inUse = false;
          state.taskId = undefined;
        }
      } else if (state.inUse && state.taskId) {
        // In-memory says in-use but no lockfile — could mean the slot was released
        // externally or the lockfile was manually removed. Trust the absence.
        // (This branch is mostly a safety net; normal release removes both.)
      }
    }
  }

  private getOrCreateStates(repo: RepoEntry, _clonePath: string): SlotState[] {
    let states = this.slots.get(repo.id);
    if (states) return states;

    // Discover existing worktree directories on disk
    states = [];
    const worktreeDir = path.join(this.workspaceRoot, "worktrees");
    if (existsSync(worktreeDir)) {
      const prefix = `${repo.id}-n-`;
      const entries = readdirSync(worktreeDir).filter((e) => e.startsWith(prefix));
      entries.sort(); // ensure deterministic order
      for (const entry of entries) {
        const idxStr = entry.slice(prefix.length);
        const idx = parseInt(idxStr, 10);
        if (!Number.isNaN(idx)) {
          const worktreePath = path.join(worktreeDir, entry);
          states.push({
            slot: {
              slotName: entry,
              slotIndex: idx,
              worktreePath,
              repoId: repo.id,
            },
            inUse: false,
          });
        }
      }
    }
    this.slots.set(repo.id, states);
    log.info("Discovered existing worktree slots", {
      repoId: repo.id,
      count: states.length,
    });
    return states;
  }

  private createSlot(
    repo: RepoEntry,
    clonePath: string,
    slotIndex: number,
    branch: string,
  ): WorktreeSlot {
    const slotName = `${repo.id}-n-${slotIndex}`;
    const worktreePath = path.join(this.workspaceRoot, "worktrees", slotName);
    const base = baseBranchName(slotName);

    mkdirSync(path.dirname(worktreePath), { recursive: true });

    // Prune stale worktree references before adding
    this.gitExec("git worktree prune", clonePath);

    log.info("Creating worktree slot", { slotName, worktreePath, branch, baseBranch: base });
    this.gitExec(
      `git worktree add ${worktreePath} -b ${base} origin/${repo.default_branch}`,
      clonePath,
    );

    // Create the feature branch from the base
    this.gitExec(`git checkout -b ${branch}`, worktreePath);

    return { slotName, slotIndex, worktreePath, repoId: repo.id };
  }

  private createSlotForExistingBranch(
    repo: RepoEntry,
    clonePath: string,
    slotIndex: number,
    remoteBranch: string,
  ): WorktreeSlot {
    const slotName = `${repo.id}-n-${slotIndex}`;
    const worktreePath = path.join(this.workspaceRoot, "worktrees", slotName);
    const base = baseBranchName(slotName);

    mkdirSync(path.dirname(worktreePath), { recursive: true });
    if (existsSync(worktreePath)) {
      log.info("Removing stale worktree directory", { worktreePath });
      rmSync(worktreePath, { recursive: true, force: true });
    }
    this.gitExec("git worktree prune", clonePath);

    // Fetch the remote branch
    this.gitExec(`git fetch origin ${remoteBranch}`, clonePath);
    log.info("Creating worktree slot for existing branch", {
      slotName,
      worktreePath,
      remoteBranch,
      baseBranch: base,
    });

    // Create worktree on base branch, then checkout the remote branch
    this.gitExec(
      `git worktree add ${worktreePath} -b ${base} origin/${repo.default_branch}`,
      clonePath,
    );
    this.gitExec(`git checkout -B ${remoteBranch} origin/${remoteBranch}`, worktreePath);

    return { slotName, slotIndex, worktreePath, repoId: repo.id };
  }

  private resetWorktreeToRemoteBranch(
    slot: WorktreeSlot,
    repo: RepoEntry,
    clonePath: string,
    remoteBranch: string,
  ): void {
    const { worktreePath } = slot;
    const base = baseBranchName(slot.slotName);

    // Fetch the remote branch and default branch
    this.gitExec(`git fetch origin ${remoteBranch} ${repo.default_branch}`, clonePath);

    if (!existsSync(worktreePath)) {
      log.info("Worktree dir missing, recreating for existing branch", { slot: slot.slotName });
      this.gitExec("git worktree prune", clonePath);
      mkdirSync(path.dirname(worktreePath), { recursive: true });
      this.gitExec(
        `git worktree add ${worktreePath} -b ${base} origin/${repo.default_branch}`,
        clonePath,
      );
      this.gitExec(`git checkout -B ${remoteBranch} origin/${remoteBranch}`, worktreePath);
      return;
    }

    log.info("Resetting worktree to existing remote branch", {
      slot: slot.slotName,
      branch: remoteBranch,
    });

    this.gitExec("git reset --hard HEAD", worktreePath);

    // Ensure base branch exists and is up to date
    this.gitExec(`git checkout -B ${base} origin/${repo.default_branch}`, worktreePath);

    if (repo.clean_mode === "full") {
      this.gitExec("git clean -fdx", worktreePath);
    } else {
      this.gitExec("git clean -fd", worktreePath);
    }

    // Check out the existing remote branch
    try {
      this.gitExec(`git branch -D ${remoteBranch}`, worktreePath);
    } catch {
      /* branch may not exist locally */
    }
    this.gitExec(`git checkout -b ${remoteBranch} origin/${remoteBranch}`, worktreePath);
  }

  private resetWorktree(
    slot: WorktreeSlot,
    repo: RepoEntry,
    clonePath: string,
    branch: string,
  ): void {
    const { worktreePath } = slot;
    const base = baseBranchName(slot.slotName);

    // Fetch latest default branch
    this.gitExec(`git fetch origin ${repo.default_branch}`, clonePath);

    if (!existsSync(worktreePath)) {
      log.info("Worktree dir missing, recreating", { slot: slot.slotName });
      this.gitExec("git worktree prune", clonePath);
      mkdirSync(path.dirname(worktreePath), { recursive: true });
      this.gitExec(
        `git worktree add ${worktreePath} -b ${base} origin/${repo.default_branch}`,
        clonePath,
      );
      this.gitExec(`git checkout -b ${branch}`, worktreePath);
      return;
    }

    log.info("Resetting worktree slot", { slot: slot.slotName, branch });

    // Reset first to clear modified tracked files (e.g. package-lock.json from npm install)
    this.gitExec("git reset --hard HEAD", worktreePath);

    // Ensure base branch exists and is up to date with latest main
    this.gitExec(`git checkout -B ${base} origin/${repo.default_branch}`, worktreePath);

    // Clean working tree
    if (repo.clean_mode === "full") {
      this.gitExec("git clean -fdx", worktreePath);
    } else {
      this.gitExec("git clean -fd", worktreePath);
    }

    // Delete old local branch if it exists, then create fresh feature branch
    try {
      this.gitExec(`git branch -D ${branch}`, worktreePath);
    } catch {
      /* branch may not exist */
    }

    this.gitExec(`git checkout -b ${branch}`, worktreePath);
  }

  /**
   * Park the worktree on its base branch with latest main.
   * Deletes the feature branch so it can be checked out from other repos.
   */
  private parkOnBaseBranch(
    slot: WorktreeSlot,
    repo: RepoEntry,
    clonePath: string,
    featureBranch?: string,
  ): void {
    const { worktreePath } = slot;
    if (!existsSync(worktreePath)) return;

    const base = baseBranchName(slot.slotName);

    // Fetch latest default branch
    this.gitExec(`git fetch origin ${repo.default_branch}`, clonePath);

    // Clean working tree
    this.gitExec("git reset --hard HEAD", worktreePath);
    if (repo.clean_mode === "full") {
      this.gitExec("git clean -fdx", worktreePath);
    } else {
      this.gitExec("git clean -fd", worktreePath);
    }

    // Checkout base branch (create if needed), reset to latest main
    this.gitExec(`git checkout -B ${base} origin/${repo.default_branch}`, worktreePath);

    // Delete the feature branch so it can be checked out from the main repo
    if (featureBranch) {
      try {
        this.gitExec(`git branch -D ${featureBranch}`, worktreePath);
      } catch {
        /* branch may not exist locally */
      }
    }

    log.info("Parked worktree on base branch", {
      slot: slot.slotName,
      baseBranch: base,
      deletedBranch: featureBranch,
    });
  }

  private gitExec(cmd: string, cwd: string): string {
    log.info("exec", { cmd, cwd });
    return execSync(cmd, { cwd, encoding: "utf-8", timeout: 120_000 }).trim();
  }
}

// Singleton instance shared across all worker loops in this process
export const worktreePool = new WorktreePoolImpl();
