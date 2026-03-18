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
import { buildMemoryContext, buildUserContext } from "./contextBuilder.js";
import { countEpisodes, ensureEpisodeIndexes, listEpisodes } from "./episodeRepo.js";
import { loadMemoryConfig } from "./memoryConfig.js";
import { closeMemoryFtsStore, initMemoryFtsStore } from "./memoryFtsStore.js";
import { ensureMemoryNoteIndexes } from "./memoryRepo.js";
import { closeMemoryVectorStore, initMemoryVectorStore } from "./memoryVectorStore.js";
import { recordEpisode } from "./pipelines/episodeRecorder.js";
import { extractFactsFromEpisode } from "./pipelines/factExtractor.js";
import { getLastReflectionTimestamp, runReflection } from "./pipelines/reflectionEngine.js";
import { collectSignals } from "./pipelines/signalCollector.js";

const log = createLogger("server:memory:service");

let memoryConfig: MemoryConfig | null = null;
let initialized = false;
let signalCollectionInterval: ReturnType<typeof setInterval> | null = null;
let reflectionCheckInterval: ReturnType<typeof setInterval> | null = null;

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

  // Start signal collection timer (every 2 minutes)
  const SIGNAL_COLLECTION_INTERVAL_MS = 2 * 60 * 1000;
  signalCollectionInterval = setInterval(() => {
    if (!memoryConfig?.enabled || !initialized) return;
    collectSignals(memoryConfig).catch((err) => {
      log.warn("Signal collection failed", { error: (err as Error).message });
    });
  }, SIGNAL_COLLECTION_INTERVAL_MS);

  // Start reflection scheduler (check every 15 minutes if reflection should run)
  const REFLECTION_CHECK_INTERVAL_MS = 15 * 60 * 1000;
  reflectionCheckInterval = setInterval(() => {
    if (!memoryConfig?.enabled || !initialized || !memoryConfig.reflection_enabled) return;
    checkAndRunReflection(memoryConfig).catch((err) => {
      log.warn("Reflection check failed", { error: (err as Error).message });
    });
  }, REFLECTION_CHECK_INTERVAL_MS);

  log.info("Memory system initialized", { storagePath });
}

/**
 * Shutdown the memory system.
 * Closes vector store and FTS store connections.
 */
export async function shutdownMemorySystem(): Promise<void> {
  // Clear signal collection and reflection timers
  if (signalCollectionInterval) {
    clearInterval(signalCollectionInterval);
    signalCollectionInterval = null;
  }
  if (reflectionCheckInterval) {
    clearInterval(reflectionCheckInterval);
    reflectionCheckInterval = null;
  }

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
 * Records the episode (Pipeline A) then triggers fact extraction (Pipeline B)
 * as fire-and-forget.
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

  const episodeId = await recordEpisode(params);

  // Pipeline B: extract facts asynchronously (fire-and-forget)
  if (memoryConfig && initialized) {
    extractFactsFromEpisode(episodeId, memoryConfig).catch((err) => {
      log.warn("Fact extraction failed", {
        episodeId,
        error: (err as Error).message,
      });
    });
  }
}

/**
 * Check if enough time and episodes have passed to warrant running reflection.
 * If so, runs reflection for all known owners (based on recent episodes).
 */
async function checkAndRunReflection(config: MemoryConfig): Promise<void> {
  // Get distinct owners from recent episodes
  const { episodes } = await listEpisodes({ limit: 50 });
  const owners = [...new Set(episodes.map((ep) => ep.owner))];

  for (const owner of owners) {
    const lastReflection = await getLastReflectionTimestamp(owner);
    const now = new Date();

    // Check if enough time has elapsed
    if (lastReflection) {
      const hoursSinceLastReflection =
        (now.getTime() - lastReflection.getTime()) / (1000 * 60 * 60);
      if (hoursSinceLastReflection < config.reflection_interval_hours) {
        continue;
      }
    }

    // Check if enough episodes exist
    const totalEpisodes = await countEpisodes(owner);
    if (totalEpisodes < config.reflection_min_episodes) {
      continue;
    }

    runReflection(owner, config).catch((err) => {
      log.warn("Reflection failed", { owner, error: (err as Error).message });
    });
  }
}

/**
 * Get memory context for injection into the system prompt.
 * Calls real hybrid search and user profile retrieval.
 */
export async function getMemoryContext(
  userMessage: string,
  owner: string,
): Promise<{ memoryContext: string; userContext: string }> {
  if (!memoryConfig?.enabled || !initialized) {
    return { memoryContext: "", userContext: "" };
  }

  const [memoryContext, userContext] = await Promise.all([
    buildMemoryContext(userMessage, owner, memoryConfig),
    buildUserContext(owner),
  ]);

  return { memoryContext, userContext };
}
