import { Router, type Request, type Response } from "express";
import { requireAuth } from "./auth";
import { createFeedback, getUserPlan } from "./db";
import { checkDailyQuota, getPlanDailyLimit } from "./rateLimit";

// "Was this helpful?" submissions from the feature widgets. Read back in the
// admin console (see server/admin.ts → /api/admin/feedback).
export const feedbackRouter = Router();
feedbackRouter.use(requireAuth);

const RATINGS = new Set(["up", "down"]);
const MAX_COMMENT = 2000;
const MAX_FEATURE = 60;

function uid(req: Request): string {
  return (req as Request & { userId: string }).userId;
}

feedbackRouter.post("/", async (req: Request, res: Response) => {
  const { feature, rating, comment } = (req.body ?? {}) as {
    feature?: string; rating?: string; comment?: string;
  };

  if (typeof feature !== "string" || !feature.trim()) {
    res.status(400).json({ error: "A feature is required." });
    return;
  }
  if (typeof rating !== "string" || !RATINGS.has(rating)) {
    res.status(400).json({ error: "Rating must be 'up' or 'down'." });
    return;
  }

  // Rate limited so a bored user (or a script) can't flood the admin view.
  const userId = uid(req);
  const plan = await getUserPlan(userId);
  const quota = checkDailyQuota(userId, "feedback", getPlanDailyLimit(plan, "feedback"));
  if (!quota.allowed) {
    res.status(429).json({
      error: `Daily feedback limit reached (${quota.limit}/day). Thanks — we've heard you!`,
      dailyLimit: quota.limit,
      dailyUsed: quota.used,
    });
    return;
  }

  await createFeedback({
    userId,
    feature: feature.trim().slice(0, MAX_FEATURE),
    rating,
    comment: typeof comment === "string" ? comment.trim().slice(0, MAX_COMMENT) : "",
  });
  res.json({ ok: true });
});
