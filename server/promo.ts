import { Router, type Request, type Response } from "express";
import { requireAuth } from "./auth";
import {
  getPromoByCode, getPromoRedemption, recordPromoRedemption, countPromoRedemptions,
  setUserPlanWithExpiry, getUser, createNotification,
} from "./db";

export const promoRouter = Router();

promoRouter.use(requireAuth);

function uid(req: Request): string {
  return (req as Request & { userId: string }).userId;
}

/** Redeem a promo code — grants Pro/Premium directly, bypassing Stripe. */
promoRouter.post("/redeem", async (req: Request, res: Response) => {
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  if (!code) { res.status(400).json({ error: "Enter a promo code." }); return; }

  const promo = await getPromoByCode(code);
  if (!promo) { res.status(404).json({ error: "That promo code isn't valid." }); return; }
  if (!promo.enabled) { res.status(400).json({ error: "This promo code is no longer active." }); return; }
  if (promo.expires_at && Date.now() > Number(promo.expires_at)) {
    res.status(400).json({ error: "This promo code has expired." }); return;
  }

  const userId = uid(req);
  if (await getPromoRedemption(promo.id, userId)) {
    res.status(400).json({ error: "You've already redeemed this code." }); return;
  }

  // Redemption cap
  if (promo.max_redemptions != null) {
    const used = await countPromoRedemptions(promo.id);
    if (used >= promo.max_redemptions) {
      res.status(400).json({ error: "This promo code has reached its redemption limit." });
      return;
    }
  }

  const user = await getUser(userId);
  const current = user?.plan ?? "free";
  // A permanent paid plan (a real Stripe subscription — no promo expiry) must not
  // be shadowed by a temporary promo, or the promo's expiry would later downgrade
  // a paying customer. Those users manage their plan through Stripe. Free users
  // and existing promo holders can redeem (the latter replaces/extends the grant).
  if (current !== "free" && !user?.plan_expires_at) {
    res.status(400).json({
      error: "You already have an active subscription — promo codes are for accounts on the Basic (Free) plan. Manage your subscription in Billing.",
    });
    return;
  }

  const durationDays = promo.duration_days || 30;
  const expiresAt = Date.now() + durationDays * 86_400_000;
  await setUserPlanWithExpiry(userId, promo.plan, expiresAt);
  await recordPromoRedemption(promo.id, userId);

  const label = promo.plan.charAt(0).toUpperCase() + promo.plan.slice(1);
  const until = new Date(expiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  await createNotification(userId, {
    title: "Plan upgraded 🎉",
    body: `Your promo code was applied — you're on the ${label} plan until ${until}, then it reverts to Basic (Free).`,
    level: "success",
  });
  res.json({ plan: promo.plan, planExpiresAt: expiresAt });
});
