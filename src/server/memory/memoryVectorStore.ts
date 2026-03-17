/**
 * LanceDB wrapper for memory vector storage.
 *
 * Each owner gets their own LanceDB table named `mem_{owner_id}`.
 * Tables store memory embeddings for semantic search.
 */

import { existsSync, mkdirSync } from "node:fs";
import { type Connection, connect } from "@lancedb/lancedb";
import { createLogger } from "../../shared/logger.js";
import type { MemoryVectorRecord } from "../../shared/memoryTypes.js";

const log = createLogger("server:memory:vectorStore");

let db: Connection | null = null;

function tableName(ownerId: string): string {
  return `mem_${ownerId.replace(/-/g, "_")}`;
}

/**
 * Initialize the memory vector store connection.
 * Call once at server startup.
 */
export async function initMemoryVectorStore(storagePath: string): Promise<void> {
  if (!existsSync(storagePath)) {
    mkdirSync(storagePath, { recursive: true });
  }
  db = await connect(storagePath);
  log.info("Memory vector store initialized", { path: storagePath });
}

/**
 * Get the LanceDB connection. Throws if not initialized.
 */
function getDb(): Connection {
  if (!db) {
    throw new Error("Memory vector store not initialized. Call initMemoryVectorStore() first.");
  }
  return db;
}

export interface MemoryVectorSearchResult {
  id: string;
  owner: string;
  content: string;
  memory_type: string;
  tags: string;
  importance: number;
  created_at: string;
  updated_at: string;
  _distance: number;
}

/**
 * Add or update records in an owner's memory table.
 */
export async function addToMemoryTable(
  ownerId: string,
  records: MemoryVectorRecord[],
): Promise<void> {
  if (records.length === 0) return;

  const conn = getDb();
  const name = tableName(ownerId);

  const existing = await conn.tableNames();
  if (!existing.includes(name)) {
    await conn.createTable(name, records);
    log.info("Memory table created", { ownerId, records: records.length });
    return;
  }

  const table = await conn.openTable(name);
  await table.add(records);
  log.info("Records added to memory table", { ownerId, records: records.length });
}

/**
 * Search an owner's memory table by vector similarity.
 */
export async function searchMemoryTable(
  ownerId: string,
  queryVector: number[],
  limit: number,
): Promise<MemoryVectorSearchResult[]> {
  const conn = getDb();
  const name = tableName(ownerId);

  const existing = await conn.tableNames();
  if (!existing.includes(name)) {
    return [];
  }

  const table = await conn.openTable(name);
  const results = await table
    .vectorSearch(queryVector)
    .select([
      "id",
      "owner",
      "content",
      "memory_type",
      "tags",
      "importance",
      "created_at",
      "updated_at",
    ])
    .limit(limit)
    .toArray();

  return results.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    owner: r.owner as string,
    content: r.content as string,
    memory_type: r.memory_type as string,
    tags: (r.tags as string) || "[]",
    importance: (r.importance as number) ?? 0,
    created_at: (r.created_at as string) || "",
    updated_at: (r.updated_at as string) || "",
    _distance: (r._distance as number) ?? 1,
  }));
}

/**
 * Delete a specific memory record from the vector table.
 */
export async function deleteFromMemoryTable(ownerId: string, memoryId: string): Promise<void> {
  const conn = getDb();
  const name = tableName(ownerId);

  const existing = await conn.tableNames();
  if (!existing.includes(name)) return;

  const table = await conn.openTable(name);
  await table.delete(`id = '${memoryId.replace(/'/g, "''")}'`);
  log.info("Record deleted from memory table", { ownerId, memoryId });
}

/**
 * Drop an owner's entire memory table.
 */
export async function dropMemoryTable(ownerId: string): Promise<void> {
  const conn = getDb();
  const name = tableName(ownerId);

  const existing = await conn.tableNames();
  if (!existing.includes(name)) return;

  await conn.dropTable(name);
  log.info("Memory table dropped", { ownerId, name });
}

/**
 * Count records in an owner's memory table.
 */
export async function countMemoryTableRows(ownerId: string): Promise<number> {
  const conn = getDb();
  const name = tableName(ownerId);

  const existing = await conn.tableNames();
  if (!existing.includes(name)) return 0;

  const table = await conn.openTable(name);
  return table.countRows();
}

/**
 * Close the memory vector store connection.
 */
export async function closeMemoryVectorStore(): Promise<void> {
  if (db) {
    db.close();
    db = null;
    log.info("Memory vector store closed");
  }
}
