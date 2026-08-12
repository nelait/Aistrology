import { Router, type Request, type Response } from "express";
import { requireAuth } from "./auth";
import {
  getChart,
  recordAccuracy,
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

const VERDICTS = new Set(["narrow", "indicative", "weak", "inconclusive"]);

/**
 * POST /api/life-events/accuracy — an opt-in report of how close the birth-time
 * search came, from a user who already knew the answer.
 *
 * Everything identifying is left on the client on purpose. No birth time, no
 * date, no place, no events: just how far off the search was, and enough shape
 * (how many events, how well dated, which verdict) to make the number mean
 * something. The bounds below are what stops a crafted request poisoning the
 * only real accuracy figure this project will ever have.
 */
lifeEventsRouter.post("/accuracy", async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : NaN);

  const errorMinutes = int(b.errorMinutes);
  const windowMinutes = int(b.windowMinutes);
  const eventCount = int(b.eventCount);
  const verdict = String(b.verdict ?? "");

  // A birth time is a point on a 24-hour circle, so the furthest anything can
  // be from anything else is twelve hours.
  if (!Number.isFinite(errorMinutes) || errorMinutes < 0 || errorMinutes > 720) {
    res.status(400).json({ error: "errorMinutes must be between 0 and 720." });
    return;
  }
  if (!Number.isFinite(windowMinutes) || windowMinutes < 0 || windowMinutes > 1440) {
    res.status(400).json({ error: "windowMinutes is out of range." });
    return;
  }
  if (!Number.isFinite(eventCount) || eventCount < 1 || eventCount > MAX_EVENTS_PER_CHART) {
    res.status(400).json({ error: "eventCount is out of range." });
    return;
  }
  if (!VERDICTS.has(verdict)) { res.status(400).json({ error: "Unknown verdict." }); return; }

  const decade = int(b.birthDecade);
  await recordAccuracy(uid(req), {
    errorMinutes,
    insideWindow: b.insideWindow === true,
    windowMinutes,
    verdict,
    separationZ: typeof b.separationZ === "number" && Number.isFinite(b.separationZ)
      ? Math.max(-99, Math.min(99, b.separationZ)) : null,
    eventCount,
    precisionMix: typeof b.precisionMix === "string" ? b.precisionMix.slice(0, 60) : "",
    timeOfDay: typeof b.timeOfDay === "string" ? b.timeOfDay.slice(0, 20) : "unknown",
    birthDecade: Number.isFinite(decade) && decade >= 1800 && decade <= 2100 ? decade : null,
  });
  res.status(201).json({ ok: true });
});

lifeEventsRouter.delete("/:id", async (req: Request, res: Response) => {
  if (!(await deleteLifeEvent(uid(req), req.params.id))) {
    res.status(404).json({ error: "Event not found" });
    return;
  }
  res.json({ ok: true });
});
