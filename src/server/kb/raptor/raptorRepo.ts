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

export async function getBatchRaptorStatus(kbIds: string[]): Promise<Record<string, RaptorStatus>> {
  if (kbIds.length === 0) return {};
  const docs = await col()
    .find({ kb_id: { $in: kbIds } })
    .toArray();
  const result: Record<string, RaptorStatus> = {};
  for (const doc of docs) {
    result[doc.kb_id] = doc.status;
  }
  return result;
}

/**
 * Reset any RAPTOR builds that were in progress when the server was killed.
 * Called once at server startup — clears building=true flags so the UI
 * doesn't show a perpetual "Starting" / "Building" state.
 */
export async function resetStaleBuildingStatuses(): Promise<number> {
  const result = await col().updateMany(
    { "status.building": true },
    {
      $set: {
        "status.building": false,
        "status.error_message": "Build interrupted by server restart",
      },
      $unset: {
        "status.phase": "",
        "status.current_level": "",
        "status.estimated_total_levels": "",
        "status.clusters_completed": "",
        "status.clusters_total": "",
        "status.build_started_at": "",
      },
      $currentDate: { updated_at: true },
    },
  );
  const count = result.modifiedCount;
  if (count > 0) {
    log.warn("Reset stale RAPTOR builds", { count });
  }
  return count;
}

export async function deleteRaptorStatus(kbId: string): Promise<void> {
  await col().deleteOne({ kb_id: kbId });
}
