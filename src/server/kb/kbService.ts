/**
 * Knowledge base service — orchestrates CRUD, ingestion, and search.
 */

import { dirname } from "node:path";
import { v4 as uuidv4 } from "uuid";
import type {
  IngestProgressEvent,
  KBProbeResult,
  KBScope,
  KBSearchRequest,
  KBSearchResult,
  KBSearchWithRoutingResult,
  KnowledgeBase,
  UploadJob,
} from "../../shared/kbTypes.js";
import { pathToBreadcrumb } from "../../shared/kbUtils.js";
import { createLogger } from "../../shared/logger.js";
import type {
  ResearchConfig,
  ResearchConsumer,
  ResearchResult,
  ResearchStrategy,
  ResearchStreamEvent,
} from "../../shared/researchTypes.js";
import { getEmbeddingProvider } from "./embeddings.js";
import { type IngestedFile, ingestFiles } from "./ingestion.js";
import {
  addDocumentRecord,
  createKB,
  deleteKB,
  findKB,
  incrementKBStats,
  listDocuments,
  listEnabledKBsByScope,
  listKBs,
  removeDocumentRecord,
  updateKB,
} from "./kbRepo.js";
import { runResearchPipeline } from "./research/pipeline.js";
import { getStrategyConfig } from "./research/strategies.js";
import {
  completeUploadJob,
  createUploadJob,
  deleteUploadJobsForKB,
  failUploadJob,
  updateUploadFileStatus,
} from "./uploadRepo.js";
import {
  addToKBTable,
  countDocumentRows,
  deleteDocumentFromKBTable,
  dropKBTable,
  listDocumentChunks,
  searchKBTable,
  type VectorRecord,
} from "./vectorStore.js";

const log = createLogger("server:kb:service");

/**
 * Convert LanceDB L2 distance to a 0-1 similarity score.
 * Lower distance = higher similarity. Formula: 1 / (1 + distance)
 */
export function distanceToSimilarity(distance: number): number {
  return 1 / (1 + distance);
}

/**
 * Create a new knowledge base.
 */
export async function createKnowledgeBase(params: {
  name: string;
  description: string;
  owner: string;
  scopes: KBScope[];
  embedding_model?: string;
  chunk_size?: number;
  chunk_overlap?: number;
  max_chunks_per_query?: number;
  min_similarity_score?: number;
}): Promise<KnowledgeBase> {
  const embeddingProvider = getEmbeddingProvider();

  const kb: KnowledgeBase = {
    kb_id: uuidv4(),
    name: params.name,
    description: params.description,
    enabled: true,
    owner: params.owner,
    created_at: new Date(),
    updated_at: new Date(),
    scopes: params.scopes,
    chunk_count: 0,
    document_count: 0,
    total_size_bytes: 0,
    embedding_model: params.embedding_model || embeddingProvider.modelName,
    chunk_size: params.chunk_size ?? 512,
    chunk_overlap: params.chunk_overlap ?? 50,
    max_chunks_per_query: params.max_chunks_per_query ?? 5,
    min_similarity_score: params.min_similarity_score ?? 0.3,
  };

  return createKB(kb);
}

/**
 * Get a knowledge base by ID.
 */
export async function getKnowledgeBase(kbId: string): Promise<KnowledgeBase | null> {
  return findKB(kbId);
}

/**
 * List all knowledge bases.
 */
export async function listKnowledgeBases(owner?: string): Promise<KnowledgeBase[]> {
  return listKBs(owner);
}

/**
 * Update a knowledge base's configuration.
 */
export async function updateKnowledgeBase(
  kbId: string,
  updates: Partial<
    Pick<
      KnowledgeBase,
      | "name"
      | "description"
      | "enabled"
      | "scopes"
      | "embedding_model"
      | "chunk_size"
      | "chunk_overlap"
      | "max_chunks_per_query"
      | "min_similarity_score"
    >
  >,
): Promise<KnowledgeBase | null> {
  return updateKB(kbId, updates);
}

// ---------------------------------------------------------------------------
// Shared per-file ingestion pipeline (used by both batch and streaming paths)
// ---------------------------------------------------------------------------

interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Enrich, embed, store, and record a single ingested file.
 * Returns the number of vector records written.
 */
