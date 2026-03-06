/**
 * SQLite FTS5 wrapper for knowledge base keyword search.
 *
 * Each knowledge base gets its own SQLite database file named `fts_{kb_id}.sqlite`.
 * The database contains a single FTS5 virtual table for full-text search using
 * BM25 ranking, porter stemming, and unicode61 tokenization.
 *
 * This module is the keyword-search counterpart to vectorStore.ts (which handles
 * semantic/vector search via LanceDB). Both indexes reference the same chunks by
 * their shared `chunk_id`.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("server:kb:ftsStore");

let storagePath: string | null = null;

/**
 * Map of open SQLite database handles, keyed by kb_id.
 * Databases are opened lazily on first access and cached for reuse.
 */
const openDbs = new Map<string, InstanceType<typeof Database>>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeKbId(kbId: string): string {
  return kbId.replace(/-/g, "_");
}

function dbFilePath(kbId: string): string {
  if (!storagePath) {
    throw new Error("FTS store not initialized. Call initFTSStore() first.");
  }
  return join(storagePath, `fts_${sanitizeKbId(kbId)}.sqlite`);
}

/**
 * Open (or create) the SQLite database for a knowledge base.
 * The FTS5 virtual table is created if it does not already exist.
 */
function getDb(kbId: string): InstanceType<typeof Database> {
  const existing = openDbs.get(kbId);
  if (existing) return existing;

  const filePath = dbFilePath(kbId);
  const db = new Database(filePath);

  // WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");

  // Create the FTS5 virtual table if it doesn't exist.
  // chunk_id, kb_id, and source_file are UNINDEXED — stored but not searchable.
  // Only the `content` column is indexed for full-text search.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      chunk_id UNINDEXED,
      kb_id UNINDEXED,
      source_file UNINDEXED,
      content,
      tokenize='porter unicode61'
    );
  `);

  openDbs.set(kbId, db);
  return db;
}

/**
 * Check whether an FTS index exists for a given KB (without creating one).
 */
export function hasFTSIndex(kbId: string): boolean {
  if (!storagePath) return false;
  return existsSync(dbFilePath(kbId));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the FTS store. Call once at server startup.
 */
export function initFTSStore(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
  storagePath = path;
  log.info("FTS store initialized", { path });
}

/**
 * Get the storage path for the FTS store.
 */
export function getFTSStorePath(): string | null {
  return storagePath;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface FTSRecord {
  chunk_id: string;
  kb_id: string;
  source_file: string;
  content: string;
}

export interface FTSSearchResult {
  chunk_id: string;
  kb_id: string;
  source_file: string;
  content: string;
  bm25_score: number;
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Insert chunks into the FTS index for a knowledge base.
 */
export function addToFTSIndex(kbId: string, records: FTSRecord[]): void {
  if (records.length === 0) return;

  const db = getDb(kbId);
  const insert = db.prepare(
    "INSERT INTO chunks_fts (chunk_id, kb_id, source_file, content) VALUES (?, ?, ?, ?)",
  );

  const insertMany = db.transaction((rows: FTSRecord[]) => {
    for (const row of rows) {
      insert.run(row.chunk_id, row.kb_id, row.source_file, row.content);
    }
  });

  insertMany(records);
  log.info("FTS records added", { kbId, count: records.length });
}

/**
 * Delete all FTS records for a specific source file from a KB's index.
 */
export function deleteDocumentFromFTS(kbId: string, sourceFile: string): void {
  if (!hasFTSIndex(kbId)) return;

  const db = getDb(kbId);
  db.prepare("DELETE FROM chunks_fts WHERE source_file = ?").run(sourceFile);
  log.info("FTS document deleted", { kbId, sourceFile });
}

/**
 * Drop the entire FTS index for a knowledge base (deletes the .sqlite file).
 */
export function dropFTSIndex(kbId: string): void {
  // Close the cached connection first
  const db = openDbs.get(kbId);
  if (db) {
    db.close();
    openDbs.delete(kbId);
  }

  if (!storagePath) return;

  const filePath = dbFilePath(kbId);
  if (existsSync(filePath)) {
    rmSync(filePath, { force: true });
    // Also remove WAL and SHM files if they exist
    rmSync(`${filePath}-wal`, { force: true });
    rmSync(`${filePath}-shm`, { force: true });
    log.info("FTS index dropped", { kbId });
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Sanitize a user query for safe use in FTS5 MATCH expressions.
 * Strips FTS5 operators and special characters, then joins remaining
 * tokens with implicit OR (space-separated in FTS5 = implicit AND,
 * but we wrap in OR for broader recall).
 */
export function sanitizeFTSQuery(query: string): string {
  // Remove FTS5 special characters and operators
  const cleaned = query
    .replace(/[*"(){}[\]:^~]/g, " ")
    // Remove standalone boolean operators (case-insensitive)
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, " ")
    .trim();

  // Tokenize and filter empty tokens
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0);

  if (tokens.length === 0) return "";

  // Join with OR for broad recall — we let BM25 handle ranking
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

/**
 * Search the FTS index for a knowledge base using BM25 ranking.
 *
 * Returns results sorted by relevance (lower bm25 = more relevant in SQLite,
 * but we negate the score so higher = better to match vector search convention).
 */
export function searchFTS(kbId: string, query: string, limit: number): FTSSearchResult[] {
  if (!hasFTSIndex(kbId)) return [];

  const ftsQuery = sanitizeFTSQuery(query);
  if (!ftsQuery) return [];

  const db = getDb(kbId);

  try {
    const rows = db
      .prepare(
        `SELECT chunk_id, kb_id, source_file, content, bm25(chunks_fts) AS score
         FROM chunks_fts
         WHERE chunks_fts MATCH ?
         ORDER BY score ASC
         LIMIT ?`,
      )
      .all(ftsQuery, limit) as Array<{
      chunk_id: string;
      kb_id: string;
      source_file: string;
      content: string;
      score: number;
    }>;

    // Negate BM25 score so higher = more relevant (matches vector search convention)
    return rows.map((row) => ({
      chunk_id: row.chunk_id,
      kb_id: row.kb_id,
      source_file: row.source_file,
      content: row.content,
      bm25_score: -row.score,
    }));
  } catch (err: unknown) {
    log.warn("FTS search failed, returning empty results", {
      kbId,
      query: query.slice(0, 100),
      error: (err as Error).message,
    });
    return [];
  }
}

/**
 * Count all FTS records for a knowledge base.
 */
export function countFTSRows(kbId: string): number {
  if (!hasFTSIndex(kbId)) return 0;

  const db = getDb(kbId);
  const result = db.prepare("SELECT count(*) AS cnt FROM chunks_fts").get() as { cnt: number };
  return result.cnt;
}

/**
 * Rebuild the FTS index for a KB from an array of records.
 * Used for migrating existing KBs that predate the FTS feature.
 */
export function rebuildFTSIndex(kbId: string, records: FTSRecord[]): void {
  // Drop existing index if any
  dropFTSIndex(kbId);

  if (records.length === 0) return;

  // Re-create and populate
  addToFTSIndex(kbId, records);
  log.info("FTS index rebuilt", { kbId, records: records.length });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Close all open SQLite database connections.
 */
export function closeFTSStore(): void {
  for (const [kbId, db] of openDbs) {
    try {
      db.close();
    } catch (err: unknown) {
      log.warn("Failed to close FTS database", { kbId, error: (err as Error).message });
    }
  }
  openDbs.clear();
  log.info("FTS store closed");
}
