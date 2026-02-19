import { createLogger } from "../shared/logger.js";

const log = createLogger("worker:config");

function required(name: string): string {
  const val = process.env[name];
  if (!val) {
    log.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
}

function optionalInt(name: string, fallback: number): number {
  const val = process.env[name];
  return val ? parseInt(val, 10) : fallback;
}

function optionalStr(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function optionalBool(name: string, fallback: boolean): boolean {
  const val = process.env[name];
  if (!val) return fallback;
  return val.toLowerCase() === "true" || val === "1";
}

export function loadWorkerConfig() {
  return {
    apiBaseUrl: required("SOS_API_BASE_URL"),
    apiToken: required("SOS_INTERNAL_API_TOKEN"),
    requestedBy: required("SOS_REQUESTED_BY_SLACK_USER"),
    nodeId: optionalStr("SOS_NODE_ID", "local"),
    pollIntervalSeconds: optionalInt("SOS_POLL_INTERVAL_SECONDS", 10),
    leaseSeconds: optionalInt("SOS_LEASE_SECONDS", 120),
    workspaceRoot: required("SOS_WORKSPACE_ROOT"),
    repoRegistryPath: required("SOS_REPO_REGISTRY"),
    maxCiFixAttempts: optionalInt("SOS_MAX_CI_FIX_ATTEMPTS", 2),
    maxRuntimeMinutes: optionalInt("SOS_MAX_RUNTIME_MINUTES", 60),
    requireLocalTestsBeforePr: optionalBool("SOS_REQUIRE_LOCAL_TESTS_BEFORE_PR", false),
    testLevelDefault: optionalStr("SOS_TEST_LEVEL_DEFAULT", "fast") as "fast" | "full" | "none",
  };
}

export type WorkerConfig = ReturnType<typeof loadWorkerConfig>;
