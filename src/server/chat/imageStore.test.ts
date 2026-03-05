import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock MongoDB
const mockInsertOne = vi.fn().mockResolvedValue({ insertedId: "test" });
const mockFindOne = vi.fn();
const mockCreateIndex = vi.fn().mockResolvedValue("ok");

vi.mock("../mongo.js", () => ({
  getDb: () => ({
    collection: () => ({
      insertOne: mockInsertOne,
      findOne: mockFindOne,
      createIndex: mockCreateIndex,
    }),
  }),
}));

vi.mock("uuid", () => ({
  v4: () => "test-image-uuid",
}));

import { ensureImageIndexes, findImage, storeGeneratedImage } from "./imageStore.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ensureImageIndexes", () => {
  it("creates unique index on image_id and TTL index on created_at", async () => {
    await ensureImageIndexes();
    expect(mockCreateIndex).toHaveBeenCalledTimes(2);
    // Unique index on image_id
    expect(mockCreateIndex).toHaveBeenCalledWith(
      { image_id: 1 },
      { unique: true, name: "idx_image_id_unique" },
    );
    // TTL index: 90 days = 7776000 seconds
    expect(mockCreateIndex).toHaveBeenCalledWith(
      { created_at: 1 },
      { expireAfterSeconds: 90 * 24 * 60 * 60, name: "idx_image_ttl_90d" },
    );
  });
});

describe("storeGeneratedImage", () => {
  it("stores image doc and returns url + alt", async () => {
    const ref = await storeGeneratedImage({
      base64: "iVBORw0KGgo=",
      mediaType: "image/png",
      prompt: "a cartoon cat",
      revisedPrompt: "a fluffy cartoon cat with big eyes",
      model: "gpt-image-1",
      createdBy: "owner1",
      conversationId: "conv-123",
    });

    expect(ref.url).toBe("/api/web/images/test-image-uuid");
    expect(ref.alt).toBe("a fluffy cartoon cat with big eyes");

    expect(mockInsertOne).toHaveBeenCalledTimes(1);
    const doc = mockInsertOne.mock.calls[0][0];
    expect(doc.image_id).toBe("test-image-uuid");
    expect(doc.base64).toBe("iVBORw0KGgo=");
    expect(doc.media_type).toBe("image/png");
    expect(doc.prompt).toBe("a cartoon cat");
    expect(doc.revised_prompt).toBe("a fluffy cartoon cat with big eyes");
    expect(doc.model).toBe("gpt-image-1");
    expect(doc.created_by).toBe("owner1");
    expect(doc.conversation_id).toBe("conv-123");
    expect(doc.size_bytes).toBeGreaterThan(0);
    expect(doc.created_at).toBeInstanceOf(Date);
  });

  it("uses prompt as alt when no revised prompt", async () => {
    const ref = await storeGeneratedImage({
      base64: "AAAA",
      mediaType: "image/png",
      prompt: "a simple cat",
      model: "gpt-image-1",
      createdBy: "owner1",
    });

    expect(ref.alt).toBe("a simple cat");
  });
});

describe("findImage", () => {
  it("delegates to collection.findOne", async () => {
    const fakeDoc = { image_id: "abc", base64: "data", media_type: "image/png" };
    mockFindOne.mockResolvedValue(fakeDoc);

    const result = await findImage("abc");
    expect(result).toEqual(fakeDoc);
    expect(mockFindOne).toHaveBeenCalledWith({ image_id: "abc" });
  });

  it("returns null when not found", async () => {
    mockFindOne.mockResolvedValue(null);
    const result = await findImage("nonexistent");
    expect(result).toBeNull();
  });
});
