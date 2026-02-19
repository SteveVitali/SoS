import { type Request, type Response, Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { createLogger } from "../../shared/logger.js";
import type { ServerConfig } from "../config.js";
import type { CommandContext } from "../slack/commandExecutor.js";
import { executeCommand } from "../slack/commandExecutor.js";
import type { ThreadMessage } from "../slack/messageRouter.js";
import { routeMessage } from "../slack/messageRouter.js";
import type { ConversationMessage } from "./conversationRepo.js";
import {
  appendMessage,
  createConversation,
  deleteConversation,
  findConversation,
  linkJob,
  listConversations,
} from "./conversationRepo.js";
import { generateConversationTitle } from "./titleGen.js";

const log = createLogger("server:chat:routes");

function pstr(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

export function createChatRoutes(config: ServerConfig): Router {
  const router = Router();

  // POST /api/web/chats — create a new conversation
  router.post("/", async (_req: Request, res: Response) => {
    try {
      const conversation = await createConversation(config.slackJobOwner);
      res.json({ conversation });
    } catch (err: any) {
      log.error("Create conversation error", { error: err.message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // GET /api/web/chats — list conversations
  router.get("/", async (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(String(req.query.limit || "50"), 10), 100);
      const offset = parseInt(String(req.query.offset || "0"), 10);
      const { conversations, total } = await listConversations(config.slackJobOwner, limit, offset);
      res.json({ conversations, total });
    } catch (err: any) {
      log.error("List conversations error", { error: err.message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // GET /api/web/chats/:id — get a single conversation
  router.get("/:id", async (req: Request, res: Response) => {
    try {
      const conversation = await findConversation(pstr(req.params.id));
      if (!conversation) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
      res.json({ conversation });
    } catch (err: any) {
      log.error("Get conversation error", { error: err.message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // POST /api/web/chats/:id/messages — send a message and get Steve's reply
  router.post("/:id/messages", async (req: Request, res: Response) => {
    try {
      const conversation = await findConversation(pstr(req.params.id));
      if (!conversation) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }

      const { text } = req.body;
      if (!text || typeof text !== "string" || !text.trim()) {
        res.status(400).json({ error: "Message text is required" });
        return;
      }

      const userMessage: ConversationMessage = {
        id: uuidv4(),
        role: "user",
        text: text.trim(),
        at: new Date(),
      };
      await appendMessage(conversation.conversation_id, userMessage);

      // Build thread context from conversation history
      const threadMessages: ThreadMessage[] = conversation.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          user: m.role === "user" ? config.slackJobOwner : "bot",
          text: m.text,
          ts: m.at.toISOString(),
          isBot: m.role === "assistant",
        }));
      // Add the current message
      threadMessages.push({
        user: config.slackJobOwner,
        text: text.trim(),
        ts: new Date().toISOString(),
        isBot: false,
      });

      // Route through LLM
      const action = await routeMessage(text.trim(), config.slackJobOwner, threadMessages);
      log.info("Chat routed", {
        conversation_id: conversation.conversation_id,
        command: action.command,
      });

      // Execute the command
      const ctx: CommandContext = {
        userId: config.slackJobOwner,
        ownerId: config.slackJobOwner,
        source: "web",
        eventId: `web-chat-${userMessage.id}`,
        web: { conversationId: conversation.conversation_id },
      };
      const result = await executeCommand(action, ctx);

      // Persist assistant reply
      const assistantMessage: ConversationMessage = {
        id: uuidv4(),
        role: "assistant",
        text: result.reply,
        at: new Date(),
        action: result.taskId
          ? { command: action.command, task_id: result.taskId }
          : action.command !== "chat" && action.command !== "no_op"
            ? { command: action.command }
            : undefined,
      };
      await appendMessage(conversation.conversation_id, assistantMessage);

      // Link job to conversation if one was created
      if (result.taskId) {
        await linkJob(conversation.conversation_id, result.taskId);
      }

      // Auto-generate title from first user message
      if (conversation.messages.length === 0 && !conversation.title) {
        generateConversationTitle(conversation.conversation_id, text.trim()).catch(() => {});
      }

      res.json({
        userMessage,
        assistantMessage,
        action: { command: action.command, taskId: result.taskId },
      });
    } catch (err: any) {
      log.error("Send message error", { error: err.message, stack: err.stack });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // GET /api/web/chats/:id/updates?since=<iso> — poll for new messages
  router.get("/:id/updates", async (req: Request, res: Response) => {
    try {
      const conversation = await findConversation(pstr(req.params.id));
      if (!conversation) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
      const since = req.query.since ? new Date(String(req.query.since)) : new Date(0);
      const newMessages = conversation.messages.filter((m) => new Date(m.at) > since);
      res.json({ messages: newMessages, linked_task_ids: conversation.linked_task_ids });
    } catch (err: any) {
      log.error("Poll updates error", { error: err.message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // DELETE /api/web/chats/:id — delete conversation
  router.delete("/:id", async (req: Request, res: Response) => {
    try {
      const deleted = await deleteConversation(pstr(req.params.id));
      if (!deleted) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
      res.json({ ok: true });
    } catch (err: any) {
      log.error("Delete conversation error", { error: err.message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  return router;
}
