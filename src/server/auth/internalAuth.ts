import type { NextFunction, Request, Response } from "express";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("server:auth");

export function internalAuth(token: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Accept Bearer header (normal requests) or ?token= query param (SSE/EventSource)
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      const provided = header.slice(7);
      if (provided === token) return next();
    }
    const qToken = typeof req.query.token === "string" ? req.query.token : undefined;
    if (qToken === token) return next();

    if (!header && !qToken) {
      res.status(401).json({ error: "Missing or invalid Authorization header" });
      return;
    }
    log.warn("Invalid API token attempt", { ip: req.ip });
    res.status(403).json({ error: "Invalid API token" });
  };
}

export function optionalBasicAuth(user?: string, pass?: string) {
  if (!user || !pass) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Basic ")) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Son of Steve"');
      res.status(401).send("Authentication required");
      return;
    }
    const decoded = Buffer.from(header.slice(6), "base64").toString();
    const [u, p] = decoded.split(":");
    if (u !== user || p !== pass) {
      res.status(403).send("Invalid credentials");
      return;
    }
    next();
  };
}
