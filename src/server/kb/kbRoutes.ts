/**
 * API routes for knowledge base management.
 * Mounted at /api/web/kb and /api/worker/kb.
 */

import { type Request, type Response, Router } from "express";
import multer from "multer";
import type { KBScope } from "../../shared/kbTypes.js";
import { createLogger } from "../../shared/logger.js";
import type { ResearchStrategy } from "../../shared/researchTypes.js";
import {
  addToFTSIndex,
  countFTSRows,
  dropFTSIndex,
  type FTSRecord,
  hasFTSIndex,
  rebuildFTSIndex,
} from "./ftsStore.js";
import {
  createKnowledgeBase,
  deleteKnowledgeBase,
  getDocumentChunks,
  getKBDocuments,
  getKnowledgeBase,
  ingestIntoKBWithJob,
  listKnowledgeBases,
  removeDocument,
  researchKnowledgeBases,
  searchKnowledgeBases,
  searchKnowledgeBasesWithRouting,
  searchSingleKB,
  updateKnowledgeBase,
} from "./kbService.js";
import { getBatchRaptorStatus, getRaptorStatus } from "./raptor/raptorRepo.js";
import { buildRaptorTree } from "./raptor/treeBuilder.js";
import { findResearchSession, listResearchSessions } from "./research/auditRepo.js";
import {
  getActiveUploadsForKB,
  getAllActiveUploads,
  getRecentUploadsForKB,
  getUploadJob,
} from "./uploadRepo.js";
import { listAllChunksForFTS, listRaptorNodes } from "./vectorStore.js";

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

  // POST /api/web/kb/search — cross-KB search with routing metadata (playground)
  router.post("/search", async (req: Request, res: Response) => {
    try {
      const { query, scopes, max_chunks, min_score } = req.body;

      if (!query || typeof query !== "string") {
        res.status(400).json({ error: "query is required" });
        return;
      }

      const result = await searchKnowledgeBasesWithRouting(
        {
          query,
          scopes: scopes || ["chat"],
          max_chunks,
          min_score,
        },
        req.body.owner,
      );

      res.json(result);
    } catch (err: any) {
      log.error("Cross-KB search error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

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

  // GET /api/web/kb — list knowledge bases (includes raptor_status map)
  router.get("/", async (req: Request, res: Response) => {
    try {
      const owner = req.query.owner ? pstr(req.query.owner) : undefined;
      const kbs = await listKnowledgeBases(owner);

      // Batch-fetch RAPTOR status for all KBs
      const kbIds = kbs.map((kb) => kb.kb_id);
      const raptorStatuses = await getBatchRaptorStatus(kbIds);

      res.json({ kbs, raptor_status: raptorStatuses });
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
  // Creates a durable upload job and processes files in the background.
  // Streams NDJSON progress events when Accept: text/x-ndjson is requested;
  // otherwise returns the job immediately.
  router.post("/:id/ingest", upload.array("files", 500), async (req: Request, res: Response) => {
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

      const wantsStream = req.headers.accept?.includes("text/x-ndjson");

      if (wantsStream) {
        // Stream NDJSON events while also persisting job state in MongoDB.
        // If the client disconnects, background processing continues.
        res.setHeader("Content-Type", "text/x-ndjson; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
        res.flushHeaders();

        let closed = false;
        res.on("close", () => {
          closed = true;
        });

        // ingestIntoKBWithJob emits job_created as its first event (before
        // background processing starts) so the client gets the job_id first.
        const job = await ingestIntoKBWithJob(kbId, files, (event) => {
          if (closed) return;
          res.write(JSON.stringify(event) + "\n");
        });

        // Poll the job until done so we can close the response.
        const waitForCompletion = async () => {
          const POLL_MS = 500;
          const MAX_WAIT = 10 * 60 * 1000; // 10 minutes
          const start = Date.now();
          while (!closed && Date.now() - start < MAX_WAIT) {
            const current = await getUploadJob(job.job_id);
            if (!current || current.status !== "processing") break;
            await new Promise((r) => setTimeout(r, POLL_MS));
          }
          if (!closed) res.end();
        };

        waitForCompletion().catch(() => {
          if (!closed) res.end();
        });
      } else {
        // Non-streaming: create job and return immediately
        const job = await ingestIntoKBWithJob(kbId, files);
        res.status(202).json({ job_id: job.job_id, status: job.status });
      }
    } catch (err: any) {
      log.error("Ingest error", { error: err.message });
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      } else {
        res.write(
          JSON.stringify({ type: "file_error", file: "_fatal", error: err.message }) + "\n",
        );
        res.end();
      }
    }
  });

  // ─── Upload Job Routes ──────────────────────────────────

  // GET /api/web/kb/uploads/active — all active upload jobs across all KBs
  router.get("/uploads/active", async (_req: Request, res: Response) => {
    try {
      const uploads = await getAllActiveUploads();
      res.json({ uploads });
    } catch (err: any) {
      log.error("List active uploads error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/web/kb/:id/uploads — upload jobs for a specific KB
  router.get("/:id/uploads", async (req: Request, res: Response) => {
    try {
      const kbId = pstr(req.params.id);
      const activeOnly = req.query.active === "true";
      const uploads = activeOnly
        ? await getActiveUploadsForKB(kbId)
        : await getRecentUploadsForKB(kbId);
      res.json({ uploads });
    } catch (err: any) {
      log.error("List KB uploads error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/web/kb/:id/uploads/:jobId — get specific upload job
  router.get("/:id/uploads/:jobId", async (req: Request, res: Response) => {
    try {
      const job = await getUploadJob(pstr(req.params.jobId));
      if (!job) {
        res.status(404).json({ error: "Upload job not found" });
        return;
      }
      res.json({ job });
    } catch (err: any) {
      log.error("Get upload job error", { error: err.message });
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

      const { results, retrieval_stats } = await searchSingleKB(kbId, query, limit);
      res.json({ results, retrieval_stats });
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

  // GET /api/web/kb/:id/documents/:name/chunks — list chunks with pagination
  router.get("/:id/documents/:name/chunks", async (req: Request, res: Response) => {
    try {
      const kbId = pstr(req.params.id);
      const docName = decodeURIComponent(pstr(req.params.name));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

      const result = await getDocumentChunks(kbId, docName, offset, limit);
      res.json(result);
    } catch (err: any) {
      log.error("List chunks error", { error: err.message });
      res.status(500).json({ error: err.message });
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

  // ─── Research Pipeline Routes ─────────────────────────────

  // POST /api/web/kb/research — run research pipeline (JSON or NDJSON streaming)
  router.post("/research", async (req: Request, res: Response) => {
    try {
      const { query, scopes, strategy, config_overrides } = req.body;

      if (!query || typeof query !== "string") {
        res.status(400).json({ error: "query is required" });
        return;
      }

      const wantsStream = req.headers.accept?.includes("text/x-ndjson");

      if (wantsStream) {
        res.setHeader("Content-Type", "text/x-ndjson; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        const result = await researchKnowledgeBases({
          query,
          scopes: scopes || ["chat"],
          strategy: strategy as ResearchStrategy,
          config_overrides,
          consumer: { type: "playground" },
          owner: req.body.owner,
          onEvent: (event) => {
            res.write(JSON.stringify(event) + "\n");
          },
        });

        // Write final result as last line
        res.write(JSON.stringify({ type: "result", ...result }) + "\n");
        res.end();
      } else {
        const result = await researchKnowledgeBases({
          query,
          scopes: scopes || ["chat"],
          strategy: strategy as ResearchStrategy,
          config_overrides,
          consumer: { type: "playground" },
          owner: req.body.owner,
        });

        res.json(result);
      }
    } catch (err: any) {
      log.error("Research pipeline error", { error: err.message });
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      } else {
        res.write(JSON.stringify({ type: "session_error", error: err.message }) + "\n");
        res.end();
      }
    }
  });

  // GET /api/web/kb/research/sessions — list past research sessions
  router.get("/research/sessions", async (req: Request, res: Response) => {
    try {
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const strategy = req.query.strategy as ResearchStrategy | undefined;
      const consumer_type = req.query.consumer_type as string | undefined;
      const consumer_id = req.query.consumer_id as string | undefined;

      const result = await listResearchSessions({
        limit,
        offset,
        strategy,
        consumer_type,
        consumer_id,
      });
      res.json(result);
    } catch (err: any) {
      log.error("List research sessions error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/web/kb/research/sessions/:id — get full research session
  router.get("/research/sessions/:id", async (req: Request, res: Response) => {
    try {
      const session = await findResearchSession(pstr(req.params.id));
      if (!session) {
        res.status(404).json({ error: "Research session not found" });
        return;
      }
      res.json({ session });
    } catch (err: any) {
      log.error("Get research session error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ─── FTS (Keyword Index) Routes ─────────────────────────────

  // GET /api/web/kb/:id/fts/status — get FTS index status for a KB
  router.get("/:id/fts/status", async (req: Request, res: Response) => {
    try {
      const kbId = pstr(req.params.id);
      const kb = await getKnowledgeBase(kbId);
      if (!kb) {
        res.status(404).json({ error: "Knowledge base not found" });
        return;
      }

      const indexed = hasFTSIndex(kbId);
      const ftsRows = indexed ? countFTSRows(kbId) : 0;
      res.json({
        indexed,
        fts_chunk_count: ftsRows,
        vector_chunk_count: kb.chunk_count,
        needs_rebuild: indexed ? ftsRows < kb.chunk_count : kb.chunk_count > 0,
      });
    } catch (err: any) {
      log.error("FTS status error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/web/kb/:id/fts/rebuild — rebuild FTS index from LanceDB chunks
  // Supports NDJSON streaming (Accept: text/x-ndjson) for real-time progress.
  router.post("/:id/fts/rebuild", async (req: Request, res: Response) => {
    try {
      const kbId = pstr(req.params.id);
      const kb = await getKnowledgeBase(kbId);
      if (!kb) {
        res.status(404).json({ error: "Knowledge base not found" });
        return;
      }

      const wantsStream = req.headers.accept?.includes("text/x-ndjson");
      const BATCH_SIZE = 500;

      if (wantsStream) {
        res.setHeader("Content-Type", "text/x-ndjson; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        let closed = false;
        res.on("close", () => {
          closed = true;
        });

        const emit = (event: Record<string, unknown>) => {
          if (!closed) res.write(JSON.stringify(event) + "\n");
        };

        try {
          emit({ type: "reading", message: "Reading chunks from knowledge base..." });

          const chunks = await listAllChunksForFTS(kbId);
          const total = chunks.length;
          emit({ type: "read_complete", total });

          // Drop existing index
          dropFTSIndex(kbId);

          if (total === 0) {
            emit({ type: "complete", chunks_indexed: 0, total: 0 });
            if (!closed) res.end();
            return;
          }

          // Insert in batches with progress events
          let indexed = 0;
          for (let i = 0; i < total; i += BATCH_SIZE) {
            const batch = chunks.slice(i, i + BATCH_SIZE);
            const records: FTSRecord[] = batch.map((c) => ({
              chunk_id: c.id,
              kb_id: c.kb_id,
              source_file: c.source_file,
              content: c.content,
              section: c.section || undefined,
              page: c.page || undefined,
              file_path: c.file_path || undefined,
              parent_dir: c.parent_dir || undefined,
            }));
            addToFTSIndex(kbId, records);
            indexed += records.length;
            emit({ type: "batch", indexed, total });
          }

          emit({ type: "complete", chunks_indexed: indexed, total });
          log.info("FTS index rebuilt via API (streaming)", { kbId, chunks: indexed });
        } catch (err: any) {
          emit({ type: "error", error: err.message });
          log.error("FTS rebuild error (streaming)", { error: err.message });
        } finally {
          if (!closed) res.end();
        }
      } else {
        // Non-streaming: original behavior
        const chunks = await listAllChunksForFTS(kbId);
        const ftsRecords: FTSRecord[] = chunks.map((c) => ({
          chunk_id: c.id,
          kb_id: c.kb_id,
          source_file: c.source_file,
          content: c.content,
          section: c.section || undefined,
          page: c.page || undefined,
          file_path: c.file_path || undefined,
          parent_dir: c.parent_dir || undefined,
        }));
        rebuildFTSIndex(kbId, ftsRecords);
        log.info("FTS index rebuilt via API", { kbId, chunks: ftsRecords.length });
        res.json({ ok: true, chunks_indexed: ftsRecords.length });
      }
    } catch (err: any) {
      log.error("FTS rebuild error", { error: err.message });
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  });

  // ─── RAPTOR Routes ────────────────────────────────────────

  // POST /api/web/kb/:id/raptor/build — trigger RAPTOR tree build
  router.post("/:id/raptor/build", async (req: Request, res: Response) => {
    try {
      const kbId = pstr(req.params.id);
      const kb = await getKnowledgeBase(kbId);
      if (!kb) {
        res.status(404).json({ error: "Knowledge base not found" });
        return;
      }

      // Run build asynchronously, return immediately
      const config = req.body.config || {};
      buildRaptorTree(kbId, kb.chunk_count, config).catch((err) => {
        log.error("RAPTOR build failed", { kbId, error: err.message });
      });

      res.json({ ok: true, message: "RAPTOR build started" });
    } catch (err: any) {
      log.error("RAPTOR build trigger error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/web/kb/:id/raptor/status — get RAPTOR build status
  router.get("/:id/raptor/status", async (req: Request, res: Response) => {
    try {
      const kbId = pstr(req.params.id);
      const status = await getRaptorStatus(kbId);
      res.json({
        status: status || {
          built: false,
          levels: 0,
          nodes_per_level: {},
          total_nodes: 0,
        },
      });
    } catch (err: any) {
      log.error("RAPTOR status error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/web/kb/:id/raptor/tree — get RAPTOR tree nodes for visualization
  router.get("/:id/raptor/tree", async (req: Request, res: Response) => {
    try {
      const kbId = pstr(req.params.id);
      const nodes = await listRaptorNodes(kbId);
      res.json({ nodes });
    } catch (err: any) {
      log.error("RAPTOR tree error", { error: err.message });
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

  // POST /api/worker/kb/search — search KBs by scope (backward compat)
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

  // POST /api/worker/kb/research — run research pipeline (JSON or NDJSON streaming)
  router.post("/research", async (req: Request, res: Response) => {
    try {
      const { query, scopes, strategy, consumer } = req.body;

      if (!query || typeof query !== "string") {
        res.status(400).json({ error: "query is required" });
        return;
      }
      if (!scopes || !Array.isArray(scopes)) {
        res.status(400).json({ error: "scopes is required (array)" });
        return;
      }

      const wantsStream = req.headers.accept?.includes("text/x-ndjson");

      if (wantsStream) {
        // NDJSON streaming mode — send events as they happen
        res.setHeader("Content-Type", "text/x-ndjson; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("X-Accel-Buffering", "no");

        const result = await researchKnowledgeBases({
          query,
          scopes: scopes as KBScope[],
          strategy: (strategy as ResearchStrategy) || "deep",
          consumer,
          onEvent: (event) => {
            res.write(`${JSON.stringify(event)}\n`);
          },
        });

        // Write final result event
        res.write(`${JSON.stringify({ type: "result", ...result })}\n`);
        res.end();
      } else {
        // Standard JSON response
        const result = await researchKnowledgeBases({
          query,
          scopes: scopes as KBScope[],
          strategy: (strategy as ResearchStrategy) || "deep",
          consumer,
        });

        res.json({
          context: result.context,
          chunks: result.chunks,
          metrics: result.metrics,
          session_id: result.session_id,
        });
      }
    } catch (err: any) {
      log.error("Worker research error", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
