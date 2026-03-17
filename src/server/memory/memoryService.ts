/**
 * Memory system orchestration.
 *
 * Manages initialization, shutdown, and the public API for the memory system.
 * All write operations are fire-and-forget from the interaction hot path.
 */

import path from "node:path";
import { createLogger } from "../../shared/logger.js";
import type {
  InteractionEpisode,
  InteractionSource,
  MemoryConfig,
} from "../../shared/memoryTypes.js";
import type { ServerConfig } from "../config.js";
import { ensureEpisodeIndexes } from "./episodeRepo.js";
import { loadMemoryConfig } from "./memoryConfig.js";
import { closeMemoryFtsStore, initMemoryFtsStore } from "./memoryFtsStore.js";
import { ensureMemoryNoteIndexes } from "./memoryRepo.js";
import { closeMemoryVectorStore, initMemoryVectorStore } from "./memoryVectorStore.js";
import { recordEpisode } from "./pipelines/episodeRecorder.js";

const log = createLogger("server:memory:service");

let memoryConfig: MemoryConfig | null = null;
let initialized = false;

/**
 * Ensure all memory-related MongoDB indexes exist.
 * Called from mongo.ts during connection setup.
 */
export async function ensureMemoryIndexes(): Promise<void> {
  await ensureMemoryNoteIndexes();
  await ensureEpisodeIndexes();
}

/**
 * Initialize the memory system.
 * Sets up vector store, FTS store, and loads configuration.
 */
export async function initMemorySystem(config: ServerConfig): Promise<void> {
  memoryConfig = loadMemoryConfig();

  if (!memoryConfig.enabled) {
    log.info("Memory system disabled via config");
    return;
  }

  // Determine storage path for vector and FTS stores
  const storagePath =
    process.env.SOS_MEMORY_STORAGE_DIR ||
    (config.workspaceRoot
      ? path.join(config.workspaceRoot, "memory")
      : path.join(process.cwd(), ".sos-memory"));

  // Initialize vector store
  await initMemoryVectorStore(storagePath);

  // Initialize FTS store
  initMemoryFtsStore(storagePath);

  initialized = true;
  log.info("Memory system initialized", { storagePath });
}

/**
 * Shutdown the memory system.
 * Closes vector store and FTS store connections.
 */
export async function shutdownMemorySystem(): Promise<void> {
  closeMemoryFtsStore();
  try {
    await closeMemoryVectorStore();
  } catch (err) {
    log.warn("Error closing memory vector store", { error: (err as Error).message });
  }
  initialized = false;
  log.info("Memory system shut down");
}

/**
 * Called after every interaction completes.
 * Records the episode asynchronously (Pipeline A).
 */
export async function onInteractionComplete(params: {
  owner: string;
  source: InteractionSource;
  sourceRef: InteractionEpisode["source_ref"];
  userMessage: string;
  routedAction: string;
  actionArgs: Record<string, unknown>;
  responseSummary: string;
  taskId?: string;
  researchSessionId?: string;
}): Promise<void> {
  if (!memoryConfig?.enabled) return;

  await recordEpisode(params);
}

/**
 * Get memory context for injection into the system prompt.
 * Phase 1 stub: returns empty strings. Phase 2 will implement real retrieval.
 */
export async function getMemoryContext(
  _userMessage: string,
  _owner: string,
): Promise<{ memoryContext: string; userContext: string }> {
  if (!memoryConfig?.enabled || !initialized) {
    return { memoryContext: "", userContext: "" };
  }

  // Phase 1 stub — returns empty context
  return { memoryContext: "", userContext: "" };
}
