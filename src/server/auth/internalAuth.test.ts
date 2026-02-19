import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { internalAuth, optionalBasicAuth } from "./internalAuth.js";

function mockReqResNext(headers: Record<string, string> = {}, query: Record<string, string> = {}) {
  const req = { headers, ip: "127.0.0.1", query } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next };
}

describe("internalAuth (Bearer token)", () => {
  const middleware = internalAuth("secret-token-123");

  it("calls next() for a valid token", () => {
    const { req, res, next } = mockReqResNext({
      authorization: "Bearer secret-token-123",
    });
    middleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization header is missing", () => {
    const { req, res, next } = mockReqResNext({});
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 when Authorization header has wrong scheme", () => {
    const { req, res, next } = mockReqResNext({
      authorization: "Basic abc123",
    });
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("returns 403 for an invalid token", () => {
    const { req, res, next } = mockReqResNext({
      authorization: "Bearer wrong-token",
    });
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("accepts ?token= query param as fallback (for SSE/EventSource)", () => {
    const { req, res, next } = mockReqResNext({}, { token: "secret-token-123" });
    middleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("returns 403 for invalid query param token", () => {
    const { req, res, next } = mockReqResNext({}, { token: "wrong" });
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("optionalBasicAuth", () => {
  it("passes through when no credentials configured", () => {
    const middleware = optionalBasicAuth(undefined, undefined);
    const { req, res, next } = mockReqResNext({});
    middleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("calls next() for valid Basic credentials", () => {
    const middleware = optionalBasicAuth("admin", "pass123");
    const encoded = Buffer.from("admin:pass123").toString("base64");
    const { req, res, next } = mockReqResNext({
      authorization: `Basic ${encoded}`,
    });
    middleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("returns 401 with WWW-Authenticate when header is missing", () => {
    const middleware = optionalBasicAuth("admin", "pass123");
    const { req, res, next } = mockReqResNext({});
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.setHeader).toHaveBeenCalledWith("WWW-Authenticate", 'Basic realm="Son of Steve"');
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 for invalid Basic credentials", () => {
    const middleware = optionalBasicAuth("admin", "pass123");
    const encoded = Buffer.from("admin:wrong").toString("base64");
    const { req, res, next } = mockReqResNext({
      authorization: `Basic ${encoded}`,
    });
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
