/**
 * MongoDB persistence for RAPTOR tree metadata.
 * Stores build status per KB.
 */

import { createLogger } from "../../../shared/logger.js";
import type { RaptorStatus } from "../../../shared/researchTypes.js";
import { getDb } from "../../mongo.js";

const log = createLogger("server:kb:raptor:repo");

interface RaptorDoc {
  kb_id: string;
  status: RaptorStatus;
  updated_at: Date;
}

function col() {
  return getDb().collection<RaptorDoc>("raptor_trees");
}

export async function ensureRaptorIndexes(): Promise<void> {
  await col().createIndex({ kb_id: 1 }, { unique: true });
  log.info("RAPTOR indexes ensured");
}

export async function saveRaptorStatus(kbId: string, status: RaptorStatus): Promise<void> {
  await col().updateOne(
    { kb_id: kbId },
    { $set: { kb_id: kbId, status, updated_at: new Date() } },
    { upsert: true },
  );
  log.info("RAPTOR status saved", { kbId, built: status.built, levels: status.levels });
}

export async function getRaptorStatus(kbId: string): Promise<RaptorStatus | null> {
  const doc = await col().findOne({ kb_id: kbId });
  return doc?.status ?? null;
}

export async function deleteRaptorStatus(kbId: string): Promise<void> {
  await col().deleteOne({ kb_id: kbId });
}
