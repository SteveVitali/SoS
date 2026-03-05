import type { Collection } from "mongodb";
import { v4 as uuidv4 } from "uuid";
import { createLogger } from "../../shared/logger.js";
import { getDb } from "../mongo.js";

const log = createLogger("server:chat:repo");

// --- Types ---

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  at: Date;
  action?: { command: string; task_id?: string };
  images?: Array<{ url: string; alt?: string }>;
}

export interface ConversationDoc {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic type
  _id?: any;
  conversation_id: string;
  owner: string;
  title?: string;
  created_at: Date;
  updated_at: Date;
  messages: ConversationMessage[];
  linked_task_ids: string[];
}

// --- Collection accessor ---

function getCollection(): Collection<ConversationDoc> {
  return getDb().collection<ConversationDoc>("conversations");
}

// --- Ensure indexes (called from mongo.ts) ---

export async function ensureConversationIndexes(): Promise<void> {
  const col = getCollection();
  await col.createIndex(
    { conversation_id: 1 },
    { unique: true, name: "idx_conversation_id_unique" },
  );
  await col.createIndex({ owner: 1, updated_at: -1 }, { name: "idx_owner_updated" });
  log.info("Conversation indexes ensured");
}

// --- CRUD ---

export async function createConversation(owner: string): Promise<ConversationDoc> {
  const now = new Date();
  const doc: ConversationDoc = {
    conversation_id: uuidv4(),
    owner,
    created_at: now,
    updated_at: now,
    messages: [],
    linked_task_ids: [],
  };
  // biome-ignore lint/suspicious/noExplicitAny: dynamic type
  await getCollection().insertOne(doc as any);
  log.info("Conversation created", { conversation_id: doc.conversation_id, owner });
  return doc;
}

export async function findConversation(conversationId: string): Promise<ConversationDoc | null> {
  return getCollection().findOne({
    conversation_id: conversationId,
  }) as Promise<ConversationDoc | null>;
}

export async function listConversations(
  owner: string,
  limit = 50,
  offset = 0,
): Promise<{ conversations: ConversationDoc[]; total: number }> {
  const col = getCollection();
  const filter = { owner };
  const [conversations, total] = await Promise.all([
    col.find(filter).sort({ updated_at: -1 }).skip(offset).limit(limit).toArray(),
    col.countDocuments(filter),
  ]);
  return { conversations, total };
}

export async function appendMessage(
  conversationId: string,
  message: ConversationMessage,
): Promise<void> {
  await getCollection().updateOne(
    { conversation_id: conversationId },
    {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic type
      $push: { messages: message as any },
      $set: { updated_at: new Date() },
    },
  );
}

export async function linkJob(conversationId: string, taskId: string): Promise<void> {
  await getCollection().updateOne(
    { conversation_id: conversationId },
    {
      $addToSet: { linked_task_ids: taskId },
      $set: { updated_at: new Date() },
    },
  );
}

export async function setTitle(conversationId: string, title: string): Promise<void> {
  await getCollection().updateOne(
    { conversation_id: conversationId },
    { $set: { title, updated_at: new Date() } },
  );
}

export async function deleteConversation(conversationId: string): Promise<boolean> {
  const result = await getCollection().deleteOne({ conversation_id: conversationId });
  return result.deletedCount === 1;
}

/** Find conversations that link to a given task_id. */
export async function findConversationsByTaskId(taskId: string): Promise<ConversationDoc[]> {
  return getCollection().find({ linked_task_ids: taskId }).toArray();
}
