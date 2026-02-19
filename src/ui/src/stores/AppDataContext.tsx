import type React from "react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  fetchPrStats,
  type GitHubPr,
  getIdentity,
  getRegistry,
  getUsers,
  getWorktreeStatus,
  type Job,
  listJobs,
  listPrs,
  type PrCommentStats,
  type RegistryData,
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

interface PrsFilter {
  state?: "open" | "closed" | "merged" | "all";
  limit?: number;
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

interface PrsState {
  prs: GitHubPr[];
  loading: boolean;
  error: string;
  lastRefreshedAt: number | null;
}

interface RegistryState {
  registry: RegistryData | null;
  path: string;
  loading: boolean;
  error: string;
}

interface AppDataContextValue {
  jobs: JobsState;
  prs: PrsState;
  registry: RegistryState;
  worktrees: Record<string, WorktreeSlotStatus[]>;
  jobOwner: string;
  refreshJobs: (filter?: JobsFilter) => Promise<void>;
  refreshPrs: (filter?: PrsFilter) => Promise<void>;
  refreshRegistry: () => Promise<void>;
  refreshWorktrees: () => Promise<void>;
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
      // Fetch PR stats in the background
      const urls = [...new Set(jobsRes.jobs.flatMap((j: Job) => j.pr_urls || []))];
      let prStats: Record<string, PrCommentStats> = {};
      if (urls.length > 0) {
        try {
          prStats = await fetchPrStats(urls);
        } catch {
          // non-critical
        }
      }
      setJobsState({
        jobs: jobsRes.jobs,
        total: jobsRes.total,
        users: usersRes.users,
        loading: false,
        error: "",
        prStats,
        lastRefreshedAt: Date.now(),
      });
    } catch (err: unknown) {
      setJobsState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, []);

  // --- PRs ---
  const [prsState, setPrsState] = useState<PrsState>({
    prs: [],
    loading: true,
    error: "",
    lastRefreshedAt: null,
  });
  const lastPrsFilter = useRef<PrsFilter>({ state: "open", limit: 20 });

  const refreshPrs = useCallback(async (filter?: PrsFilter) => {
    if (filter) lastPrsFilter.current = filter;
    const f = lastPrsFilter.current;
    setPrsState((prev) => ({ ...prev, loading: prev.prs.length === 0, error: "" }));
    try {
      const res = await listPrs({ state: f.state, limit: f.limit });
      setPrsState({ prs: res.prs, loading: false, error: "", lastRefreshedAt: Date.now() });
    } catch (err: unknown) {
      setPrsState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
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
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, []);

  const setRegistryLocal = useCallback((data: RegistryData) => {
    setRegistryState((prev) => ({ ...prev, registry: data }));
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
    refreshPrs();
    refreshRegistry();
    refreshWorktrees();
    getIdentity()
      .then((res) => setJobOwner(res.jobOwner))
      .catch(() => {});
  }, [refreshJobs, refreshPrs, refreshRegistry, refreshWorktrees]);

  // --- Polling: refresh jobs every 3s, worktrees every 5s, PRs every 120s ---
  useEffect(() => {
    const jobsTimer = setInterval(() => refreshJobs(), 3_000);
    const worktreeTimer = setInterval(() => refreshWorktrees(), 5_000);
    const prsTimer = setInterval(() => refreshPrs(), 120_000);
    return () => {
      clearInterval(jobsTimer);
      clearInterval(worktreeTimer);
      clearInterval(prsTimer);
    };
  }, [refreshJobs, refreshPrs, refreshWorktrees]);

  const value: AppDataContextValue = {
    jobs: jobsState,
    prs: prsState,
    registry: registryState,
    worktrees,
    jobOwner,
    refreshJobs,
    refreshPrs,
    refreshRegistry,
    refreshWorktrees,
    setRegistryLocal,
  };

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}
