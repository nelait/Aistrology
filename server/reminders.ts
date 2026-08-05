import { Router, type Request, type Response } from "express";
import { requireAuth } from "./auth";
import { requireFeature } from "./features";
import {
  listReminders, createReminder, updateReminder, deleteReminder,
  listFestivals, listSubscriptions, subscribeFestival, unsubscribeFestival,
  type ReminderRow, type FestivalRow,
} from "./db";

export const remindersRouter = Router();

remindersRouter.use(requireFeature("reminders"));
remindersRouter.use(requireAuth);

function uid(req: Request): string {
  return (req as Request & { userId: string }).userId;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RECURRENCE = ["annual", "once"];

function toReminder(r: ReminderRow) {
  return {
    id: r.id, title: r.title, notes: r.notes, eventDate: r.event_date,
    recurrence: r.recurrence, leadDays: r.lead_days, enabled: r.enabled,
    lastNotified: r.last_notified,
  };
}
function toFestival(f: FestivalRow, subbed?: { lead_days: number }) {
  return {
    id: f.id, name: f.name, description: f.description, eventDate: f.event_date,
    recurring: f.recurring,
    subscribed: Boolean(subbed), leadDays: subbed?.lead_days ?? 3,
  };
}

function clampLead(v: unknown, def: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(365, Math.max(0, Math.round(n)));
}

/** Bundle for the Reminders page. */
remindersRouter.get("/", async (req: Request, res: Response) => {
  const userId = uid(req);
  const [reminders, festivals, subs] = await Promise.all([
    listReminders(userId), listFestivals(), listSubscriptions(userId),
  ]);
  const subMap = new Map(subs.map((s) => [s.festival_id, s]));
  res.json({
    reminders: reminders.map(toReminder),
    festivals: festivals.map((f) => toFestival(f, subMap.get(f.id))),
  });
});

remindersRouter.post("/reminders", async (req: Request, res: Response) => {
  const { title, notes, eventDate, recurrence, leadDays, enabled } = req.body ?? {};
  if (typeof title !== "string" || !title.trim()) {
    res.status(400).json({ error: "A title is required." }); return;
  }
  if (typeof eventDate !== "string" || !DATE_RE.test(eventDate)) {
    res.status(400).json({ error: "A valid date (YYYY-MM-DD) is required." }); return;
  }
  const rec = RECURRENCE.includes(recurrence) ? recurrence : "annual";
  const r = await createReminder(uid(req), {
    title: title.trim(),
    notes: typeof notes === "string" ? notes.trim() : "",
    eventDate, recurrence: rec, leadDays: clampLead(leadDays, 7),
    enabled: enabled !== false,
  });
  res.status(201).json({ reminder: toReminder(r) });
});

remindersRouter.put("/reminders/:id", async (req: Request, res: Response) => {
  const { title, notes, eventDate, recurrence, leadDays, enabled } = req.body ?? {};
  if (eventDate !== undefined && (typeof eventDate !== "string" || !DATE_RE.test(eventDate))) {
    res.status(400).json({ error: "Invalid date." }); return;
  }
  const r = await updateReminder(uid(req), req.params.id, {
    title: typeof title === "string" ? title.trim() : undefined,
    notes: typeof notes === "string" ? notes.trim() : undefined,
    eventDate,
    recurrence: RECURRENCE.includes(recurrence) ? recurrence : undefined,
    leadDays: leadDays !== undefined ? clampLead(leadDays, 7) : undefined,
    enabled: typeof enabled === "boolean" ? enabled : undefined,
  });
  if (!r) { res.status(404).json({ error: "Reminder not found." }); return; }
  res.json({ reminder: toReminder(r) });
});

remindersRouter.delete("/reminders/:id", async (req: Request, res: Response) => {
  const ok = await deleteReminder(uid(req), req.params.id);
  if (!ok) { res.status(404).json({ error: "Reminder not found." }); return; }
  res.json({ ok: true });
});

remindersRouter.post("/festivals/:id/subscribe", async (req: Request, res: Response) => {
  const leadDays = clampLead(req.body?.leadDays, 3);
  await subscribeFestival(uid(req), req.params.id, leadDays);
  res.json({ ok: true, subscribed: true, leadDays });
});

remindersRouter.delete("/festivals/:id/subscribe", async (req: Request, res: Response) => {
  await unsubscribeFestival(uid(req), req.params.id);
  res.json({ ok: true, subscribed: false });
});