async function embedAndStoreFile(
  kbId: string,
  ingestedFile: IngestedFile,
  embeddingProvider: EmbeddingProvider,
): Promise<number> {
  // Collect and resolve chunk metadata
  const fileChunks = ingestedFile.chunks.map((chunk) => {
    // || for filePath: empty string is not a meaningful path, so fall through
    const filePath = chunk.metadata.file_path || ingestedFile.filePath || ingestedFile.name;
    // ?? for parentDir: empty string is valid (means file is at root level)
    const parentDir =
      chunk.metadata.parent_dir ?? (dirname(filePath) === "." ? "" : dirname(filePath));
    return {
      content: chunk.content,
      sourceFile: ingestedFile.name,
      section: chunk.metadata.section,
      page: chunk.metadata.page,
      filePath,
      parentDir,
    };
  });

  // Build breadcrumb-enriched content for embedding.
  // Prepending the hierarchy path and section improves vector similarity
  // for queries that reference the document structure ("contextual chunking").
  const enrichedTexts = fileChunks.map((c) => {
    const pathBreadcrumb = pathToBreadcrumb(c.filePath);
    const lines: string[] = [`Source: ${pathBreadcrumb}`];
    if (c.section) lines.push(`Section: ${c.section}`);
    lines.push("", c.content);
    return lines.join("\n");
  });

  const embeddings = await embeddingProvider.embed(enrichedTexts);

  // Store the enriched content (with breadcrumb) — it's useful context when
  // injected into downstream LLM prompts as well.
  const records: VectorRecord[] = fileChunks.map((chunk, i) => ({
    id: uuidv4(),
    kb_id: kbId,
    source_file: chunk.sourceFile,
    content: enrichedTexts[i],
    vector: embeddings[i],
    section: chunk.section || "",
    page: chunk.page || 0,
    file_path: chunk.filePath,
    parent_dir: chunk.parentDir,
    created_at: new Date().toISOString(),
    level: 0,
    children_ids: "[]",
  }));

  await addToKBTable(kbId, records);

  await addDocumentRecord(kbId, {
    name: ingestedFile.name,
    size_bytes: ingestedFile.sizeBytes,
    chunk_count: ingestedFile.chunks.length,
    ingested_at: new Date(),
  });

  await incrementKBStats(kbId, {
    chunk_count: records.length,
    document_count: 1,
    total_size_bytes: ingestedFile.sizeBytes,
  });

  return records.length;
}

// ---------------------------------------------------------------------------
// Public ingestion functions
// ---------------------------------------------------------------------------

/**
 * Ingest files into a knowledge base (batch).
 * Handles chunking, embedding, and storage.
 */
export async function ingestIntoKB(
  kbId: string,
  files: Array<{ filename: string; buffer: Buffer }>,
): Promise<{
  documents_added: number;
  chunks_added: number;
  skipped: string[];
  errors: Array<{ file: string; error: string }>;
}> {
  const kb = await findKB(kbId);
  if (!kb) throw new Error(`Knowledge base ${kbId} not found`);

  const embeddingProvider = getEmbeddingProvider();
  const ingestionResult = await ingestFiles(files, {
    chunkSize: kb.chunk_size,
    chunkOverlap: kb.chunk_overlap,
  });

  if (ingestionResult.files.length === 0) {
    return {
      documents_added: 0,
      chunks_added: 0,
      skipped: ingestionResult.skipped,
      errors: ingestionResult.errors,
    };
  }

  log.info("Generating embeddings", { kbId, files: ingestionResult.files.length });

  let totalChunks = 0;
  for (const file of ingestionResult.files) {
    totalChunks += await embedAndStoreFile(kbId, file, embeddingProvider);
  }

  log.info("Ingestion complete", {
    kbId,
    documents: ingestionResult.files.length,
    chunks: totalChunks,
  });

  return {
    documents_added: ingestionResult.files.length,
    chunks_added: totalChunks,
    skipped: ingestionResult.skipped,
    errors: ingestionResult.errors,
  };
}

/**
 * Streaming variant of ingestIntoKB — processes files one at a time and
 * yields NDJSON-friendly progress events so the client can show real-time
 * per-file progress.
 */
