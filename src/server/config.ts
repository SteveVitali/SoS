import { createLogger } from "../shared/logger.js";

const log = createLogger("server:config");

function required(name: string): string {
  const val = process.env[name];
  if (!val) {
    log.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function optionalInt(name: string, fallback: number): number {
  const val = process.env[name];
  return val ? parseInt(val, 10) : fallback;
}

export function loadServerConfig() {
  return {
    port: optionalInt("SOS_SERVER_PORT", 3000),
    internalApiToken: required("SOS_INTERNAL_API_TOKEN"),
    mongoUri:
      process.env.MONGO_URI ||
      `mongodb+srv://${optional("MONGO_USERNAME", "places-team")}:${required("MONGO_PASSWORD")}@${optional("MONGO_HOST", "places-crawl.i6g7m.mongodb.net")}`,
    mongoDb: optional("MONGO_DB", "son_of_steve"),
    slackAppToken: process.env.SLACK_APP_TOKEN || "",
    slackBotToken: process.env.SLACK_BOT_TOKEN || "",
    slackBotUserId: process.env.SLACK_BOT_USER_ID || "",
    slackJobOwner: process.env.SOS_SLACK_JOB_OWNER || process.env.SOS_REQUESTED_BY_SLACK_USER || "",
    slackNotifyUser: process.env.SOS_SLACK_NOTIFY_USER || "",
    jobDefaultLeaseSeconds: optionalInt("JOB_DEFAULT_LEASE_SECONDS", 120),
    jobHeartbeatSeconds: optionalInt("JOB_HEARTBEAT_SECONDS", 15),
    jobMaxRuntimeMinutes: optionalInt("JOB_MAX_RUNTIME_MINUTES", 60),
    jobMaxCiFixAttempts: optionalInt("JOB_MAX_CI_FIX_ATTEMPTS", 2),
    webBasicAuthUser: process.env.WEB_BASIC_AUTH_USER,
    webBasicAuthPass: process.env.WEB_BASIC_AUTH_PASS,
    llmProvider: (process.env.SOS_LLM_PROVIDER || "anthropic") as "anthropic" | "openai_compatible",
    llmModel: process.env.SOS_LLM_MODEL || "claude-sonnet-4-20250514",
    llmApiKey: process.env.SOS_LLM_API_KEY || process.env.ANTHROPIC_API_KEY || "",
    llmBaseUrl: process.env.SOS_LLM_BASE_URL || "",
    maxThreadMessages: optionalInt("SOS_MAX_THREAD_MESSAGES", 20),
    maxAttachmentSizeMb: optionalInt("SOS_MAX_ATTACHMENT_SIZE_MB", 10),
    workspaceRoot: process.env.SOS_WORKSPACE_ROOT || "",
    repoRegistryPath: process.env.SOS_REPO_REGISTRY || "",
    ghBotLogins: (process.env.SOS_GH_BOT_LOGINS || "son-of-steve,son-of-steve[bot]")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export type ServerConfig = ReturnType<typeof loadServerConfig>;
