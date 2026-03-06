/**
 * LanceDB wrapper for knowledge base vector storage.
 *
 * Each knowledge base gets its own LanceDB table named `kb_{kb_id}`.
 * Tables store chunks with their embedding vectors for semantic search.
 */

import { existsSync, mkdirSync } from "node:fs";
import { type Connection, connect } from "@lancedb/lancedb";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("server:kb:vectorStore");

let db: Connection | null = null;
let dbPath: string | null = null;

function tableName(kbId: string): string {
  return `kb_${kbId.replace(/-/g, "_")}`;
}

/**
 * Initialize the vector store connection.
 * Call once at server startup.
 */
export async function initVectorStore(storagePath: string): Promise<void> {
  if (!existsSync(storagePath)) {
    mkdirSync(storagePath, { recursive: true });
  }
  dbPath = storagePath;
  db = await connect(storagePath);
  log.info("Vector store initialized", { path: storagePath });
}

/**
 * Get the LanceDB connection. Throws if not initialized.
 */
function getDb(): Connection {
  if (!db) {
    throw new Error("Vector store not initialized. Call initVectorStore() first.");
  }
  return db;
}

export interface VectorRecord {
  [key: string]: unknown;
  id: string;
  kb_id: string;
  source_file: string;
  content: string;
  vector: number[];
  section: string;
  page: number;
  file_path: string;
  parent_dir: string;
  created_at: string;
  level: number; // 0 = raw chunk, 1+ = RAPTOR summary level
  children_ids: string; // JSON-encoded string[] of child node IDs (empty for level 0)
}

export interface VectorSearchResult {
  id: string;
  kb_id: string;
  source_file: string;
  content: string;
  section: string;
  page: number;
  file_path: string;
  parent_dir: string;
  created_at: string;
  level: number;
  children_ids: string;
  _distance: number;
}

/**
 * Create a new table for a knowledge base, or overwrite if it exists.
 */
export async function createKBTable(kbId: string, records: VectorRecord[]): Promise<void> {
  const conn = getDb();
  const name = tableName(kbId);

  if (records.length === 0) {
    log.warn("No records to create table with", { kbId });
    return;
  }

  const existing = await conn.tableNames();
  if (existing.includes(name)) {
    await conn.dropTable(name);
  }

  await conn.createTable(name, records);
  log.info("KB table created", { kbId, name, records: records.length });
}

/**
 * Add records to an existing KB table.
 */
export async function addToKBTable(kbId: string, records: VectorRecord[]): Promise<void> {
  if (records.length === 0) return;

  const conn = getDb();
  const name = tableName(kbId);

  const existing = await conn.tableNames();
  if (!existing.includes(name)) {
    // Table doesn't exist yet — create it
    await conn.createTable(name, records);
    log.info("KB table created (via add)", { kbId, records: records.length });
    return;
  }

  const table = await conn.openTable(name);
  await table.add(records);
  log.info("Records added to KB table", { kbId, records: records.length });
}

/**
 * Search a KB table by vector similarity.
 */
export async function searchKBTable(
  kbId: string,
  queryVector: number[],
  limit: number,
): Promise<VectorSearchResult[]> {
  const conn = getDb();
  const name = tableName(kbId);

  const existing = await conn.tableNames();
  if (!existing.includes(name)) {
    return [];
  }

  const table = await conn.openTable(name);
  const results = await table
    .vectorSearch(queryVector)
    .select([
      "id",
      "kb_id",
      "source_file",
      "content",
      "section",
      "page",
      "file_path",
      "parent_dir",
      "created_at",
      "level",
      "children_ids",
    ])
    .limit(limit)
    .toArray();

  return results.map((r: any) => ({
    id: r.id,
    kb_id: r.kb_id,
    source_file: r.source_file,
    content: r.content,
    section: r.section || "",
    page: r.page || 0,
    file_path: r.file_path || "",
    parent_dir: r.parent_dir || "",
    created_at: r.created_at || "",
    level: r.level ?? 0,
    children_ids: r.children_ids || "[]",
    _distance: r._distance ?? 1,
  }));
}

/**
 * Delete all records for a specific source file from a KB table.
 */
export async function deleteDocumentFromKBTable(kbId: string, sourceFile: string): Promise<void> {
  const conn = getDb();
  const name = tableName(kbId);

  const existing = await conn.tableNames();
  if (!existing.includes(name)) return;

  const table = await conn.openTable(name);
  await table.delete(`source_file = '${sourceFile.replace(/'/g, "''")}'`);
  log.info("Document deleted from KB table", { kbId, sourceFile });
}

/**
 * Drop an entire KB table.
 */
export async function dropKBTable(kbId: string): Promise<void> {
  const conn = getDb();
  const name = tableName(kbId);

  const existing = await conn.tableNames();
  if (!existing.includes(name)) return;

  await conn.dropTable(name);
  log.info("KB table dropped", { kbId, name });
}

/**
 * Count records in a KB table.
 */
export async function countKBTableRows(kbId: string): Promise<number> {
  const conn = getDb();
  const name = tableName(kbId);

  const existing = await conn.tableNames();
  if (!existing.includes(name)) return 0;

  const table = await conn.openTable(name);
  return table.countRows();
}

/**
 * Count records for a specific source file.
 */
export async function countDocumentRows(kbId: string, sourceFile: string): Promise<number> {
  const conn = getDb();
  const name = tableName(kbId);

  const existing = await conn.tableNames();
  if (!existing.includes(name)) return 0;

  const table = await conn.openTable(name);
  return table.countRows(`source_file = '${sourceFile.replace(/'/g, "''")}'`);
}

