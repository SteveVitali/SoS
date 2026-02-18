import { execSync } from "child_process";
import { existsSync, mkdirSync, readdirSync } from "fs";
import path from "path";
import { createLogger } from "../../shared/logger.js";
import type { RepoEntry } from "./repoRegistry.js";

const log = createLogger("worker:worktreePool");

export interface WorktreeSlot {
  slotName: string;      // e.g. "fsq-graph-n-1"
  slotIndex: number;     // 1-based
  worktreePath: string;  // absolute path on disk
  repoId: string;
}

interface SlotState {
  slot: WorktreeSlot;
  inUse: boolean;         // true when a job is actively using it
  taskId?: string;        // which task_id currently holds the slot
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
  acquire(
    repo: RepoEntry,
    clonePath: string,
    taskId: string,
    branch: string
  ): WorktreeSlot | null {
    const states = this.getOrCreateStates(repo, clonePath);

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
        return state.slot;
      }
    }

    // 2) All occupied — can we create a new one?
    if (states.length < repo.max_worktrees) {
      const slotIndex = states.length + 1;
      const slot = this.createSlot(repo, clonePath, slotIndex, branch);
      const state: SlotState = { slot, inUse: true, taskId };
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
   * Release a worktree slot back to the pool.
   */
  release(repoId: string, slotName: string): void {
    const states = this.slots.get(repoId);
    if (!states) return;
    const state = states.find((s) => s.slot.slotName === slotName);
    if (state) {
      log.info("Released worktree slot", {
        slot: slotName,
        taskId: state.taskId,
      });
      state.inUse = false;
      state.taskId = undefined;
    }
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

  private getOrCreateStates(repo: RepoEntry, clonePath: string): SlotState[] {
    let states = this.slots.get(repo.id);
    if (states) return states;

    // Discover existing worktree directories on disk
    states = [];
    const worktreeDir = path.join(this.workspaceRoot, "worktrees");
    if (existsSync(worktreeDir)) {
      const prefix = `${repo.id}-n-`;
      const entries = readdirSync(worktreeDir).filter(
        (e) => e.startsWith(prefix)
      );
      entries.sort(); // ensure deterministic order
      for (const entry of entries) {
        const idxStr = entry.slice(prefix.length);
        const idx = parseInt(idxStr, 10);
        if (!isNaN(idx)) {
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
    branch: string
  ): WorktreeSlot {
    const slotName = `${repo.id}-n-${slotIndex}`;
    const worktreePath = path.join(
      this.workspaceRoot,
      "worktrees",
      slotName
    );

    mkdirSync(path.dirname(worktreePath), { recursive: true });

    // Prune stale worktree references before adding
    this.gitExec("git worktree prune", clonePath);

    log.info("Creating worktree slot", { slotName, worktreePath, branch });
    this.gitExec(
      `git worktree add ${worktreePath} -b ${branch} origin/${repo.default_branch}`,
      clonePath
    );

    return { slotName, slotIndex, worktreePath, repoId: repo.id };
  }

  private resetWorktree(
    slot: WorktreeSlot,
    repo: RepoEntry,
    clonePath: string,
    branch: string
  ): void {
    const { worktreePath } = slot;

    if (!existsSync(worktreePath)) {
      // Worktree dir was removed — recreate it
      log.info("Worktree dir missing, recreating", { slot: slot.slotName });
      this.gitExec("git worktree prune", clonePath);
      mkdirSync(path.dirname(worktreePath), { recursive: true });
      this.gitExec(
        `git worktree add ${worktreePath} -b ${branch} origin/${repo.default_branch}`,
        clonePath
      );
      return;
    }

    log.info("Resetting worktree slot", { slot: slot.slotName, branch });

    // Detach HEAD and reset to remote default branch (clone was already fetched by ensureClone)
    this.gitExec(
      `git checkout origin/${repo.default_branch} --detach`,
      worktreePath
    );

    // Clean working tree
    if (repo.clean_mode === "full") {
      // Remove everything including .gitignore'd files (build caches etc.)
      this.gitExec("git clean -fdx", worktreePath);
    } else {
      // Light: only remove untracked files, keep .gitignore'd (build artifacts)
      this.gitExec("git clean -fd", worktreePath);
    }
    this.gitExec("git reset --hard HEAD", worktreePath);

    // Delete old local branch if it exists, then create fresh one
    try {
      this.gitExec(`git branch -D ${branch}`, worktreePath);
    } catch { /* branch may not exist */ }

    this.gitExec(`git checkout -b ${branch}`, worktreePath);
  }

  private gitExec(cmd: string, cwd: string): string {
    log.info("exec", { cmd, cwd });
    return execSync(cmd, { cwd, encoding: "utf-8", timeout: 120_000 }).trim();
  }
}

// Singleton instance shared across all worker loops in this process
export const worktreePool = new WorktreePoolImpl();
