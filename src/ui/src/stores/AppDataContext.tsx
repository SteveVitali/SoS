import type React from "react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  fetchPrStats,
  getIdentity,
  getRegistry,
  getUsers,
  getWorktreeStatus,
  type Job,
  listJobs,
  listWorkerNodes,
  type PrCommentStats,
  type RegistryData,
  type WorkerInfo,
  type WorktreeSlotStatus,
} from "../api.js";

// --- Types ---

interface JobsFilter {
  status?: string;
  requested_by?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

interface JobsState {
  jobs: Job[];
  total: number;
  users: string[];
  loading: boolean;
  error: string;
  prStats: Record<string, PrCommentStats>;
  lastRefreshedAt: number | null;
}

interface RegistryState {
  registry: RegistryData | null;
  path: string;
  loading: boolean;
  error: string;
}

interface WorkerNodesState {
  workers: WorkerInfo[];
  loading: boolean;
  error: string;
  lastRefreshedAt: number | null;
}

interface AppDataContextValue {
  jobs: JobsState;
  registry: RegistryState;
  worktrees: Record<string, WorktreeSlotStatus[]>;
  workerNodes: WorkerNodesState;
  jobOwner: string;
  refreshJobs: (filter?: JobsFilter) => Promise<void>;
  refreshRegistry: () => Promise<void>;
  refreshWorktrees: () => Promise<void>;
  refreshWorkerNodes: () => Promise<void>;
  setRegistryLocal: (data: RegistryData) => void;
}

const AppDataContext = createContext<AppDataContextValue | null>(null);

export function useAppData(): AppDataContextValue {
  const ctx = useContext(AppDataContext);
  if (!ctx) throw new Error("useAppData must be used within AppDataProvider");
  return ctx;
}

// --- Provider ---

export function AppDataProvider({ children }: { children: React.ReactNode }) {
  // --- Jobs ---
  const [jobsState, setJobsState] = useState<JobsState>({
    jobs: [],
    total: 0,
    users: [],
    loading: true,
    error: "",
    prStats: {},
    lastRefreshedAt: null,
  });
  const lastJobsFilter = useRef<JobsFilter>({ limit: 25, offset: 0 });

  const refreshJobs = useCallback(async (filter?: JobsFilter) => {
    if (filter) lastJobsFilter.current = filter;
    const f = lastJobsFilter.current;
    setJobsState((prev) => ({ ...prev, loading: prev.jobs.length === 0, error: "" }));
    try {
      const [jobsRes, usersRes] = await Promise.all([
        listJobs({
          status: f.status || undefined,
          requested_by: f.requested_by || undefined,
          q: f.q || undefined,
          limit: f.limit ?? 25,
          offset: f.offset ?? 0,
        }),
        getUsers(),
      ]);
      // Preserve existing prStats — they're refreshed on a slower cadence below
      setJobsState((prev) => ({
        jobs: jobsRes.jobs,
        total: jobsRes.total,
        users: usersRes.users,
        loading: false,
        error: "",
        prStats: prev.prStats,
        lastRefreshedAt: Date.now(),
      }));
    } catch (err: unknown) {
      setJobsState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? (err as Error).message : String(err),
      }));
    }
  }, []);

  // Separate PR stats refresh on a slow cadence (avoids GitHub API rate limits)
  const refreshJobPrStats = useCallback(async () => {
    setJobsState((prev) => {
      const urls = [...new Set(prev.jobs.flatMap((j: Job) => j.pr_urls || []))];
      if (urls.length === 0) return prev;
      // Fire-and-forget: fetch stats and update when ready
      fetchPrStats(urls)
        .then((prStats) => setJobsState((s) => ({ ...s, prStats })))
        .catch(() => {});
      return prev;
    });
  }, []);

  // --- Registry ---
  const [registryState, setRegistryState] = useState<RegistryState>({
    registry: null,
    path: "",
    loading: true,
    error: "",
  });

  const refreshRegistry = useCallback(async () => {
    setRegistryState((prev) => ({ ...prev, loading: prev.registry === null, error: "" }));
    try {
      const res = await getRegistry();
      setRegistryState({ registry: res.registry, path: res.path, loading: false, error: "" });
    } catch (err: unknown) {
      setRegistryState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? (err as Error).message : String(err),
      }));
    }
  }, []);

  const setRegistryLocal = useCallback((data: RegistryData) => {
    setRegistryState((prev) => ({ ...prev, registry: data }));
  }, []);

  // --- Worker Nodes ---
  const [workerNodesState, setWorkerNodesState] = useState<WorkerNodesState>({
    workers: [],
    loading: true,
    error: "",
    lastRefreshedAt: null,
  });

  const refreshWorkerNodes = useCallback(async () => {
    try {
      const res = await listWorkerNodes();
      setWorkerNodesState({
        workers: res.workers,
        loading: false,
        error: "",
        lastRefreshedAt: Date.now(),
      });
    } catch (err: unknown) {
      setWorkerNodesState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? (err as Error).message : String(err),
      }));
    }
  }, []);

  // --- Identity ---
  const [jobOwner, setJobOwner] = useState("");

  // --- Worktrees ---
  const [worktrees, setWorktrees] = useState<Record<string, WorktreeSlotStatus[]>>({});

  const refreshWorktrees = useCallback(async () => {
    try {
      const res = await getWorktreeStatus();
      setWorktrees(res);
    } catch {
      // non-critical
    }
  }, []);

  // --- Initial parallel fetch (once) ---
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    refreshJobs();
    refreshRegistry();
    refreshWorktrees();
    refreshWorkerNodes();
    // Fetch PR stats after a short delay so jobs have loaded first
    setTimeout(() => refreshJobPrStats(), 2_000);
    getIdentity()
      .then((res) => setJobOwner(res.jobOwner))
      .catch(() => {});
  }, [refreshJobs, refreshRegistry, refreshWorktrees, refreshWorkerNodes, refreshJobPrStats]);

  // --- Polling: refresh jobs every 3s, worktrees every 5s, PRs + PR stats every 120s ---
  useEffect(() => {
    const jobsTimer = setInterval(() => refreshJobs(), 3_000);
    const worktreeTimer = setInterval(() => refreshWorktrees(), 5_000);
    const workerNodesTimer = setInterval(() => refreshWorkerNodes(), 5_000);
    const prStatsTimer = setInterval(() => refreshJobPrStats(), 600_000);
    return () => {
      clearInterval(jobsTimer);
      clearInterval(worktreeTimer);
      clearInterval(workerNodesTimer);
      clearInterval(prStatsTimer);
    };
  }, [refreshJobs, refreshWorktrees, refreshWorkerNodes, refreshJobPrStats]);

  const value: AppDataContextValue = {
    jobs: jobsState,
    registry: registryState,
    worktrees,
    workerNodes: workerNodesState,
    jobOwner,
    refreshJobs,
    refreshRegistry,
    refreshWorktrees,
    refreshWorkerNodes,
    setRegistryLocal,
  };

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}