export async function* ingestIntoKBStreaming(
  kbId: string,
  files: Array<{ filename: string; buffer: Buffer }>,
): AsyncGenerator<IngestProgressEvent> {
  const kb = await findKB(kbId);
  if (!kb) throw new Error(`Knowledge base ${kbId} not found`);

  const embeddingProvider = getEmbeddingProvider();
  const options = { chunkSize: kb.chunk_size, chunkOverlap: kb.chunk_overlap };

  let totalDocsAdded = 0;
  let totalChunksAdded = 0;
  const allSkipped: string[] = [];
  const allErrors: Array<{ file: string; error: string }> = [];

  yield { type: "start", total_uploads: files.length };

  for (const file of files) {
    yield { type: "file_start", file: file.filename };

    try {
      const ingestionResult = await ingestFiles([file], options);

      allSkipped.push(...ingestionResult.skipped);
      allErrors.push(...ingestionResult.errors);

      for (const err of ingestionResult.errors) {
        yield { type: "file_error", file: err.file, error: err.error };
      }
      for (const skipped of ingestionResult.skipped) {
        yield { type: "file_skip", file: skipped, reason: "unsupported or empty" };
      }

      if (ingestionResult.files.length === 0) {
        if (ingestionResult.errors.length === 0) {
          yield { type: "file_skip", file: file.filename, reason: "no extractable content" };
        }
        continue;
      }

      for (const ingestedFile of ingestionResult.files) {
        const chunkCount = await embedAndStoreFile(kbId, ingestedFile, embeddingProvider);
        totalDocsAdded++;
        totalChunksAdded += chunkCount;
        yield { type: "file_done", file: ingestedFile.name, chunks: chunkCount };
      }
    } catch (err: any) {
      allErrors.push({ file: file.filename, error: err.message });
      yield { type: "file_error", file: file.filename, error: err.message };
    }
  }

  log.info("Streaming ingestion complete", {
    kbId,
    documents: totalDocsAdded,
    chunks: totalChunksAdded,
  });

  yield {
    type: "complete",
    documents_added: totalDocsAdded,
    chunks_added: totalChunksAdded,
    skipped: allSkipped,
    errors: allErrors,
  };
}

/**
 * Job-based ingestion — creates a durable upload job in MongoDB, processes
 * files in the background, and updates per-file status as processing proceeds.
 *
 * Returns the UploadJob immediately. The caller can optionally pass an
 * `onEvent` callback for real-time NDJSON streaming (used when the client
 * stays connected). Processing continues even if the callback is removed
 * (e.g. client disconnects).
 */
export async function ingestIntoKBWithJob(
  kbId: string,
  files: Array<{ filename: string; buffer: Buffer }>,
  onEvent?: (event: IngestProgressEvent) => void,
): Promise<UploadJob> {
  const kb = await findKB(kbId);
  if (!kb) throw new Error(`Knowledge base ${kbId} not found`);

  const fileNames = files.map((f) => f.filename);
  const job = await createUploadJob(kbId, fileNames);

  // Mutable ref so we can nullify it when the client disconnects
  let eventCb: ((event: IngestProgressEvent) => void) | null = onEvent ?? null;

  const emit = (event: IngestProgressEvent) => {
    try {
      eventCb?.(event);
    } catch {
      // Client disconnected — stop emitting but keep processing
      eventCb = null;
    }
  };

  // Emit job_created BEFORE starting background processing so the client
  // receives the job_id before any file progress events.
  emit({ type: "job_created", job_id: job.job_id });

  // Fire-and-forget background processing
  const processFiles = async () => {
    const embeddingProvider = getEmbeddingProvider();
    const options = { chunkSize: kb.chunk_size, chunkOverlap: kb.chunk_overlap };

    let totalDocsAdded = 0;
    let totalChunksAdded = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    emit({ type: "start", total_uploads: files.length });

    for (const file of files) {
      emit({ type: "file_start", file: file.filename });
      await updateUploadFileStatus(job.job_id, file.filename, "processing");

      try {
        const ingestionResult = await ingestFiles([file], options);

        for (const err of ingestionResult.errors) {
          emit({ type: "file_error", file: err.file, error: err.error });
          await updateUploadFileStatus(job.job_id, err.file, "error", { error: err.error });
          totalErrors++;
        }
        for (const skipped of ingestionResult.skipped) {
          const reason = "unsupported or empty";
          emit({ type: "file_skip", file: skipped, reason });
          await updateUploadFileStatus(job.job_id, skipped, "skipped", { skip_reason: reason });
          totalSkipped++;
        }

        if (ingestionResult.files.length === 0) {
          if (ingestionResult.errors.length === 0 && ingestionResult.skipped.length === 0) {
            const reason = "no extractable content";
            emit({ type: "file_skip", file: file.filename, reason });
            await updateUploadFileStatus(job.job_id, file.filename, "skipped", {
              skip_reason: reason,
            });
            totalSkipped++;
          }
          continue;
        }

        for (const ingestedFile of ingestionResult.files) {
          const chunkCount = await embedAndStoreFile(kbId, ingestedFile, embeddingProvider);
          totalDocsAdded++;
          totalChunksAdded += chunkCount;
          emit({ type: "file_done", file: ingestedFile.name, chunks: chunkCount });
          await updateUploadFileStatus(job.job_id, ingestedFile.name, "done", {
            chunks: chunkCount,
          });
        }
      } catch (err: any) {
        totalErrors++;
        emit({ type: "file_error", file: file.filename, error: err.message });
        await updateUploadFileStatus(job.job_id, file.filename, "error", {
          error: err.message,
        });
      }
    }

    emit({
      type: "complete",
      documents_added: totalDocsAdded,
      chunks_added: totalChunksAdded,
      skipped: [],
      errors: [],
    });

    await completeUploadJob(job.job_id, {
      documents_added: totalDocsAdded,
      chunks_added: totalChunksAdded,
      skipped: totalSkipped,
      errors: totalErrors,
    });

    log.info("Job-based ingestion complete", {
      job_id: job.job_id,
      kbId,
      documents: totalDocsAdded,
      chunks: totalChunksAdded,
    });
  };

  // Start processing in background — don't await
  processFiles().catch(async (err) => {
    log.error("Upload job failed fatally", { job_id: job.job_id, error: err.message });
    await failUploadJob(job.job_id, err.message).catch(() => {});
  });

  return job;
}

