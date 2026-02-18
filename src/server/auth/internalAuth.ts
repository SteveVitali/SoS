import { Request, Response, NextFunction } from "express";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("server:auth");

export function internalAuth(token: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing or invalid Authorization header" });
      return;
    }
    const provided = header.slice(7);
    if (provided !== token) {
      log.warn("Invalid API token attempt", { ip: req.ip });
      res.status(403).json({ error: "Invalid API token" });
      return;
    }
    next();
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
