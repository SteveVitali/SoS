/**
 * SQLite FTS5 wrapper for memory keyword search.
 *
 * Each owner gets their own SQLite database file named `mem_fts_{owner_id}.sqlite`.
 * The database contains a single FTS5 virtual table for full-text search using
 * BM25 ranking, porter stemming, and unicode61 tokenization.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createLogger } from "../../shared/logger.js";
import type { MemoryFTSRecord } from "../../shared/memoryTypes.js";

const log = createLogger("server:memory:ftsStore");

let storagePath: string | null = null;

/**
 * Map of open SQLite database handles, keyed by owner_id.
 */
const openDbs = new Map<string, InstanceType<typeof Database>>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeOwnerId(ownerId: string): string {
  return ownerId.replace(/-/g, "_");
}

function dbFilePath(ownerId: string): string {
  if (!storagePath) {
    throw new Error("Memory FTS store not initialized. Call initMemoryFtsStore() first.");
  }
  return join(storagePath, `mem_fts_${sanitizeOwnerId(ownerId)}.sqlite`);
}

/**
 * Open (or create) the SQLite database for an owner.
 * The FTS5 virtual table is created if it does not already exist.
 */
function getDb(ownerId: string): InstanceType<typeof Database> {
  const existing = openDbs.get(ownerId);
  if (existing) return existing;

  const filePath = dbFilePath(ownerId);
  const db = new Database(filePath);

  // WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");

  // Create the FTS5 virtual table if it doesn't exist.
  db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
			memory_id UNINDEXED,
			owner UNINDEXED,
			content,
			keywords,
			tags,
			memory_type UNINDEXED,
			tokenize='porter unicode61'
		);
	`);

  openDbs.set(ownerId, db);
  return db;
}

/**
 * Check whether an FTS index exists for a given owner.
 */
export function hasMemoryFTSIndex(ownerId: string): boolean {
  if (!storagePath) return false;
  return existsSync(dbFilePath(ownerId));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the memory FTS store. Call once at server startup.
 */
export function initMemoryFtsStore(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
  storagePath = path;
  log.info("Memory FTS store initialized", { path });
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

export interface MemoryFTSSearchResult {
  memory_id: string;
  owner: string;
  content: string;
  keywords: string;
  tags: string;
  memory_type: string;
  bm25_score: number;
}

/**
 * Insert records into the FTS index for an owner.
 */
export function addToMemoryFTS(ownerId: string, records: MemoryFTSRecord[]): void {
  if (records.length === 0) return;

  const db = getDb(ownerId);
  const insert = db.prepare(
    "INSERT INTO memories_fts (memory_id, owner, content, keywords, tags, memory_type) VALUES (?, ?, ?, ?, ?, ?)",
  );

  const insertMany = db.transaction((rows: MemoryFTSRecord[]) => {
    for (const row of rows) {
      insert.run(row.memory_id, row.owner, row.content, row.keywords, row.tags, row.memory_type);
    }
  });

  insertMany(records);
  log.info("Memory FTS records added", { ownerId, count: records.length });
}

/**
 * Delete a specific memory record from the FTS index.
 */
export function deleteFromMemoryFTS(ownerId: string, memoryId: string): void {
  if (!hasMemoryFTSIndex(ownerId)) return;

  const db = getDb(ownerId);
  db.prepare("DELETE FROM memories_fts WHERE memory_id = ?").run(memoryId);
  log.info("Memory FTS record deleted", { ownerId, memoryId });
}

/**
 * Drop the entire FTS index for an owner (deletes the .sqlite file).
 */
export function dropMemoryFTSIndex(ownerId: string): void {
  const db = openDbs.get(ownerId);
  if (db) {
    db.close();
    openDbs.delete(ownerId);
  }

  if (!storagePath) return;

  const filePath = dbFilePath(ownerId);
  if (existsSync(filePath)) {
    rmSync(filePath, { force: true });
    rmSync(`${filePath}-wal`, { force: true });
    rmSync(`${filePath}-shm`, { force: true });
    log.info("Memory FTS index dropped", { ownerId });
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Sanitize a user query for safe use in FTS5 MATCH expressions.
 */
export function sanitizeMemoryFTSQuery(query: string): string {
  const cleaned = query
    .replace(/[*"(){}[\]:^~]/g, " ")
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, " ")
    .trim();

  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return "";

  return tokens.map((t) => `"${t}"`).join(" OR ");
}

/**
 * Search the FTS index for an owner using BM25 ranking.
 */
export function searchMemoryFTS(
  ownerId: string,
  query: string,
  limit: number,
): MemoryFTSSearchResult[] {
  if (!hasMemoryFTSIndex(ownerId)) return [];

  const ftsQuery = sanitizeMemoryFTSQuery(query);
  if (!ftsQuery) return [];

  const db = getDb(ownerId);

  try {
    const rows = db
      .prepare(
        `SELECT memory_id, owner, content, keywords, tags, memory_type, bm25(memories_fts) AS score
				 FROM memories_fts
				 WHERE memories_fts MATCH ?
				 ORDER BY score ASC
				 LIMIT ?`,
      )
      .all(ftsQuery, limit) as Array<{
      memory_id: string;
      owner: string;
      content: string;
      keywords: string;
      tags: string;
      memory_type: string;
      score: number;
    }>;

    // Negate BM25 score so higher = more relevant
    return rows.map((row) => ({
      memory_id: row.memory_id,
      owner: row.owner,
      content: row.content,
      keywords: row.keywords,
      tags: row.tags,
      memory_type: row.memory_type,
      bm25_score: -row.score,
    }));
  } catch (err: unknown) {
    log.warn("Memory FTS search failed, returning empty results", {
      ownerId,
      query: query.slice(0, 100),
      error: (err as Error).message,
    });
    return [];
  }
}

/**
 * Count all FTS records for an owner.
 */
export function countMemoryFTSRows(ownerId: string): number {
  if (!hasMemoryFTSIndex(ownerId)) return 0;

  const db = getDb(ownerId);
  const result = db.prepare("SELECT count(*) AS cnt FROM memories_fts").get() as { cnt: number };
  return result.cnt;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Close all open SQLite database connections.
 */
export function closeMemoryFtsStore(): void {
  for (const [ownerId, db] of openDbs) {
    try {
      db.close();
    } catch (err: unknown) {
      log.warn("Failed to close memory FTS database", {
        ownerId,
        error: (err as Error).message,
      });
    }
  }
  openDbs.clear();
  storagePath = null;
  log.info("Memory FTS store closed");
}