/**
 * Remove a document from a knowledge base.
 */
export async function removeDocument(kbId: string, docName: string): Promise<boolean> {
  const kb = await findKB(kbId);
  if (!kb) throw new Error(`Knowledge base ${kbId} not found`);

  // Get stats before deletion
  const chunkCount = await countDocumentRows(kbId, docName);
  const docs = await listDocuments(kbId);
  const docRecord = docs.find((d) => d.name === docName);
  const sizeBytes = docRecord?.size_bytes || 0;

  // Remove from vector store
  await deleteDocumentFromKBTable(kbId, docName);

  // Remove from MongoDB
  const removed = await removeDocumentRecord(kbId, docName);
  if (!removed) return false;

  // Update stats (decrement)
  await incrementKBStats(kbId, {
    chunk_count: -chunkCount,
    document_count: -1,
    total_size_bytes: -sizeBytes,
  });

  return true;
}

/**
 * Delete a knowledge base and all its data.
 */
export async function deleteKnowledgeBase(kbId: string): Promise<boolean> {
  // Drop the vector table
  await dropKBTable(kbId);

  // Clean up upload jobs
  await deleteUploadJobsForKB(kbId);

  // Delete from MongoDB
  return deleteKB(kbId);
}

/**
 * Internal two-stage search implementation that returns both results and routing metadata.
 */
async function twoStageSearch(
  request: KBSearchRequest,
  owner?: string,
): Promise<KBSearchWithRoutingResult> {
  const { query, scopes, max_chunks, min_score } = request;

  const emptyRouting = { results: [], routing: { total_kbs: 0, relevant_kbs: 0, probes: [] } };

  // Find all enabled KBs matching the requested scopes
  const kbs = await listEnabledKBsByScope(scopes, owner);
  if (kbs.length === 0) return emptyRouting;

  const embeddingProvider = getEmbeddingProvider();

  // Embed the query
  let queryVector: number[];
  try {
    const [vector] = await embeddingProvider.embed([query]);
    queryVector = vector;
  } catch (err: any) {
    log.error("Query embedding failed", { error: err.message });
    return { ...emptyRouting, routing: { total_kbs: kbs.length, relevant_kbs: 0, probes: [] } };
  }

  // --- Stage 1: Probe each KB with limit=1 ---
  const probes: KBProbeResult[] = [];
  const passedKBs: KnowledgeBase[] = [];

  for (const kb of kbs) {
    const minScore_ = min_score ?? kb.min_similarity_score;
    try {
      const probe = await searchKBTable(kb.kb_id, queryVector, 1);
      if (probe.length > 0) {
        const topScore = distanceToSimilarity(probe[0]._distance);
        const passed = topScore >= minScore_;
        probes.push({ kb_id: kb.kb_id, kb_name: kb.name, probe_score: topScore, passed });
        if (passed) passedKBs.push(kb);
      } else {
        probes.push({ kb_id: kb.kb_id, kb_name: kb.name, probe_score: 0, passed: false });
      }
    } catch (err: any) {
      log.warn("KB probe failed, skipping", {
        kbId: kb.kb_id,
        name: kb.name,
        error: err.message,
      });
      probes.push({ kb_id: kb.kb_id, kb_name: kb.name, probe_score: 0, passed: false });
    }
  }

  const routing = { total_kbs: kbs.length, relevant_kbs: passedKBs.length, probes };

  log.info("KB routing stage 1 complete", {
    totalKBs: kbs.length,
    relevantKBs: passedKBs.length,
    kbScores: probes.map((p) => ({
      name: p.kb_name,
      score: p.probe_score.toFixed(3),
      passed: p.passed,
    })),
  });

  if (passedKBs.length === 0) return { results: [], routing };

  // --- Stage 2: Full search on relevant KBs only ---
  const allResults: KBSearchResult[] = [];

  for (const kb of passedKBs) {
    const perKBLimit = max_chunks ?? kb.max_chunks_per_query;
    const minScore_ = min_score ?? kb.min_similarity_score;

    try {
      const results = await searchKBTable(kb.kb_id, queryVector, perKBLimit);

      for (const r of results) {
        const similarity = distanceToSimilarity(r._distance);
        if (similarity >= minScore_) {
          allResults.push({
            content: r.content,
            source_file: r.source_file,
            kb_name: kb.name,
            kb_id: kb.kb_id,
            score: similarity,
            metadata: {
              section: r.section || undefined,
              page: r.page || undefined,
              file_path: r.file_path || undefined,
              parent_dir: r.parent_dir || undefined,
            },
          });
        }
      }
    } catch (err: any) {
      log.warn("KB search failed in stage 2, skipping", {
        kbId: kb.kb_id,
        name: kb.name,
        error: err.message,
      });
    }
  }

  // Sort by score descending and limit total results
  allResults.sort((a, b) => b.score - a.score);
  const totalLimit = max_chunks ?? 10;
  return { results: allResults.slice(0, totalLimit), routing };
}

