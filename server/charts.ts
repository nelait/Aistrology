import { Router, type Request, type Response } from "express";
import { requireAuth } from "./auth";
import {
  listCharts,
  getChart,
  createChart,
  updateChart,
  deleteChart,
  getUserPlan,
  getTotalChartsCreated,
  incrementChartsCreated,
  getVastuSettings,
  upsertVastuSettings,
  deleteVastuSettings,
  type ChartRow,
} from "./db";
import {
  checkDailyQuota,
  getPlanDailyLimit,
  PLAN_LIFETIME_CHART_LIMIT,
} from "./rateLimit";
import { requireFeature } from "./features";

export const chartsRouter = Router();
const vastuEnabled = requireFeature("vastu");

chartsRouter.use(requireAuth);

/** Active profile limits per plan (concurrent). */
const PLAN_CHART_LIMIT: Record<string, number> = { free: 1, pro: 2, premium: 10 };

function uid(req: Request): string {
  return (req as Request & { userId: string }).userId;
}

/** Serialise a DB row to the API shape (birth_json is already a JS object). */
function toApi(row: ChartRow) {
  return {
    id: row.id,
    label: row.label,
    birth: row.birth_json,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** Basic validation that the payload looks like BirthData. */
function validBirth(b: unknown): b is Record<string, unknown> {
  if (!b || typeof b !== "object") return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o.year === "number" &&
    typeof o.month === "number" &&
    typeof o.day === "number" &&
    typeof o.latitude === "number" &&
    typeof o.longitude === "number" &&
    typeof o.tzOffsetHours === "number"
  );
}

chartsRouter.get("/", async (req: Request, res: Response) => {
  const plan = await getUserPlan(uid(req));
  const limit = PLAN_CHART_LIMIT[plan] ?? 1;
  res.json({ charts: (await listCharts(uid(req))).map(toApi), plan, chartLimit: limit });
});

chartsRouter.post("/", async (req: Request, res: Response) => {
  const { label, birth } = req.body ?? {};
  if (typeof label !== "string" || !label.trim()) {
    res.status(400).json({ error: "A label is required" });
    return;
  }
  if (!validBirth(birth)) {
    res.status(400).json({ error: "Invalid birth data" });
    return;
  }

  const userId = uid(req);
  const plan = await getUserPlan(userId);

  // 1. Check active profile limit
  const activeLimit = PLAN_CHART_LIMIT[plan] ?? 1;
  const existing = await listCharts(userId);
  if (existing.length >= activeLimit) {
    const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);
    res.status(403).json({
      error: `Your ${planLabel} plan allows up to ${activeLimit} active profile${activeLimit > 1 ? "s" : ""}. Upgrade to add more.`,
      chartLimit: activeLimit,
      currentCount: existing.length,
      requiredPlan: plan === "free" ? "pro" : "premium",
    });
    return;
  }

  // 2. Check lifetime chart limit (prevents delete-recreate abuse)
  const lifetimeLimit = PLAN_LIFETIME_CHART_LIMIT[plan] ?? 1;
  const totalCreated = await getTotalChartsCreated(userId);
  if (totalCreated >= lifetimeLimit) {
    res.status(403).json({
      error: `You've reached the lifetime limit of ${lifetimeLimit} profile${lifetimeLimit > 1 ? "s" : ""} for your plan. Upgrade for more.`,
      lifetimeLimit,
      totalCreated,
      requiredPlan: plan === "free" ? "pro" : "premium",
    });
    return;
  }

  // 3. Check daily creation quota
  const dailyLimit = getPlanDailyLimit(plan, "chart_create");
  const quota = checkDailyQuota(userId, "chart_create", dailyLimit);
  if (!quota.allowed) {
    res.status(429).json({
      error: `Daily chart creation limit reached (${quota.limit}/day). Try again tomorrow.`,
      dailyLimit: quota.limit,
      dailyUsed: quota.used,
    });
    return;
  }

  // All checks passed — create chart and increment lifetime counter
  const row = await createChart(userId, label.trim(), birth);
  await incrementChartsCreated(userId);
  res.status(201).json({ chart: toApi(row) });
});

chartsRouter.put("/:id", async (req: Request, res: Response) => {
  const { label, birth } = req.body ?? {};
  if (birth !== undefined && !validBirth(birth)) {
    res.status(400).json({ error: "Invalid birth data" });
    return;
  }
  const row = await updateChart(uid(req), req.params.id, {
    label: typeof label === "string" ? label.trim() : undefined,
    birth: birth !== undefined ? birth : undefined,
  });
  if (!row) {
    res.status(404).json({ error: "Chart not found" });
    return;
  }
  res.json({ chart: toApi(row) });
});

chartsRouter.delete("/:id", async (req: Request, res: Response) => {
  const ok = await deleteChart(uid(req), req.params.id);
  if (!ok) {
    res.status(404).json({ error: "Chart not found" });
    return;
  }
  res.json({ ok: true });
});

chartsRouter.get("/:id", async (req: Request, res: Response) => {
  const row = await getChart(uid(req), req.params.id);
  if (!row) {
    res.status(404).json({ error: "Chart not found" });
    return;
  }
  res.json({ chart: toApi(row) });
});

// ── Vastu settings (one per chart / profile) ──────────────────────────

chartsRouter.get("/:id/vastu", vastuEnabled, async (req: Request, res: Response) => {
  // Verify the chart belongs to the user
  const row = await getChart(uid(req), req.params.id);
  if (!row) { res.status(404).json({ error: "Chart not found" }); return; }
  const vastu = await getVastuSettings(req.params.id);
  res.json({ vastu: vastu ? { chartId: vastu.chart_id, questionnaire: vastu.questionnaire, floorPlan: vastu.floor_plan, updatedAt: Number(vastu.updated_at) } : null });
});

chartsRouter.put("/:id/vastu", vastuEnabled, async (req: Request, res: Response) => {
  const row = await getChart(uid(req), req.params.id);
  if (!row) { res.status(404).json({ error: "Chart not found" }); return; }
  const q = req.body?.questionnaire;
  if (!q || typeof q !== "object") { res.status(400).json({ error: "questionnaire object is required" }); return; }
  const floorPlan: string | null = typeof req.body?.floorPlan === "string" ? req.body.floorPlan : null;
  const vastu = await upsertVastuSettings(req.params.id, q, floorPlan);
  res.json({ vastu: { chartId: vastu.chart_id, questionnaire: vastu.questionnaire, floorPlan: vastu.floor_plan, updatedAt: Number(vastu.updated_at) } });
});

chartsRouter.delete("/:id/vastu", vastuEnabled, async (req: Request, res: Response) => {
  const row = await getChart(uid(req), req.params.id);
  if (!row) { res.status(404).json({ error: "Chart not found" }); return; }
  await deleteVastuSettings(req.params.id);
  res.json({ ok: true });
});
