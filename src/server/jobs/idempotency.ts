import { findJobByEventId } from "./jobRepo.js";
import type { JobDoc } from "../../shared/types.js";

export async function checkIdempotent(eventId: string): Promise<JobDoc | null> {
  return findJobByEventId(eventId);
}
