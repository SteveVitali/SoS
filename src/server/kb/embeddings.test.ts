import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetEmbeddingProvider,
  createEmbeddingProvider,
  loadEmbeddingConfig,
} from "./embeddings.js";

afterEach(() => {
  _resetEmbeddingProvider();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("loadEmbeddingConfig", () => {
  it("returns defaults when no env vars are set", () => {
    vi.stubEnv("SOS_EMBEDDING_PROVIDER", "");
    vi.stubEnv("SOS_EMBEDDING_MODEL", "");
    vi.stubEnv("SOS_EMBEDDING_API_KEY", "");
    vi.stubEnv("SOS_EMBEDDING_BASE_URL", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("SOS_EMBEDDING_DIMENSIONS", "");

    const config = loadEmbeddingConfig();
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("text-embedding-3-small");
    expect(config.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("reads custom env vars", () => {
    vi.stubEnv("SOS_EMBEDDING_PROVIDER", "openai_compatible");
    vi.stubEnv("SOS_EMBEDDING_MODEL", "custom-model");
    vi.stubEnv("SOS_EMBEDDING_API_KEY", "sk-test-key");
    vi.stubEnv("SOS_EMBEDDING_BASE_URL", "http://localhost:8080/v1");
    vi.stubEnv("SOS_EMBEDDING_DIMENSIONS", "768");

    const config = loadEmbeddingConfig();
    expect(config.provider).toBe("openai_compatible");
    expect(config.model).toBe("custom-model");
    expect(config.apiKey).toBe("sk-test-key");
    expect(config.baseUrl).toBe("http://localhost:8080/v1");
    expect(config.dimensions).toBe(768);
  });

  it("falls back to OPENAI_API_KEY", () => {
    vi.stubEnv("SOS_EMBEDDING_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "sk-openai-fallback");

    const config = loadEmbeddingConfig();
    expect(config.apiKey).toBe("sk-openai-fallback");
  });
});

describe("createEmbeddingProvider", () => {
  it("throws if no API key is provided", () => {
    expect(() =>
      createEmbeddingProvider({
        provider: "openai",
        model: "text-embedding-3-small",
        apiKey: "",
        baseUrl: "https://api.openai.com/v1",
      }),
    ).toThrow(/API key not configured/);
  });

  it("creates a provider with correct properties", () => {
    const provider = createEmbeddingProvider({
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(provider.modelName).toBe("text-embedding-3-small");
    expect(provider.dimensions).toBe(1536);
  });

  it("uses known dimensions for recognized models", () => {
    const provider = createEmbeddingProvider({
      provider: "openai",
      model: "text-embedding-3-large",
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(provider.dimensions).toBe(3072);
  });

  it("uses custom dimensions when provided", () => {
    const provider = createEmbeddingProvider({
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      dimensions: 768,
    });
    expect(provider.dimensions).toBe(768);
  });

  it("defaults to 1536 for unknown models", () => {
    const provider = createEmbeddingProvider({
      provider: "openai",
      model: "unknown-model",
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(provider.dimensions).toBe(1536);
  });

  it("returns empty array for empty input", async () => {
    const provider = createEmbeddingProvider({
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
    });
    const result = await provider.embed([]);
    expect(result).toEqual([]);
  });

  it("calls the embeddings API and returns vectors", async () => {
    const mockVector = [0.1, 0.2, 0.3];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { embedding: mockVector, index: 0 },
            { embedding: [0.4, 0.5, 0.6], index: 1 },
          ],
        }),
        { status: 200 },
      ),
    );

    const provider = createEmbeddingProvider({
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
    });

    const result = await provider.embed(["hello", "world"]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(mockVector);
    expect(result[1]).toEqual([0.4, 0.5, 0.6]);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    expect(opts?.method).toBe("POST");
    const body = JSON.parse(opts?.body as string);
    expect(body.model).toBe("text-embedding-3-small");
    expect(body.input).toEqual(["hello", "world"]);
  });

  it("sorts response by index to preserve order", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { embedding: [0.4, 0.5], index: 1 },
            { embedding: [0.1, 0.2], index: 0 },
          ],
        }),
        { status: 200 },
      ),
    );

    const provider = createEmbeddingProvider({
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
    });

    const result = await provider.embed(["a", "b"]);
    expect(result[0]).toEqual([0.1, 0.2]);
    expect(result[1]).toEqual([0.4, 0.5]);
  });

  it("throws on API error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Rate limit exceeded", { status: 429 }),
    );

    const provider = createEmbeddingProvider({
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
    });

    await expect(provider.embed(["test"])).rejects.toThrow(/Embedding API error 429/);
  });
});
