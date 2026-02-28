/**
 * API routes for knowledge base management.
 * Mounted at /api/web/kb and /api/worker/kb.
 */

import { type Request, type Response, Router } from "express";
import multer from "multer";
import type { KBScope } from "../../shared/kbTypes.js";
import { createLogger } from "../../shared/logger.js";
import {
  createKnowledgeBase,
  deleteKnowledgeBase,
  getKBDocuments,
  getKnowledgeBase,
  ingestIntoKB,
  listKnowledgeBases,
  removeDocument,
  searchKnowledgeBases,
  searchSingleKB,
  updateKnowledgeBase,
} from "./kbService.js";

const log = createLogger("server:kb:routes");

function pstr(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

// Configure multer for file uploads — store in memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB per file
});

/**
 * Web-facing KB routes (mounted at /api/web/kb).
 */
export function createKBWebRoutes(): Router {
  const router = Router();

  // POST /api/web/kb — create a new knowledge base
  router.post("/", async (req: Request, res: Response) => {
    try {
      const {
        name,
        description,
        scopes,
        embedding_model,
        chunk_size,
        chunk_overlap,
        max_chunks_per_query,
        min_similarity_score,
      } = req.body;

      if (!name || typeof name !== "string") {
        res.status(400).json({ error: "name is required" });
        return;
      }

      const kb = await createKnowledgeBase({
        name: name.trim(),
        description: (description || "").trim(),
        owner: req.body.owner || "default",
        scopes: scopes || ["chat"],
        embedding_model,
        chunk_size,
        chunk_overlap,
        max_chunks_per_query,
        min_similarity_score,
      });

      res.status(201).json({ kb });
    } catch (err: any) {
      log.error("Create KB error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/web/kb — list knowledge bases
  router.get("/", async (req: Request, res: Response) => {
    try {
      const owner = req.query.owner ? pstr(req.query.owner) : undefined;
      const kbs = await listKnowledgeBases(owner);
      res.json({ kbs });
    } catch (err: any) {
      log.error("List KBs error", { error: err.message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // GET /api/web/kb/:id — get a knowledge base
  router.get("/:id", async (req: Request, res: Response) => {
    try {
      const kb = await getKnowledgeBase(pstr(req.params.id));
      if (!kb) {
        res.status(404).json({ error: "Knowledge base not found" });
        return;
      }
      const documents = await getKBDocuments(kb.kb_id);
      res.json({ kb, documents });
    } catch (err: any) {
      log.error("Get KB error", { error: err.message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // PUT /api/web/kb/:id — update a knowledge base
  router.put("/:id", async (req: Request, res: Response) => {
    try {
      const {
        name,
        description,
        enabled,
        scopes,
        embedding_model,
        chunk_size,
        chunk_overlap,
        max_chunks_per_query,
        min_similarity_score,
      } = req.body;

      const updates: any = {};
      if (name !== undefined) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (enabled !== undefined) updates.enabled = enabled;
      if (scopes !== undefined) updates.scopes = scopes;
      if (embedding_model !== undefined) updates.embedding_model = embedding_model;
      if (chunk_size !== undefined) updates.chunk_size = chunk_size;
      if (chunk_overlap !== undefined) updates.chunk_overlap = chunk_overlap;
      if (max_chunks_per_query !== undefined) updates.max_chunks_per_query = max_chunks_per_query;
      if (min_similarity_score !== undefined) updates.min_similarity_score = min_similarity_score;

      const kb = await updateKnowledgeBase(pstr(req.params.id), updates);
      if (!kb) {
        res.status(404).json({ error: "Knowledge base not found" });
        return;
      }
      res.json({ kb });
    } catch (err: any) {
      log.error("Update KB error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/web/kb/:id — delete a knowledge base
  router.delete("/:id", async (req: Request, res: Response) => {
    try {
      const deleted = await deleteKnowledgeBase(pstr(req.params.id));
      if (!deleted) {
        res.status(404).json({ error: "Knowledge base not found" });
        return;
      }
      res.json({ ok: true });
    } catch (err: any) {
      log.error("Delete KB error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/web/kb/:id/ingest — upload and ingest files
  router.post("/:id/ingest", upload.array("files", 50), async (req: Request, res: Response) => {
    try {
      const kbId = pstr(req.params.id);
      const kb = await getKnowledgeBase(kbId);
      if (!kb) {
        res.status(404).json({ error: "Knowledge base not found" });
        return;
      }

      const multerFiles = (req.files as Express.Multer.File[]) || [];
      if (multerFiles.length === 0) {
        res.status(400).json({ error: "No files provided" });
        return;
      }

      const files = multerFiles.map((f) => ({
        filename: f.originalname,
        buffer: f.buffer,
      }));

      const result = await ingestIntoKB(kbId, files);
      res.json(result);
    } catch (err: any) {
      log.error("Ingest error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/web/kb/:id/search — search a single KB (for testing)
  router.post("/:id/search", async (req: Request, res: Response) => {
    try {
      const kbId = pstr(req.params.id);
      const { query, limit } = req.body;

      if (!query || typeof query !== "string") {
        res.status(400).json({ error: "query is required" });
        return;
      }

      const results = await searchSingleKB(kbId, query, limit);
      res.json({ results });
    } catch (err: any) {
      log.error("Search KB error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/web/kb/:id/documents — list documents in a KB
  router.get("/:id/documents", async (req: Request, res: Response) => {
    try {
      const documents = await getKBDocuments(pstr(req.params.id));
      res.json({ documents });
    } catch (err: any) {
      log.error("List documents error", { error: err.message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // DELETE /api/web/kb/:id/documents/:name — remove a document
  router.delete("/:id/documents/:name", async (req: Request, res: Response) => {
    try {
      const kbId = pstr(req.params.id);
      const docName = decodeURIComponent(pstr(req.params.name));

      const removed = await removeDocument(kbId, docName);
      if (!removed) {
        res.status(404).json({ error: "Document not found" });
        return;
      }
      res.json({ ok: true });
    } catch (err: any) {
      log.error("Remove document error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

/**
 * Worker-facing KB routes (mounted at /api/worker/kb).
 */
export function createKBWorkerRoutes(): Router {
  const router = Router();

  // POST /api/worker/kb/search — search KBs by scope
  router.post("/search", async (req: Request, res: Response) => {
    try {
      const { query, scopes, max_chunks, min_score } = req.body;

      if (!query || typeof query !== "string") {
        res.status(400).json({ error: "query is required" });
        return;
      }
      if (!scopes || !Array.isArray(scopes)) {
        res.status(400).json({ error: "scopes is required (array)" });
        return;
      }

      const results = await searchKnowledgeBases({
        query,
        scopes: scopes as KBScope[],
        max_chunks,
        min_score,
      });

      res.json({ results });
    } catch (err: any) {
      log.error("Worker KB search error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
