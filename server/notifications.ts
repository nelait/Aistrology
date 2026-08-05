import { Router, type Request, type Response } from "express";
import { requireAuth } from "./auth";
import {
  listNotifications,
  countUnread,
  markNotificationRead,
  markAllNotificationsRead,
  type NotificationRow,
} from "./db";

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

function uid(req: Request): string {
  return (req as Request & { userId: string }).userId;
}

function toApi(n: NotificationRow) {
  return {
    id: n.id,
    title: n.title,
    body: n.body,
    level: n.level,
    read: n.read_at != null,
    createdAt: Number(n.created_at),
  };
}

notificationsRouter.get("/", async (req: Request, res: Response) => {
  const [items, unread] = await Promise.all([listNotifications(uid(req)), countUnread(uid(req))]);
  res.json({ notifications: items.map(toApi), unread });
});

notificationsRouter.post("/:id/read", async (req: Request, res: Response) => {
  await markNotificationRead(uid(req), req.params.id);
  res.json({ ok: true, unread: await countUnread(uid(req)) });
});

notificationsRouter.post("/read-all", async (req: Request, res: Response) => {
  await markAllNotificationsRead(uid(req));
  res.json({ ok: true, unread: 0 });
});
