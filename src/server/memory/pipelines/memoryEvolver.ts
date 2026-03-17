/**
 * Pipeline E: Memory Evolution (A-MEM style)
 *
 * When a memory is created or updated, find nearby memories and:
 * 1. Create bidirectional links between related memories
 * 2. Optionally evolve neighbor context/keywords/tags via LLM
 * 3. Re-embed evolved neighbors
 *
 * See §6.5 of the memory design spec.
 */

import { createLogger } from "../../../shared/logger.js";
import type { MemoryConfig, MemoryNote } from "../../../shared/memoryTypes.js";
import { getModelForRole } from "../../../shared/modelConfig.js";
import { getEmbeddingProvider } from "../../kb/embeddings.js";
import { createResearchLLMClient, type LLMClient } from "../../kb/research/llmClient.js";
import { addToMemoryFTS, deleteFromMemoryFTS } from "../memoryFtsStore.js";
import { findMemory, updateMemory } from "../memoryRepo.js";
import { addToMemoryTable, searchMemoryTable } from "../memoryVectorStore.js";
import { buildMemoryEvolutionPrompt } from "../prompts.js";

const log = createLogger("server:memory:evolver");

/**
 * Convert LanceDB L2 distance to a 0-1 similarity score.
 */
function distanceToSimilarity(distance: number): number {
  return 1 / (1 + distance);
}

export interface EvolutionDecision {
  memory_id: string;
  create_link: boolean;
  link_reason: string;
  update_context: string | null;
  update_keywords: string[] | null;
  update_tags: string[] | null;
}

/**
 * Create a memory LLM client for evolution calls.
 */
function createMemoryLLMClient(): LLMClient {
  return createResearchLLMClient({
    model: getModelForRole("memory"),
  });
}

/**
 * Build the embedding text for a memory note.
 */
function buildEmbeddingText(memory: MemoryNote): string {
  return `${memory.content} ${memory.context} ${memory.keywords.join(" ")}`;
}

/**
 * Evolve a memory by finding neighbors, creating links, and optionally
 * updating neighbor context/keywords/tags.
 */
