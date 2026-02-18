import type { JobDoc } from "../../shared/types.js";
import { findJobByEventId } from "./jobRepo.js";

export async function checkIdempotent(eventId: string): Promise<JobDoc | null> {
  return findJobByEventId(eventId);
}
