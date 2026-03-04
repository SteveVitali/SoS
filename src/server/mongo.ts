import { type Collection, type Db, MongoClient } from "mongodb";
import { createLogger } from "../shared/logger.js";
import type { JobDoc } from "../shared/types.js";
import { ensureConversationIndexes } from "./chat/conversationRepo.js";

const log = createLogger("server:mongo");

let client: MongoClient;
let db: Db;

export async function connectMongo(uri: string, dbName: string): Promise<Db> {
  client = new MongoClient(uri);
  await client.connect();
  db = client.db(dbName);
  log.info("Connected to MongoDB", { db: dbName });
  await ensureIndexes(db);
  await ensureConversationIndexes();
  return db;
}

export function getDb(): Db {
  if (!db) throw new Error("MongoDB not connected");
  return db;
}

export function getJobsCollection(): Collection<JobDoc> {
  return getDb().collection<JobDoc>("jobs");
}

async function ensureIndexes(db: Db) {
  const col = db.collection("jobs");

  await col.createIndex(
    { "source.event_id": 1 },
    {
      unique: true,
      partialFilterExpression: { "source.event_id": { $exists: true } },
      name: "idx_source_event_id_unique",
    },
  );

  await col.createIndex({ task_id: 1 }, { unique: true, name: "idx_task_id_unique" });

  await col.createIndex(
    { requested_by: 1, status: 1, created_at: -1 },
    { name: "idx_requested_by_status_created" },
  );

  await col.createIndex({ status: 1, lease_expires_at: 1 }, { name: "idx_status_lease" });

  log.info("Indexes ensured");
}

export async function closeMongo() {
  if (client) {
    await client.close();
    log.info("MongoDB connection closed");
  }
}

/** Test-only: inject an external Db instance (e.g. from MongoMemoryServer). */
export function _setTestDb(testDb: Db) {
  db = testDb;
}
