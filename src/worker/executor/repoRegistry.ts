import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("worker:repoRegistry");

export type CleanMode = "light" | "full";

export type McpTransport = "stdio" | "http" | "sse";

export interface McpServerConfig {
  transport: McpTransport;
  /** stdio: command to run */
  command?: string;
  /** stdio: arguments for the command */
  args?: string[];
  /** stdio/http/sse: environment variables (values support ${VAR} interpolation) */
  env?: Record<string, string>;
  /** http/sse: server URL */
  url?: string;
  /** http/sse: additional headers (values support ${VAR} interpolation) */
  headers?: Record<string, string>;
  /** Optional subset of tools to expose (omit to expose all) */
  allowed_tools?: string[];
}

export interface RepoEntry {
  id: string;
  clone: string;
  default_branch: string;
  max_worktrees: number;
  clean_mode: CleanMode;
  detect?: { keywords?: string[] };
  commands?: {
    lint?: string[];
    test_fast?: string[];
    test_full?: string[];
  };
  pr?: {
    reviewers_default?: string[];
    draft_by_default?: boolean;
  };
  ci?: {
    provider?: string;
  };
  mcp_servers?: Record<string, McpServerConfig>;
}

export interface RepoRegistry {
  repos: Map<string, RepoEntry>;
  globalMcpServers?: Record<string, McpServerConfig>;
}

/** Match a GitHub owner/repo (e.g. "SteveVitali/son-of-steve") against a clone URL. */
function cloneUrlMatches(cloneUrl: string, owner: string, repo: string): boolean {
  // SSH: git@github.com:SteveVitali/son-of-steve.git
  // HTTPS: https://github.com/SteveVitali/son-of-steve.git
  const normalized = cloneUrl.replace(/\.git$/, "").toLowerCase();
  const needle = `${owner}/${repo}`.toLowerCase();
  return normalized.endsWith(needle);
}

/** Find a repo registry entry matching a GitHub PR URL's owner/repo. */
export function findRepoByGitHubUrl(
  registry: RepoRegistry,
  owner: string,
  repo: string,
): RepoEntry | null {
  for (const entry of registry.repos.values()) {
    if (cloneUrlMatches(entry.clone, owner, repo)) return entry;
  }
  // Fallback: try matching by repo ID (e.g. "son-of-steve")
  const byId = registry.repos.get(repo);
  if (byId) return byId;
  return null;
}

/** Replace ${VAR} placeholders with values from process.env. */
function interpolateEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName) => {
    const envVal = process.env[varName];
    if (envVal == null) {
      log.warn("MCP config references undefined env var", { var: varName });
      return "";
    }
    return envVal;
  });
}

/** Interpolate all string values in a Record. */
function interpolateRecord(rec: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    result[k] = interpolateEnv(v);
  }
  return result;
}

function parseMcpServers(raw: unknown): Record<string, McpServerConfig> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(raw as Record<string, any>)) {
    const transport: McpTransport =
      cfg.transport === "http" ? "http" : cfg.transport === "sse" ? "sse" : "stdio";
    const server: McpServerConfig = { transport };
    if (cfg.command) server.command = cfg.command;
    if (Array.isArray(cfg.args)) server.args = cfg.args;
    if (cfg.env && typeof cfg.env === "object") server.env = interpolateRecord(cfg.env);
    if (cfg.url) server.url = interpolateEnv(String(cfg.url));
    if (cfg.headers && typeof cfg.headers === "object")
      server.headers = interpolateRecord(cfg.headers);
    if (Array.isArray(cfg.allowed_tools)) server.allowed_tools = cfg.allowed_tools;
    servers[name] = server;
  }
  return Object.keys(servers).length > 0 ? servers : undefined;
}

/** Merge global MCP servers with repo-level overrides (repo wins by name). */
export function mergeMcpServers(
  global?: Record<string, McpServerConfig>,
  repoLevel?: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> | undefined {
  if (!global && !repoLevel) return undefined;
  const merged = { ...global, ...repoLevel };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function loadRegistry(path: string): RepoRegistry {
  try {
    const raw = readFileSync(path, "utf-8");
    const data = parseYaml(raw);
    const repos = new Map<string, RepoEntry>();
    const globalMcpServers = parseMcpServers(data?.mcp_servers);

    if (data?.repos) {
      for (const [id, entry] of Object.entries(data.repos)) {
        const e = entry as any;
        const repoMcp = parseMcpServers(e.mcp_servers);
        repos.set(id, {
          id,
          clone: e.clone,
          default_branch: e.default_branch || "main",
          max_worktrees: typeof e.max_worktrees === "number" ? e.max_worktrees : 1,
          clean_mode: e.clean_mode === "full" ? "full" : "light",
          detect: e.detect,
          commands: e.commands,
          pr: e.pr
            ? {
                reviewers_default: e.pr.reviewers_default,
                draft_by_default: e.pr.draft_by_default ?? true,
              }
            : { draft_by_default: true },
          ci: e.ci,
          mcp_servers: mergeMcpServers(globalMcpServers, repoMcp),
        });
      }
    }

    const mcpCount = [...repos.values()].filter((r) => r.mcp_servers).length;
    log.info("Repo registry loaded", { count: repos.size, mcpCount, path });
    return { repos, globalMcpServers };
  } catch (err: any) {
    log.error("Failed to load repo registry", { path, error: err.message });
    return { repos: new Map() };
  }
}
