import { Router, type Request, type Response } from "express";
import { requireAuth } from "./auth";
import { requireFeature } from "./features";
import {
  listChatConversations,
  getChatConversation,
  listChatMessages,
  deleteChatConversation,
} from "./db";

// Persistence endpoints for Astro Chat (Phase 2). The streaming endpoint itself
// lives in server/llm.ts (/api/llm/chat/stream) and writes messages here.
export const chatRouter = Router();
chatRouter.use(requireAuth);
chatRouter.use(requireFeature("chat"));

function uid(req: Request): string {
  return (req as Request & { userId: string }).userId;
}

function apiConversation(c: { id: string; title: string; chart_id: string | null; updated_at: string; created_at: string; message_count?: number }) {
  return {
    id: c.id,
    title: c.title,
    chartId: c.chart_id,
    messageCount: c.message_count ?? 0,
    updatedAt: Number(c.updated_at),
    createdAt: Number(c.created_at),
  };
}

// List the signed-in user's conversations (newest first).
chatRouter.get("/conversations", async (req: Request, res: Response) => {
  const rows = await listChatConversations(uid(req));
  res.json({ conversations: rows.map(apiConversation) });
});

// One conversation with its full message history.
chatRouter.get("/conversations/:id", async (req: Request, res: Response) => {
  const conv = await getChatConversation(uid(req), req.params.id);
  if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }
  const messages = await listChatMessages(conv.id);
  res.json({
    conversation: apiConversation(conv),
    messages: messages.map((m) => ({ role: m.role, content: m.content, createdAt: Number(m.created_at) })),
  });
});

chatRouter.delete("/conversations/:id", async (req: Request, res: Response) => {
  const ok = await deleteChatConversation(uid(req), req.params.id);
  if (!ok) { res.status(404).json({ error: "Conversation not found" }); return; }
  res.json({ ok: true });
});
