const REDACT_PATTERNS = [
  /xoxb-[a-zA-Z0-9-]+/g,
  /xapp-[a-zA-Z0-9-]+/g,
  /xoxp-[a-zA-Z0-9-]+/g,
  /Bearer\s+[a-zA-Z0-9._-]{20,}/g,
  /ghp_[a-zA-Z0-9]{36,}/g,
  /gho_[a-zA-Z0-9]{36,}/g,
];

function redact(msg: string): string {
  let result = msg;
  for (const pattern of REDACT_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

type LogLevel = "debug" | "info" | "warn" | "error";

function redactData(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string") {
      result[key] = redact(value);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = redactData(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function log(level: LogLevel, component: string, msg: string, data?: Record<string, unknown>) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    component,
    msg: redact(msg),
    ...(data ? { data: redactData(data) } : {}),
  };
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function createLogger(component: string) {
  return {
    debug: (msg: string, data?: Record<string, unknown>) => log("debug", component, msg, data),
    info: (msg: string, data?: Record<string, unknown>) => log("info", component, msg, data),
    warn: (msg: string, data?: Record<string, unknown>) => log("warn", component, msg, data),
    error: (msg: string, data?: Record<string, unknown>) => log("error", component, msg, data),
  };
}