export interface ChunkRecord {
  id: string;
  content: string;
  section: string;
  page: number;
  file_path: string;
  parent_dir: string;
  created_at: string;
}

/**
 * List chunks for a specific document with pagination.
 */
export async function listDocumentChunks(
  kbId: string,
  sourceFile: string,
  offset: number,
  limit: number,
): Promise<{ chunks: ChunkRecord[]; total: number }> {
  const conn = getDb();
  const name = tableName(kbId);

  const existing = await conn.tableNames();
  if (!existing.includes(name)) return { chunks: [], total: 0 };

  const table = await conn.openTable(name);
  const filter = `source_file = '${sourceFile.replace(/'/g, "''")}'`;

  const total = await table.countRows(filter);

  const rows = await table
    .query()
    .select(["id", "content", "section", "page", "file_path", "parent_dir", "created_at"])
    .where(filter)
    .limit(limit + offset)
    .toArray();

  // LanceDB doesn't support offset natively — slice in memory
  const chunks = rows.slice(offset, offset + limit).map((r: any) => ({
    id: r.id,
    content: r.content,
    section: r.section || "",
    page: r.page || 0,
    file_path: r.file_path || "",
    parent_dir: r.parent_dir || "",
    created_at: r.created_at || "",
  }));

  return { chunks, total };
}

/**
 * List RAPTOR tree nodes from a KB table.
 * Returns all summary nodes (level > 0) plus the L0 chunks that are direct
 * children of L1 nodes, so the tree is fully expandable in the UI.
 */
export async function listRaptorNodes(kbId: string): Promise<
  Array<{
    id: string;
    level: number;
    children_ids: string[];
    content: string;
    source_file: string;
    section: string;
  }>
> {
  const conn = getDb();
  const name = tableName(kbId);

  const existing = await conn.tableNames();
  if (!existing.includes(name)) return [];

  const table = await conn.openTable(name);

  // Fetch all RAPTOR summary nodes (level > 0).
  // Wrapped in try-catch because older KB tables may not have the `level` column.
  let summaryResults: Array<{
    id: string;
    source_file: string;
    content: string;
    section: string;
    level: number;
    children_ids: string;
  }>;
  try {
    summaryResults = await table
      .query()
      .select(["id", "source_file", "content", "section", "level", "children_ids"])
      .where("level > 0")
      .limit(10000)
      .toArray();
  } catch {
    // Table predates RAPTOR — no level column
    return [];
  }

  const parsed = summaryResults.map((r) => {
    let childIds: string[] = [];
    try {
      childIds = JSON.parse(r.children_ids || "[]");
    } catch {
      childIds = [];
    }
    return {
      id: r.id,
      level: r.level,
      children_ids: childIds,
      content: r.content || "",
      source_file: r.source_file || "",
      section: r.section || "",
    };
  });

  // Collect L0 child IDs referenced by L1 nodes
  const summaryIdSet = new Set(parsed.map((n) => n.id));
  const missingChildIds = new Set<string>();
  for (const node of parsed) {
    if (node.level === 1) {
      for (const cid of node.children_ids) {
        if (!summaryIdSet.has(cid)) missingChildIds.add(cid);
      }
    }
  }

  // Fetch L0 chunks by ID if any are needed
  if (missingChildIds.size > 0) {
    try {
      const l0Results: Array<{
        id: string;
        source_file: string;
        content: string;
        section: string;
        level: number;
        children_ids: string;
      }> = await table
        .query()
        .select(["id", "source_file", "content", "section", "level", "children_ids"])
        .where("level = 0")
        .limit(10000)
        .toArray();

      for (const r of l0Results) {
        if (missingChildIds.has(r.id)) {
          parsed.push({
            id: r.id,
            level: 0,
            children_ids: [],
            content: r.content || "",
            source_file: r.source_file || "",
            section: r.section || "",
          });
        }
      }
    } catch {
      // L0 fetch failed — tree will just not show L0 leaf nodes
    }
  }

  return parsed;
}

/**
 * List all chunks from a KB table with fields needed for FTS indexing.
 * Used during FTS index rebuild for existing KBs that predate hybrid search.
 */
export async function listAllChunksForFTS(kbId: string): Promise<
  Array<{
    id: string;
    kb_id: string;
    source_file: string;
    content: string;
    section: string;
    page: number;
    file_path: string;
    parent_dir: string;
  }>
> {
  const conn = getDb();
  const name = tableName(kbId);

  const existing = await conn.tableNames();
  if (!existing.includes(name)) return [];

  const table = await conn.openTable(name);
  const MAX_CHUNKS = 1_000_000;
  const rows = await table
    .query()
    .select(["id", "kb_id", "source_file", "content", "section", "page", "file_path", "parent_dir"])
    .where("level = 0") // Only raw chunks, not RAPTOR summaries
    .limit(MAX_CHUNKS)
    .toArray();

  if (rows.length === MAX_CHUNKS) {
    log.warn("listAllChunksForFTS hit row limit — FTS rebuild may be incomplete", {
      kbId,
      limit: MAX_CHUNKS,
    });
  }

  return rows.map((r: any) => ({
    id: r.id,
    kb_id: r.kb_id,
    source_file: r.source_file,
    content: r.content,
    section: r.section ?? "",
    page: r.page ?? 0,
    file_path: r.file_path ?? "",
    parent_dir: r.parent_dir ?? "",
  }));
}

/**
 * Get the storage path for the vector store.
 */
export function getVectorStorePath(): string | null {
  return dbPath;
}

/**
 * Close the vector store connection.
 */
export async function closeVectorStore(): Promise<void> {
  if (db) {
    db.close();
    db = null;
    log.info("Vector store closed");
  }
}
