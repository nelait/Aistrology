import { Router, type Request, type Response } from "express";
import { requireAuth } from "./auth";
import {
  getChart,
  listLifeEvents,
  createLifeEvent,
  updateLifeEvent,
  deleteLifeEvent,
  countLifeEvents,
  type LifeEventRow,
  type LifeEventFields,
} from "./db";

// Dated life events the user reports for one of their profiles. Storage only —
// the analysis is entirely client-side in src/astro/eventAnalysis.ts, which is
// why there is no quota here: nothing on this path costs anything to run.
export const lifeEventsRouter = Router();
lifeEventsRouter.use(requireAuth);

const MAX_NOTE = 500;
const MAX_EVENTS_PER_CHART = 100;

// Kept in step with EventTypeId in src/astro/eventKaraka.ts. Duplicated rather
// than imported because the server does not build the client's astro modules;
// a type that drifts is caught by the test in eventKaraka.test.ts.
const TYPES = new Set([
  "marriage", "childbirth", "job_start", "promotion", "job_loss", "business_start",
  "education", "relocation", "foreign_travel", "property", "vehicle", "illness",
  "surgery", "bereavement_father", "bereavement_mother", "accident", "litigation",
  "financial_gain", "financial_loss", "spiritual",
]);
const PRECISIONS = new Set(["exact", "month", "year", "approx"]);
const CONFIDENCES = new Set(["sure", "fairly", "vague"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function uid(req: Request): string {
  return (req as Request & { userId: string }).userId;
}

function apiEvent(e: LifeEventRow) {
  return {
    id: e.id,
    chartId: e.chart_id,
    type: e.type,
    eventDate: e.event_date,
    precision: e.precision,
    confidence: e.confidence,
    note: e.note,
    createdAt: Number(e.created_at),
    updatedAt: Number(e.updated_at),
  };
}

/** Validate and normalise a submitted event, or return the error to send. */
function parseFields(body: unknown): { fields: LifeEventFields } | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const type = String(b.type ?? "");
  if (!TYPES.has(type)) return { error: "Unknown event type." };

  const eventDate = String(b.eventDate ?? "");
  if (!ISO_DATE.test(eventDate)) return { error: "A date is required (YYYY-MM-DD)." };
  const parsed = new Date(`${eventDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return { error: "That date is not valid." };
  // A future event cannot be evidence about a birth chart that has already
  // produced it, and is almost always a typo in the year.
  if (parsed.getTime() > Date.now() + 86_400_000) {
    return { error: "That date is in the future." };
  }
  if (parsed.getUTCFullYear() < 1800) return { error: "That date is too far in the past." };

  const precision = String(b.precision ?? "exact");
  if (!PRECISIONS.has(precision)) return { error: "Unknown date precision." };
  const confidence = String(b.confidence ?? "sure");
  if (!CONFIDENCES.has(confidence)) return { error: "Unknown confidence." };

  return {
    fields: {
      type,
      eventDate,
      precision,
      confidence,
      note: typeof b.note === "string" ? b.note.trim().slice(0, MAX_NOTE) : "",
    },
  };
}

/** Confirm the profile exists and belongs to the caller. */
async function ownsChart(req: Request, chartId: string): Promise<boolean> {
  return !!chartId && !!(await getChart(uid(req), chartId));
}

// GET /api/life-events?chartId=… — events for one owned profile.
lifeEventsRouter.get("/", async (req: Request, res: Response) => {
  const chartId = String(req.query.chartId ?? "");
  if (!(await ownsChart(req, chartId))) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }
  res.json({ events: (await listLifeEvents(uid(req), chartId)).map(apiEvent) });
});

lifeEventsRouter.post("/", async (req: Request, res: Response) => {
  const chartId = String((req.body ?? {}).chartId ?? "");
  if (!(await ownsChart(req, chartId))) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }
  const parsed = parseFields(req.body);
  if ("error" in parsed) { res.status(400).json({ error: parsed.error }); return; }

  if ((await countLifeEvents(uid(req), chartId)) >= MAX_EVENTS_PER_CHART) {
    res.status(429).json({
      error: `A profile can hold ${MAX_EVENTS_PER_CHART} events. Remove one before adding another.`,
    });
    return;
  }
  res.status(201).json({ event: apiEvent(await createLifeEvent(uid(req), chartId, parsed.fields)) });
});

lifeEventsRouter.put("/:id", async (req: Request, res: Response) => {
  const parsed = parseFields(req.body);
  if ("error" in parsed) { res.status(400).json({ error: parsed.error }); return; }
  const updated = await updateLifeEvent(uid(req), req.params.id, parsed.fields);
  if (!updated) { res.status(404).json({ error: "Event not found" }); return; }
  res.json({ event: apiEvent(updated) });
});

lifeEventsRouter.delete("/:id", async (req: Request, res: Response) => {
  if (!(await deleteLifeEvent(uid(req), req.params.id))) {
    res.status(404).json({ error: "Event not found" });
    return;
  }
  res.json({ ok: true });
});
