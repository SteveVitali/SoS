import { type Request, type Response, Router } from "express";
import type { Collection } from "mongodb";
import { v4 as uuidv4 } from "uuid";
import { createLogger } from "../../shared/logger.js";
import { getDb } from "../mongo.js";

const log = createLogger("server:chat:imageStore");

// --- Types ---

export interface GeneratedImageDoc {
  image_id: string;
  base64: string;
  media_type: string;
  prompt: string;
  revised_prompt?: string;
  model: string;
  created_at: Date;
  created_by: string;
  conversation_id?: string;
  size_bytes: number;
}

export interface ImageRef {
  url: string;
  alt?: string;
}

// --- Collection accessor ---

function getCollection(): Collection<GeneratedImageDoc> {
  return getDb().collection<GeneratedImageDoc>("generated_images");
}

// --- Indexes ---

export async function ensureImageIndexes(): Promise<void> {
  const col = getCollection();
  await col.createIndex({ image_id: 1 }, { unique: true, name: "idx_image_id_unique" });
  // 90-day TTL index — images auto-expire after 90 days
  await col.createIndex(
    { created_at: 1 },
    { expireAfterSeconds: 90 * 24 * 60 * 60, name: "idx_image_ttl_90d" },
  );
  log.info("Generated images indexes ensured (90-day TTL)");
}

// --- Store ---

export async function storeGeneratedImage(params: {
  base64: string;
  mediaType: string;
  prompt: string;
  revisedPrompt?: string;
  model: string;
  createdBy: string;
  conversationId?: string;
}): Promise<ImageRef> {
  const imageId = uuidv4();
  const doc: GeneratedImageDoc = {
    image_id: imageId,
    base64: params.base64,
    media_type: params.mediaType,
    prompt: params.prompt,
    revised_prompt: params.revisedPrompt,
    model: params.model,
    created_at: new Date(),
    created_by: params.createdBy,
    conversation_id: params.conversationId,
    size_bytes: Buffer.byteLength(params.base64, "base64"),
  };

  // biome-ignore lint/suspicious/noExplicitAny: dynamic type
  await getCollection().insertOne(doc as any);
  log.info("Stored generated image", {
    image_id: imageId,
    size_bytes: doc.size_bytes,
    model: params.model,
  });

  return {
    url: `/api/web/images/${imageId}`,
    alt: params.revisedPrompt || params.prompt,
  };
}

// --- Retrieve ---

export async function findImage(imageId: string): Promise<GeneratedImageDoc | null> {
  return getCollection().findOne({ image_id: imageId }) as Promise<GeneratedImageDoc | null>;
}

// --- Express routes ---

export function createImageRoutes(): Router {
  const router = Router();

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // GET /api/web/images/:id — serve a generated image
  router.get("/:id", async (req: Request, res: Response) => {
    try {
      const imageId = String(req.params.id);
      if (!UUID_RE.test(imageId)) {
        res.status(400).json({ error: "Invalid image ID" });
        return;
      }

      const doc = await findImage(imageId);
      if (!doc) {
        res.status(404).json({ error: "Image not found" });
        return;
      }

      const buf = Buffer.from(doc.base64, "base64");
      res.setHeader("Content-Type", doc.media_type);
      res.setHeader("Content-Length", buf.length);
      // Cache for 7 days (images are immutable)
      res.setHeader("Cache-Control", "public, max-age=604800, immutable");
      res.send(buf);
    } catch (err: unknown) {
      log.error("Serve image error", { error: (err as Error).message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  return router;
}