export async function evolveMemory(
  memoryId: string,
  config: MemoryConfig,
): Promise<{ links_created: number; neighbors_evolved: number }> {
  if (!config.evolution_enabled) {
    return { links_created: 0, neighbors_evolved: 0 };
  }

  // Fetch the target memory
  const memory = await findMemory(memoryId);
  if (!memory) {
    log.warn("Cannot evolve non-existent memory", { memoryId });
    return { links_created: 0, neighbors_evolved: 0 };
  }

  // Embed the memory to find neighbors
  const embeddingProvider = getEmbeddingProvider();
  let queryVector: number[];
  try {
    [queryVector] = await embeddingProvider.embed([memory.embedding_text]);
  } catch (err) {
    log.warn("Failed to embed memory for evolution", { error: (err as Error).message });
    return { links_created: 0, neighbors_evolved: 0 };
  }

  // Find top-K nearest memories
  const maxNeighbors = config.evolution_max_neighbors;
  const vectorResults = await searchMemoryTable(
    memory.owner,
    queryVector,
    maxNeighbors + 1, // +1 because we may find ourselves
  );

  // Filter out self and by threshold
  const threshold = config.evolution_link_threshold;
  const qualifyingNeighbors: Array<{
    memoryId: string;
    similarity: number;
  }> = [];

  for (const r of vectorResults) {
    if (r.id === memoryId) continue;
    const similarity = distanceToSimilarity(r._distance);
    if (similarity >= threshold) {
      qualifyingNeighbors.push({ memoryId: r.id, similarity });
    }
  }

  if (qualifyingNeighbors.length === 0) {
    return { links_created: 0, neighbors_evolved: 0 };
  }

  // Fetch full neighbor documents
  const neighborDocs: MemoryNote[] = [];
  for (const n of qualifyingNeighbors) {
    const doc = await findMemory(n.memoryId);
    if (doc && !doc.invalidated_at) {
      neighborDocs.push(doc);
    }
  }

  if (neighborDocs.length === 0) {
    return { links_created: 0, neighbors_evolved: 0 };
  }

  // Check for near-duplicates (similarity > 0.9) — link only, skip LLM
  const highSimNeighbors = qualifyingNeighbors.filter((n) => n.similarity > 0.9);
  const needsLLM = neighborDocs.filter(
    (doc) => !highSimNeighbors.some((h) => h.memoryId === doc.memory_id),
  );

  let decisions: EvolutionDecision[] = [];

  // For near-duplicates, auto-create links without LLM
  for (const doc of neighborDocs) {
    const isHighSim = highSimNeighbors.some((h) => h.memoryId === doc.memory_id);
    if (isHighSim) {
      decisions.push({
        memory_id: doc.memory_id,
        create_link: true,
        link_reason: "High similarity (near-duplicate)",
        update_context: null,
        update_keywords: null,
        update_tags: null,
      });
    }
  }

  // For remaining neighbors, call LLM
  if (needsLLM.length > 0) {
    try {
      const llm = createMemoryLLMClient();
      const prompt = buildMemoryEvolutionPrompt({
        new_memory_content: memory.content,
        keywords: memory.keywords,
        tags: memory.tags,
        neighbors: needsLLM.map((n) => ({
          memory_id: n.memory_id,
          content: n.content,
          context: n.context,
          keywords: n.keywords,
        })),
      });

      const response = await llm.chat(
        [
          { role: "system", content: prompt },
          { role: "user", content: "Analyze the neighbors and return decisions." },
        ],
        { json_mode: true },
      );

      const parsed = JSON.parse(response.content) as {
        decisions: EvolutionDecision[];
      };
      if (parsed.decisions && Array.isArray(parsed.decisions)) {
        decisions = decisions.concat(parsed.decisions);
      }
    } catch (err) {
      log.warn("Memory evolution LLM call failed", { error: (err as Error).message });
      // Fall back to linking only for remaining neighbors
      for (const doc of needsLLM) {
        decisions.push({
          memory_id: doc.memory_id,
          create_link: true,
          link_reason: "Related memory (LLM fallback)",
          update_context: null,
          update_keywords: null,
          update_tags: null,
        });
      }
    }
  }

  // Execute decisions
  let linksCreated = 0;
  let neighborsEvolved = 0;

  for (const decision of decisions) {
    const neighbor = neighborDocs.find((d) => d.memory_id === decision.memory_id);
    if (!neighbor) continue;

    // Create bidirectional links
    if (decision.create_link) {
      const alreadyLinked = memory.linked_memory_ids.includes(decision.memory_id);
      if (!alreadyLinked) {
        // Link from new memory → neighbor
        const updatedLinks = [...memory.linked_memory_ids, decision.memory_id];
        const updatedReasons = [...memory.link_reasons, decision.link_reason];
        await updateMemory(memoryId, {
          linked_memory_ids: updatedLinks,
          link_reasons: updatedReasons,
        });
        memory.linked_memory_ids = updatedLinks;
        memory.link_reasons = updatedReasons;

        // Link from neighbor → new memory
        const neighborLinked = neighbor.linked_memory_ids.includes(memoryId);
        if (!neighborLinked) {
          await updateMemory(decision.memory_id, {
            linked_memory_ids: [...neighbor.linked_memory_ids, memoryId],
            link_reasons: [...neighbor.link_reasons, decision.link_reason],
          });
        }

        linksCreated++;
      }
    }

    // Evolve neighbor if LLM suggested updates
    const hasUpdates = decision.update_context || decision.update_keywords || decision.update_tags;
    if (hasUpdates) {
      const updates: Partial<Pick<MemoryNote, "context" | "keywords" | "tags" | "embedding_text">> =
        {};

      if (decision.update_context) {
        updates.context = decision.update_context;
      }
      if (decision.update_keywords) {
        updates.keywords = decision.update_keywords;
      }
      if (decision.update_tags) {
        updates.tags = decision.update_tags;
      }

      // Rebuild embedding text
      const evolvedContent = neighbor.content;
      const evolvedContext = decision.update_context ?? neighbor.context;
      const evolvedKeywords = decision.update_keywords ?? neighbor.keywords;
      updates.embedding_text = `${evolvedContent} ${evolvedContext} ${evolvedKeywords.join(" ")}`;

      await updateMemory(decision.memory_id, updates);

      // Re-embed evolved neighbor
      try {
        const [newVector] = await embeddingProvider.embed([updates.embedding_text]);
        await addToMemoryTable(neighbor.owner, [
          {
            id: neighbor.memory_id,
            owner: neighbor.owner,
            content: updates.embedding_text,
            memory_type: neighbor.memory_type,
            vector: newVector,
            tags: JSON.stringify(decision.update_tags ?? neighbor.tags),
            importance: neighbor.importance,
            created_at: neighbor.created_at.toISOString(),
            updated_at: new Date().toISOString(),
          },
        ]);

        // Re-index in FTS
        deleteFromMemoryFTS(neighbor.owner, neighbor.memory_id);
        addToMemoryFTS(neighbor.owner, [
          {
            memory_id: neighbor.memory_id,
            owner: neighbor.owner,
            content: updates.embedding_text,
            keywords: (decision.update_keywords ?? neighbor.keywords).join(" "),
            tags: (decision.update_tags ?? neighbor.tags).join(" "),
            memory_type: neighbor.memory_type,
          },
        ]);

        neighborsEvolved++;
      } catch (err) {
        log.warn("Failed to re-embed evolved neighbor", {
          memoryId: neighbor.memory_id,
          error: (err as Error).message,
        });
      }
    }
  }

  log.info("Memory evolution complete", {
    memoryId,
    neighbors: neighborDocs.length,
    linksCreated,
    neighborsEvolved,
  });

  return { links_created: linksCreated, neighbors_evolved: neighborsEvolved };
}
