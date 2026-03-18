/**
 * Unified context assembly layer — barrel export.
 *
 * Provides a single entry point for assembling context from both
 * Knowledge Bases and Memory for injection into LLM prompts.
 */

export { assembleContext } from "./contextAssembler.js";
export { loadContextConfig } from "./contextConfig.js";
export { normalizeKBResults, normalizeMemoryResults } from "./contextNormalizer.js";
export { parseRerankerResponse, rerankAndEvaluate, shouldRunReranker } from "./contextReranker.js";
export { estimateTokens, serializeContext } from "./contextSerializer.js";
export type {
  AssembleContextParams,
  AssemblyResult,
  ContextItem,
  RerankerResult,
  Sufficiency,
} from "./contextTypes.js";