/**
 * Search across enabled knowledge bases for a given query.
 * Returns just the results (used by worker API and message router).
 */
export async function searchKnowledgeBases(
  request: KBSearchRequest,
  owner?: string,
): Promise<KBSearchResult[]> {
  const { results } = await twoStageSearch(request, owner);
  return results;
}

/**
 * Search across enabled knowledge bases with full routing metadata.
 * Used by the web UI playground to visualize two-stage routing decisions.
 */
export async function searchKnowledgeBasesWithRouting(
  request: KBSearchRequest,
  owner?: string,
): Promise<KBSearchWithRoutingResult> {
  return twoStageSearch(request, owner);
}

/**
 * Get documents for a knowledge base.
 */
export async function getKBDocuments(kbId: string) {
  return listDocuments(kbId);
}

/**
 * Get paginated chunks for a specific document.
 */
export async function getDocumentChunks(kbId: string, docName: string, offset = 0, limit = 20) {
  const kb = await findKB(kbId);
  if (!kb) throw new Error(`Knowledge base ${kbId} not found`);
  return listDocumentChunks(kbId, docName, offset, limit);
}

/**
 * Search a single KB (for testing/debugging in the UI).
 */
export async function searchSingleKB(
  kbId: string,
  query: string,
  limit?: number,
): Promise<KBSearchResult[]> {
  const kb = await findKB(kbId);
  if (!kb) throw new Error(`Knowledge base ${kbId} not found`);

  const embeddingProvider = getEmbeddingProvider();
  const [queryVector] = await embeddingProvider.embed([query]);
  const results = await searchKBTable(kbId, queryVector, limit ?? kb.max_chunks_per_query);

  return results.map((r) => ({
    content: r.content,
    source_file: r.source_file,
    kb_name: kb.name,
    kb_id: kb.kb_id,
    score: distanceToSimilarity(r._distance),
    metadata: {
      section: r.section || undefined,
      page: r.page || undefined,
      file_path: r.file_path || undefined,
      parent_dir: r.parent_dir || undefined,
    },
  }));
}

/**
 * Advanced research pipeline entry point.
 * Runs a multi-stage RAG research pipeline with the given strategy.
 */
export async function researchKnowledgeBases(params: {
  query: string;
  scopes: KBScope[];
  strategy?: ResearchStrategy;
  config_overrides?: Partial<ResearchConfig>;
  consumer?: ResearchConsumer;
  owner?: string;
  onEvent?: (event: ResearchStreamEvent) => void;
}): Promise<ResearchResult> {
  const strategy = params.strategy || "deep";
  const config = getStrategyConfig(strategy, params.config_overrides);

  return runResearchPipeline(params.query, params.scopes, config, {
    owner: params.owner,
    consumer: params.consumer,
    onEvent: params.onEvent,
  });
}
