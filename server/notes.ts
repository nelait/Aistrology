import { Router, type Request, type Response, type NextFunction } from "express";
import { requireAuth } from "./auth";
import { requireFeature } from "./features";
import {
  getUserPlan, getChart,
  listNotes, createNote, updateNote, deleteNote,
} from "./db";

// Per-profile notes — a Pro/Premium feature (especially for Premium users
// managing many profiles). Notes attach to a saved chart the user owns.
export const notesRouter = Router();
notesRouter.use(requireAuth);
notesRouter.use(requireFeature("notes"));

const MAX_TITLE = 200;
const MAX_BODY = 20_000;
const MAX_NOTES_PER_CHART = 200;

function uid(req: Request): string {
  return (req as Request & { userId: string }).userId;
}

// Gate to paid plans; attaches the plan for handlers if needed later.
async function requirePaid(req: Request, res: Response, next: NextFunction): Promise<void> {
  const plan = await getUserPlan(uid(req));
  if (plan !== "pro" && plan !== "premium") {
    res.status(403).json({ error: "Notes are available on the Pro and Premium plans." });
    return;
  }
  next();
}
notesRouter.use(requirePaid);

function apiNote(n: { id: string; chart_id: string; title: string; body: string; created_at: string; updated_at: string }) {
  return {
    id: n.id, chartId: n.chart_id, title: n.title, body: n.body,
    createdAt: Number(n.created_at), updatedAt: Number(n.updated_at),
  };
}

// GET /api/notes?chartId=… — notes for one owned profile.
notesRouter.get("/", async (req: Request, res: Response) => {
  const chartId = String(req.query.chartId ?? "");
  if (!chartId) { res.status(400).json({ error: "chartId is required" }); return; }
  if (!(await getChart(uid(req), chartId))) { res.status(404).json({ error: "Profile not found" }); return; }
  res.json({ notes: (await listNotes(uid(req), chartId)).map(apiNote) });
});

// POST /api/notes { chartId, title, body }
notesRouter.post("/", async (req: Request, res: Response) => {
  const { chartId, title, body } = (req.body ?? {}) as { chartId?: string; title?: string; body?: string };
  if (!chartId) { res.status(400).json({ error: "chartId is required" }); return; }
  if (!(await getChart(uid(req), chartId))) { res.status(404).json({ error: "Profile not found" }); return; }
  const t = (title ?? "").slice(0, MAX_TITLE);
  const b = (body ?? "").slice(0, MAX_BODY);
  if (!t.trim() && !b.trim()) { res.status(400).json({ error: "A note needs a title or body" }); return; }
  if ((await listNotes(uid(req), chartId)).length >= MAX_NOTES_PER_CHART) {
    res.status(400).json({ error: `Note limit reached (${MAX_NOTES_PER_CHART} per profile).` });
    return;
  }
  res.json({ note: apiNote(await createNote(uid(req), chartId, t, b)) });
});

// PUT /api/notes/:id { title, body }
notesRouter.put("/:id", async (req: Request, res: Response) => {
  const { title, body } = (req.body ?? {}) as { title?: string; body?: string };
  const t = (title ?? "").slice(0, MAX_TITLE);
  const b = (body ?? "").slice(0, MAX_BODY);
  if (!t.trim() && !b.trim()) { res.status(400).json({ error: "A note needs a title or body" }); return; }
  const note = await updateNote(uid(req), req.params.id, { title: t, body: b });
  if (!note) { res.status(404).json({ error: "Note not found" }); return; }
  res.json({ note: apiNote(note) });
});

// DELETE /api/notes/:id
notesRouter.delete("/:id", async (req: Request, res: Response) => {
  if (!(await deleteNote(uid(req), req.params.id))) { res.status(404).json({ error: "Note not found" }); return; }
  res.json({ ok: true });
});
