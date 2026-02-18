import { describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger.js";

describe("createLogger", () => {
  it("creates a logger with all four levels", () => {
    const log = createLogger("test");
    expect(typeof log.debug).toBe("function");
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
  });

  it("outputs structured JSON to console.log", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger("test:component");
    log.info("hello world");

    expect(spy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed.level).toBe("info");
    expect(parsed.component).toBe("test:component");
    expect(parsed.msg).toBe("hello world");
    expect(parsed.ts).toBeDefined();
    spy.mockRestore();
  });

  it("redacts Slack bot tokens", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger("test");
    log.info("token is xoxb-1234567890-abcdefghijk");

    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed.msg).not.toContain("xoxb-");
    expect(parsed.msg).toContain("[REDACTED]");
    spy.mockRestore();
  });

  it("redacts GitHub personal access tokens in data", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger("test");
    log.info("check", { token: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl" });

    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed.data.token).toContain("[REDACTED]");
    spy.mockRestore();
  });

  it("routes errors to console.error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = createLogger("test");
    log.error("something broke");

    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
