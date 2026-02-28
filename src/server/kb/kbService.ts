/**
 * Knowledge base service — orchestrates CRUD, ingestion, and search.
 */

import { v4 as uuidv4 } from "uuid";
import type {
  KBScope,
  KBSearchRequest,
  KBSearchResult,
  KnowledgeBase,
} from "../../shared/kbTypes.js";
import { createLogger } from "../../shared/logger.js";
import { getEmbeddingProvider } from "./embeddings.js";
import { ingestFiles } from "./ingestion.js";
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
  updateKBStats,
} from "./kbRepo.js";
import {
  addToKBTable,
  countDocumentRows,
  countKBTableRows,
  deleteDocumentFromKBTable,
  dropKBTable,
  searchKBTable,
  type VectorRecord,
} from "./vectorStore.js";

const log = createLogger("server:kb:service");

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

/**
 * Ingest files into a knowledge base.
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

  // Step 1: Chunk all files
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

  // Step 2: Collect all chunk texts for batch embedding
  const allChunks: Array<{
    content: string;
    sourceFile: string;
    section?: string;
    page?: number;
  }> = [];

  for (const file of ingestionResult.files) {
    for (const chunk of file.chunks) {
      allChunks.push({
        content: chunk.content,
        sourceFile: file.name,
        section: chunk.metadata.section,
        page: chunk.metadata.page,
      });
    }
  }

  // Step 3: Generate embeddings in batches
  const texts = allChunks.map((c) => c.content);
  log.info("Generating embeddings", { kbId, chunks: texts.length });

  let embeddings: number[][];
  try {
    embeddings = await embeddingProvider.embed(texts);
  } catch (err: any) {
    log.error("Embedding generation failed", { kbId, error: err.message });
    throw new Error(`Embedding generation failed: ${err.message}`);
  }

  // Step 4: Build vector records
  const records: VectorRecord[] = allChunks.map((chunk, i) => ({
    id: uuidv4(),
    kb_id: kbId,
    source_file: chunk.sourceFile,
    content: chunk.content,
    vector: embeddings[i],
    section: chunk.section || "",
    page: chunk.page || 0,
    created_at: new Date().toISOString(),
  }));

  // Step 5: Store in LanceDB
  await addToKBTable(kbId, records);

  // Step 6: Update MongoDB metadata
  let totalSizeBytes = 0;
  for (const file of ingestionResult.files) {
    totalSizeBytes += file.sizeBytes;
    await addDocumentRecord(kbId, {
      name: file.name,
      size_bytes: file.sizeBytes,
      chunk_count: file.chunks.length,
      ingested_at: new Date(),
    });
  }

  await incrementKBStats(kbId, {
    chunk_count: records.length,
    document_count: ingestionResult.files.length,
    total_size_bytes: totalSizeBytes,
  });

  log.info("Ingestion complete", {
    kbId,
    documents: ingestionResult.files.length,
    chunks: records.length,
  });

  return {
    documents_added: ingestionResult.files.length,
    chunks_added: records.length,
    skipped: ingestionResult.skipped,
    errors: ingestionResult.errors,
  };
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

  // Delete from MongoDB
  return deleteKB(kbId);
}

/**
 * Search across enabled knowledge bases for a given query.
 * This is the main entry point for KB-augmented context retrieval.
 */
export async function searchKnowledgeBases(
  request: KBSearchRequest,
  owner?: string,
): Promise<KBSearchResult[]> {
  const { query, scopes, max_chunks, min_score } = request;

  // Find all enabled KBs matching the requested scopes
  const kbs = await listEnabledKBsByScope(scopes, owner);
  if (kbs.length === 0) return [];

  const embeddingProvider = getEmbeddingProvider();

  // Embed the query
  let queryVector: number[];
  try {
    const [vector] = await embeddingProvider.embed([query]);
    queryVector = vector;
  } catch (err: any) {
    log.error("Query embedding failed", { error: err.message });
    return [];
  }

  // Search each KB and merge results
  const allResults: KBSearchResult[] = [];

  for (const kb of kbs) {
    const perKBLimit = max_chunks ?? kb.max_chunks_per_query;
    const minScore = min_score ?? kb.min_similarity_score;

    try {
      const results = await searchKBTable(kb.kb_id, queryVector, perKBLimit);

      for (const r of results) {
        // LanceDB returns L2 distance; convert to similarity score (0-1)
        // Lower distance = higher similarity
        // Using: similarity = 1 / (1 + distance)
        const similarity = 1 / (1 + r._distance);

        if (similarity >= minScore) {
          allResults.push({
            content: r.content,
            source_file: r.source_file,
            kb_name: kb.name,
            kb_id: kb.kb_id,
            score: similarity,
            metadata: {
              section: r.section || undefined,
              page: r.page || undefined,
            },
          });
        }
      }
    } catch (err: any) {
      log.warn("KB search failed, skipping", {
        kbId: kb.kb_id,
        name: kb.name,
        error: err.message,
      });
    }
  }

  // Sort by score descending and limit total results
  allResults.sort((a, b) => b.score - a.score);
  const totalLimit = max_chunks ?? 10;
  return allResults.slice(0, totalLimit);
}

/**
 * Get documents for a knowledge base.
 */
export async function getKBDocuments(kbId: string) {
  return listDocuments(kbId);
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
    score: 1 / (1 + r._distance),
    metadata: {
      section: r.section || undefined,
      page: r.page || undefined,
    },
  }));
}
