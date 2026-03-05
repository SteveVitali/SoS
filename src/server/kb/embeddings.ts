/**
 * Embedding provider for knowledge base vector operations.
 * Supports OpenAI embeddings directly or via LiteLLM proxy.
 */

import { createLogger } from "../../shared/logger.js";
import { getModelForRole } from "../../shared/modelConfig.js";

const log = createLogger("server:kb:embeddings");

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly modelName: string;
}

interface EmbeddingConfig {
  provider: "openai" | "openai_compatible";
  model: string;
  apiKey: string;
  baseUrl: string;
  dimensions?: number;
}

const KNOWN_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
  "amazon.titan-embed-text-v2:0": 1024,
  "bedrock/amazon.titan-embed-text-v2:0": 1024,
};

const MAX_BATCH_SIZE = 2048;

export function loadEmbeddingConfig(): EmbeddingConfig {
  const provider = (process.env.SOS_EMBEDDING_PROVIDER || "openai") as
    | "openai"
    | "openai_compatible";
  const model = getModelForRole("embedding");
  const apiKey = process.env.SOS_EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || "";
  const baseUrl = process.env.SOS_EMBEDDING_BASE_URL || "https://api.openai.com/v1";
  const dimensions = process.env.SOS_EMBEDDING_DIMENSIONS
    ? parseInt(process.env.SOS_EMBEDDING_DIMENSIONS, 10)
    : undefined;

  return { provider, model, apiKey, baseUrl, dimensions };
}

export function createEmbeddingProvider(config?: EmbeddingConfig): EmbeddingProvider {
  const cfg = config || loadEmbeddingConfig();

  if (!cfg.apiKey) {
    throw new Error(
      "Embedding API key not configured. Set SOS_EMBEDDING_API_KEY or OPENAI_API_KEY.",
    );
  }

  const dimensions = cfg.dimensions || KNOWN_DIMENSIONS[cfg.model] || 1536;

  log.info("Embedding provider initialized", {
    provider: cfg.provider,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    dimensions,
  });

  return {
    modelName: cfg.model,
    dimensions,

    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];

      const allEmbeddings: number[][] = [];

      // Process in batches to avoid API limits
      for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
        const batch = texts.slice(i, i + MAX_BATCH_SIZE);

        const response = await fetch(`${cfg.baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify({
            model: cfg.model,
            input: batch,
            ...(cfg.dimensions ? { dimensions: cfg.dimensions } : {}),
          }),
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "");
          throw new Error(`Embedding API error ${response.status}: ${errorText}`);
        }

        const data = (await response.json()) as {
          data: Array<{ embedding: number[]; index: number }>;
        };

        // Sort by index to preserve order
        const sorted = data.data.sort((a, b) => a.index - b.index);
        for (const item of sorted) {
          allEmbeddings.push(item.embedding);
        }
      }

      log.info("Embeddings generated", {
        texts: texts.length,
        model: cfg.model,
      });

      return allEmbeddings;
    },
  };
}

let cachedProvider: EmbeddingProvider | null = null;

/**
 * Get or create the singleton embedding provider.
 */
export function getEmbeddingProvider(): EmbeddingProvider {
  if (!cachedProvider) {
    cachedProvider = createEmbeddingProvider();
  }
  return cachedProvider;
}

/**
 * Reset the cached provider (for testing).
 */
export function _resetEmbeddingProvider(): void {
  cachedProvider = null;
}
