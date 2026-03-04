/**
 * MongoDB persistence for research sessions.
 * Stores completed sessions for history viewing and audit trail.
 */

import type { Collection, Db } from "mongodb";
import { createLogger } from "../../../shared/logger.js";
import type {
  ResearchSession,
  ResearchSessionStatus,
  ResearchStrategy,
} from "../../../shared/researchTypes.js";

const log = createLogger("server:kb:research:auditRepo");

let collection: Collection<ResearchSession> | null = null;

export async function initResearchSessionsCollection(db: Db): Promise<void> {
  collection = db.collection<ResearchSession>("research_sessions");
  await collection.createIndex({ session_id: 1 }, { unique: true });
  await collection.createIndex({ created_at: -1 });
  await collection.createIndex({ "config.strategy": 1 });
  await collection.createIndex({ status: 1 });
  await collection.createIndex({ "consumer.type": 1, "consumer.id": 1 });
  log.info("Research sessions collection initialized");
}

function getCollection(): Collection<ResearchSession> {
  if (!collection) {
    throw new Error(
      "Research sessions collection not initialized. Call initResearchSessionsCollection() first.",
    );
  }
  return collection;
}

export async function saveResearchSession(session: ResearchSession): Promise<void> {
  const col = getCollection();
  await col.updateOne({ session_id: session.session_id }, { $set: session }, { upsert: true });
  log.info("Research session saved", { session_id: session.session_id, status: session.status });
}

export async function findResearchSession(sessionId: string): Promise<ResearchSession | null> {
  const col = getCollection();
  return col.findOne({ session_id: sessionId }, { projection: { _id: 0 } });
}

export async function listResearchSessions(params: {
  limit?: number;
  offset?: number;
  strategy?: ResearchStrategy;
  status?: ResearchSessionStatus;
}): Promise<{ sessions: ResearchSession[]; total: number }> {
  const col = getCollection();
  const filter: Record<string, unknown> = {};
  if (params.strategy) filter["config.strategy"] = params.strategy;
  if (params.status) filter.status = params.status;

  const [sessions, total] = await Promise.all([
    col
      .find(filter, { projection: { _id: 0 } })
      .sort({ created_at: -1 })
      .skip(params.offset ?? 0)
      .limit(params.limit ?? 20)
      .toArray(),
    col.countDocuments(filter),
  ]);

  return { sessions, total };
}

export async function deleteResearchSession(sessionId: string): Promise<boolean> {
  const col = getCollection();
  const result = await col.deleteOne({ session_id: sessionId });
  return result.deletedCount > 0;
}
