/**
 * MongoDB repository for knowledge base metadata.
 * Stores KB configuration, document inventory, and stats.
 */

import type { Collection, Db } from "mongodb";
import type { KBDocument, KBScope, KnowledgeBase } from "../../shared/kbTypes.js";
import { createLogger } from "../../shared/logger.js";
import { getDb } from "../mongo.js";

const log = createLogger("server:kb:repo");

function kbCol(): Collection<KnowledgeBase> {
  return getDb().collection<KnowledgeBase>("knowledge_bases");
}

/**
 * Ensure indexes on the knowledge_bases collection.
 */
export async function ensureKBIndexes(): Promise<void> {
  const col = kbCol();
  await col.createIndex({ kb_id: 1 }, { unique: true, name: "idx_kb_id_unique" });
  await col.createIndex({ owner: 1, enabled: 1 }, { name: "idx_owner_enabled" });
  log.info("KB indexes ensured");
}

/**
 * Create a new knowledge base.
 */
export async function createKB(kb: KnowledgeBase): Promise<KnowledgeBase> {
  await kbCol().insertOne(kb);
  log.info("KB created", { kb_id: kb.kb_id, name: kb.name });
  return kb;
}

/**
 * Find a knowledge base by its ID.
 */
export async function findKB(kbId: string): Promise<KnowledgeBase | null> {
  return kbCol().findOne({ kb_id: kbId });
}

/**
 * List all knowledge bases for an owner.
 */
export async function listKBs(owner?: string): Promise<KnowledgeBase[]> {
  const filter = owner ? { owner } : {};
  return kbCol().find(filter).sort({ created_at: -1 }).toArray();
}

/**
 * List enabled knowledge bases that match the given scopes.
 */
export async function listEnabledKBsByScope(
  scopes: KBScope[],
  owner?: string,
): Promise<KnowledgeBase[]> {
  const filter: any = {
    enabled: true,
    $or: [{ scopes: "all" }, { scopes: { $in: scopes } }],
  };
  if (owner) filter.owner = owner;
  return kbCol().find(filter).toArray();
}

/**
 * Update a knowledge base's metadata.
 */
export async function updateKB(
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
  const result = await kbCol().findOneAndUpdate(
    { kb_id: kbId },
    { $set: { ...updates, updated_at: new Date() } },
    { returnDocument: "after" },
  );
  return result ?? null;
}

/**
 * Update ingestion stats after adding/removing documents.
 */
export async function updateKBStats(
  kbId: string,
  stats: {
    chunk_count: number;
    document_count: number;
    total_size_bytes: number;
  },
): Promise<void> {
  await kbCol().updateOne({ kb_id: kbId }, { $set: { ...stats, updated_at: new Date() } });
}

/**
 * Increment KB stats after ingesting new documents.
 */
export async function incrementKBStats(
  kbId: string,
  delta: {
    chunk_count: number;
    document_count: number;
    total_size_bytes: number;
  },
): Promise<void> {
  await kbCol().updateOne(
    { kb_id: kbId },
    {
      $inc: {
        chunk_count: delta.chunk_count,
        document_count: delta.document_count,
        total_size_bytes: delta.total_size_bytes,
      },
      $set: { updated_at: new Date() },
    },
  );
}

/**
 * Add a document record to the KB's documents array.
 * We store document metadata in a separate collection for easy querying.
 */
export async function addDocumentRecord(kbId: string, doc: KBDocument): Promise<void> {
  const docsCol = getDb().collection("kb_documents");
  await docsCol.updateOne(
    { kb_id: kbId, name: doc.name },
    { $set: { ...doc, kb_id: kbId } },
    { upsert: true },
  );
}

/**
 * List documents for a knowledge base.
 */
export async function listDocuments(kbId: string): Promise<KBDocument[]> {
  const docsCol = getDb().collection("kb_documents");
  return docsCol.find({ kb_id: kbId }).sort({ ingested_at: -1 }).toArray() as unknown as Promise<
    KBDocument[]
  >;
}

/**
 * Remove a document record.
 */
export async function removeDocumentRecord(kbId: string, docName: string): Promise<boolean> {
  const docsCol = getDb().collection("kb_documents");
  const result = await docsCol.deleteOne({ kb_id: kbId, name: docName });
  return result.deletedCount > 0;
}

/**
 * Delete a knowledge base and all its document records.
 */
export async function deleteKB(kbId: string): Promise<boolean> {
  const docsCol = getDb().collection("kb_documents");
  await docsCol.deleteMany({ kb_id: kbId });
  const result = await kbCol().deleteOne({ kb_id: kbId });
  log.info("KB deleted", { kb_id: kbId });
  return result.deletedCount > 0;
}

/**
 * Ensure indexes on the kb_documents collection.
 */
export async function ensureKBDocumentIndexes(): Promise<void> {
  const docsCol = getDb().collection("kb_documents");
  await docsCol.createIndex({ kb_id: 1, name: 1 }, { unique: true, name: "idx_kb_doc_unique" });
}
