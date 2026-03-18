/**
 * LLM prompt templates for the memory system.
 *
 * Each function accepts template variables and returns a formatted prompt string.
 * Uses simple string interpolation (no template engine).
 */

import type { InteractionEpisode, MemoryNote } from "../../shared/memoryTypes.js";

// ─── §8.1 Fact Extraction Prompt ─────────────────────────────────

export interface FactExtractionInput {
  user_message: string;
  routed_action: string;
  response_summary: string;
  prior_context?: string;
  max_facts: number;
}

export function buildFactExtractionPrompt(input: FactExtractionInput): string {
  const priorSection = input.prior_context
    ? `\n## Recent conversation context\n${input.prior_context}\n`
    : "";

  return `You are a memory extraction system. Analyze the following interaction and extract
important facts, preferences, corrections, or domain knowledge worth remembering.

## Interaction
User: ${input.user_message}
Action taken: ${input.routed_action}
Response summary: ${input.response_summary}
${priorSection}
## Instructions
Extract 0–${input.max_facts} distinct facts. For each:
- State as a clear, standalone statement
- Assign importance (0.0–1.0): chit-chat=0.1, preferences=0.5, corrections=0.8, critical knowledge=0.9
- Generate 2–5 keywords and 1–3 tags (lowercase_snake_case)

Return JSON: { "facts": [{ "content": "...", "importance": 0.6, "keywords": [...], "tags": [...] }] }
If nothing worth remembering: { "facts": [] }`;
}

// ─── §8.2 Memory Curation Prompt ─────────────────────────────────

export interface MemoryCurationInput {
  new_fact_content: string;
  similar_memories: Array<{
    memory_id: string;
    content: string;
    created_at: string;
    importance: number;
  }>;
}

export function buildMemoryCurationPrompt(input: MemoryCurationInput): string {
  const memoriesList =
    input.similar_memories.length > 0
      ? input.similar_memories
          .map(
            (m) =>
              `[${m.memory_id}] ${m.content} (learned: ${m.created_at}, importance: ${m.importance})`,
          )
          .join("\n")
      : "(none)";

  return `You are a memory curation system. A new fact has been extracted. Compare against
existing similar memories and decide the operation.

## New fact
${input.new_fact_content}

## Existing similar memories
${memoriesList}

## Operations
- ADD: Genuinely new information.
- UPDATE <memory_id>: Refines or extends an existing memory. Provide updated content.
- DELETE <memory_id>: Contradicts/supersedes existing. Old memory will be invalidated.
- NOOP: Already known.

Return JSON: { "operation": "ADD"|"UPDATE"|"DELETE"|"NOOP", "target_memory_id": null|"<id>",
  "updated_content": null|"new content", "reason": "brief explanation" }`;
}

// ─── §8.3 Combined Extraction + Curation Prompt (Batched) ────────

export interface BatchedExtractionInput {
  user_message: string;
  routed_action: string;
  response_summary: string;
  prior_context?: string;
  existing_memories: Array<{
    memory_id: string;
    content: string;
    importance: number;
  }>;
  max_facts: number;
}

export function buildBatchedExtractionPrompt(input: BatchedExtractionInput): string {
  const priorSection = input.prior_context
    ? `\n## Recent conversation context\n${input.prior_context}\n`
    : "";

  const memoriesList =
    input.existing_memories.length > 0
      ? input.existing_memories
          .map((m) => `[${m.memory_id}] ${m.content} (importance: ${m.importance})`)
          .join("\n")
      : "(none)";

  return `You are a memory system. Analyze this interaction, extract facts, and for each,
compare against existing memories to decide the operation.

## Interaction
User: ${input.user_message}
Action: ${input.routed_action}
Response: ${input.response_summary}
${priorSection}
## Existing memories (potentially related)
${memoriesList}

## Instructions
Extract 0–${input.max_facts} facts. For each, decide: ADD (new), UPDATE <id> (refine existing),
DELETE <id> (contradicts existing), or NOOP (already known).

Return JSON:
{ "operations": [{
    "content": "the fact",
    "importance": 0.6,
    "keywords": ["keyword1", "keyword2"],
    "tags": ["tag1"],
    "operation": "ADD"|"UPDATE"|"DELETE"|"NOOP",
    "target_memory_id": null|"<id>",
    "updated_content": null|"...",
    "reason": "..."
}]}`;
}

// ─── §8.4 Memory Evolution Prompt ────────────────────────────────

export interface MemoryEvolutionInput {
  new_memory_content: string;
  keywords: string[];
  tags: string[];
  neighbors: Array<{
    memory_id: string;
    content: string;
    context: string;
    keywords: string[];
  }>;
}

export function buildMemoryEvolutionPrompt(input: MemoryEvolutionInput): string {
  const neighborsList = input.neighbors
    .map(
      (n) =>
        `[${n.memory_id}] ${n.content} | Context: ${n.context} | Keywords: ${n.keywords.join(", ")}`,
    )
    .join("\n");

  return `A memory was just created/updated. Determine if neighboring memories should evolve.

## New/Updated memory
${input.new_memory_content}
Keywords: ${input.keywords.join(", ")}, Tags: ${input.tags.join(", ")}

## Neighbors
${neighborsList}

For each neighbor: should a link be created? Should its context/keywords/tags update?

Return JSON: { "decisions": [{ "memory_id": "<id>", "create_link": true|false,
  "link_reason": "...", "update_context": null|"...",
  "update_keywords": null|["..."], "update_tags": null|["..."] }] }`;
}

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Format prior episodes as conversation context for extraction prompts.
 */
export function formatPriorEpisodes(episodes: InteractionEpisode[]): string {
  if (episodes.length === 0) return "";
  return episodes
    .map(
      (ep) =>
        `- [${ep.timestamp.toISOString()}] User: ${ep.user_message.slice(0, 200)} → ${ep.routed_action}: ${ep.response_summary.slice(0, 200)}`,
    )
    .join("\n");
}

/**
 * Format memory notes for inclusion in prompts.
 */
export function formatMemoriesForPrompt(
  memories: MemoryNote[],
): Array<{ memory_id: string; content: string; importance: number }> {
  return memories.map((m) => ({
    memory_id: m.memory_id,
    content: m.content,
    importance: m.importance,
  }));
}
