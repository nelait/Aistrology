import { Router, type Request, type Response } from "express";
import { requireAdmin } from "./auth";
import { hashPassword } from "./password";
import {
  listAllUsers,
  listAllUsersWithStats,
  resolveUserNames,
  countUsers,
  countUsersByPlan,
  chartStats,
  recentSignups,
  chartsPerPlan,
  createUserWithRole,
  setUserRole,
  setUserSuspended,
  setUserPlan,
  findUserByEmail,
  listAllOffers,
  setOfferStatus,
  createNotification,
  createNotificationForUsers,
  allUserIds,
  getUser,
  listCharts,
  type UserRow,
  type OfferRow,
  listAllTemples,
  updateTemple,
  listFestivals,
  createFestival,
  updateFestival,
  deleteFestival,
  type FestivalRow,
  listPromoCodes,
  getPromoByCode,
  createPromoCode,
  updatePromoCode,
  deletePromoCode,
  type PromoCodeRow,
  listContactMessages,
  setContactStatus,
  type ContactMessageRow,
  listBillingEvents,
  type BillingEventRow,
  listFeedback,
  feedbackSummary,
  setFeedbackStatus,
  type FeedbackRow,
} from "./db";
import { runReminderCheck, runPlanExpiryCheck } from "./reminderScheduler";
import {
  getLlmPublicView,
  setLlmProviderKey,
  removeLlmProvider,
  setLlmActiveProvider,
} from "./llm";
import { getUsageStats, getUserDailyUsage, DEFAULT_PLAN_DAILY_LIMITS, QUOTA_PLANS, QUOTA_FEATURES } from "./rateLimit";
import { currentQuotas, saveQuotas, resetQuotas } from "./quotas";
import { hasActiveSubscription } from "./stripe";
import { getFeatures, setFeatures, FEATURE_META, FEATURE_KEYS, type FeatureKey } from "./features";

export const adminRouter = Router();

// Every admin route requires an admin-elevated session (access code supplied).
adminRouter.use(requireAdmin);

function adminUser(u: UserRow & { active_charts?: number }) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    provider: u.provider,
    plan: u.plan ?? "free",
    planSource: u.plan_source ?? null,
    role: u.role ?? "user",
    suspended: u.suspended ?? false,
    emailVerified: u.email_verified ?? false,
    totalChartsCreated: (u as any).total_charts_created ?? 0,
    activeCharts: u.active_charts ?? 0,
    createdAt: Number(u.created_at),
  };
}

function adminOffer(o: OfferRow & { owner_email?: string | null }) {
  return {
    id: o.id,
    displayName: o.display_name,
    headline: o.headline,
    bio: o.bio,
    specialties: o.specialties,
    languages: o.languages,
    rateInr: o.rate_inr,
    status: o.status,
    ownerEmail: o.owner_email ?? null,
    updatedAt: Number(o.updated_at),
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PLANS = ["free", "pro", "premium"];
const ROLES = ["user", "admin"];

// --- Dashboard -------------------------------------------------------------

adminRouter.get("/overview", async (_req, res) => {
  const [users, offers] = await Promise.all([countUsers(), listAllOffers()]);
  res.json({
    users,
    offers: offers.length,
    pendingOffers: offers.filter((o) => o.status === "pending").length,
    admins: (await listAllUsers()).filter((u) => u.role === "admin").length,
  });
});

// --- Usage stats (rate limiting dashboard) ---------------------------------

adminRouter.get("/usage", async (_req, res) => {
  const [
    planDist,
    charts,
    signups7d,
    signups30d,
    chartsByPlan,
  ] = await Promise.all([
    countUsersByPlan(),
    chartStats(),
    recentSignups(7),
    recentSignups(30),
    chartsPerPlan(),
  ]);

  // In-memory rate limiter stats (with resolved user names)
  const inMemory = getUsageStats();
  const userIds = inMemory.topDailyUsers.map((u) => u.userId);
  const nameMap = await resolveUserNames(userIds);
  const topUsersResolved = inMemory.topDailyUsers.map((u) => ({
    ...u,
    userName: nameMap[u.userId] ?? u.userId.slice(0, 8),
  }));

  res.json({
    planDistribution: planDist,
    charts: {
      activeTotal: charts.totalCharts,
      lifetimeTotal: charts.totalLifetime,
      byPlan: chartsByPlan,
    },
    signups: { last7d: signups7d, last30d: signups30d },
    rateLimit: {
      ...inMemory,
      topDailyUsers: topUsersResolved,
    },
  });
});

// --- Editable per-plan daily quotas ----------------------------------------

adminRouter.get("/quotas", (_req, res) => {
  res.json({
    limits: currentQuotas(),
    defaults: DEFAULT_PLAN_DAILY_LIMITS,
    plans: QUOTA_PLANS,
    features: QUOTA_FEATURES,
  });
});

adminRouter.put("/quotas", async (req, res) => {
  const { limits } = (req.body ?? {}) as { limits?: unknown };
  res.json({ limits: await saveQuotas(limits) });
});

adminRouter.post("/quotas/reset", async (_req, res) => {
  res.json({ limits: await resetQuotas() });
});

// --- Per-user usage drill-down ---------------------------------------------

adminRouter.get("/users/:id/usage", async (req, res) => {
  const target = await getUser(req.params.id);
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const charts = await listCharts(target.id);
  const dailyUsage = getUserDailyUsage(target.id);
  res.json({
    userId: target.id,
    name: target.name,
    email: target.email,
    plan: target.plan ?? "free",
    totalChartsCreated: (target as any).total_charts_created ?? 0,
    activeCharts: charts.length,
    emailVerified: target.email_verified ?? false,
    dailyUsage,
    charts: charts.map((c) => ({
      id: c.id,
      label: c.label,
      createdAt: Number(c.created_at),
      updatedAt: Number(c.updated_at),
    })),
  });
});

// --- User management -------------------------------------------------------

adminRouter.get("/users", async (_req, res) => {
  res.json({ users: (await listAllUsersWithStats()).map(adminUser) });
});

adminRouter.post("/users", async (req, res) => {
  const { email, password, name, plan, role } = (req.body ?? {}) as Record<string, string>;
  if (!email || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: "A valid email is required" });
    return;
  }
  if (!password || password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }
  if (plan && !PLANS.includes(plan)) {
    res.status(400).json({ error: "Invalid plan" });
    return;
  }
  if (role && !ROLES.includes(role)) {
    res.status(400).json({ error: "Invalid role" });
    return;
  }
  if (await findUserByEmail(email)) {
    res.status(409).json({ error: "That email is already registered" });
    return;
  }
  const user = await createUserWithRole({
    email: email.trim().toLowerCase(),
    name: name?.trim() || email.split("@")[0],
    passwordHash: hashPassword(password),
    plan: plan || "free",
    role: role || "user",
  });
  res.status(201).json({ user: adminUser(user) });
});

adminRouter.patch("/users/:id", async (req, res) => {
  const { plan, role, suspended } = (req.body ?? {}) as {
    plan?: string;
    role?: string;
    suspended?: boolean;
  };
  const target = await getUser(req.params.id);
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  // Guard: an admin can't demote or suspend themselves (avoid lock-out).
  const selfId = (req as Request & { userId: string }).userId;
  if (target.id === selfId && (role === "user" || suspended === true)) {
    res.status(400).json({ error: "You can't demote or suspend your own admin account." });
    return;
  }
  if (plan !== undefined) {
    if (!PLANS.includes(plan)) { res.status(400).json({ error: "Invalid plan" }); return; }
    // A local plan change can't stop/alter Stripe billing, so block edits for a
    // user with an active subscription — they must be managed in Stripe.
    if (await hasActiveSubscription(target.stripe_customer_id)) {
      res.status(409).json({
        error: "This user has an active Stripe subscription. Change or cancel it in Stripe — a manual plan change here won't affect their billing.",
      });
      return;
    }
    // Mark as a manual admin comp so the Stripe reconcile never overwrites it.
    await setUserPlan(target.id, plan, undefined, "manual");
  }
  if (role !== undefined) {
    if (!ROLES.includes(role)) { res.status(400).json({ error: "Invalid role" }); return; }
    await setUserRole(target.id, role);
  }
  if (suspended !== undefined) await setUserSuspended(target.id, Boolean(suspended));
  res.json({ user: adminUser((await getUser(target.id))!) });
});

// --- Consultation offer approvals ------------------------------------------

adminRouter.get("/offers", async (_req, res) => {
  res.json({ offers: (await listAllOffers()).map(adminOffer) });
});

adminRouter.post("/offers/:id/status", async (req, res) => {
  const { status } = (req.body ?? {}) as { status?: string };
  if (status !== "approved" && status !== "rejected" && status !== "pending") {
    res.status(400).json({ error: "Invalid status" });
    return;
  }
  const offer = await setOfferStatus(req.params.id, status);
  if (!offer) {
    res.status(404).json({ error: "Offer not found" });
    return;
  }
  // Let the provider know the outcome via an in-app notification.
  if (status === "approved") {
    await createNotification(offer.user_id, {
      title: "Your provider profile is live",
      body: `“${offer.display_name}” was approved and now appears in the consultation directory.`,
      level: "success",
    });
  } else if (status === "rejected") {
    await createNotification(offer.user_id, {
      title: "Provider profile needs changes",
      body: `“${offer.display_name}” wasn't approved. Please review and resubmit your profile.`,
      level: "warning",
    });
  }
  res.json({ offer: adminOffer(offer) });
});

// --- Notifications ---------------------------------------------------------

adminRouter.post("/notifications", async (req, res) => {
  const { target, userIds, title, body, level } = (req.body ?? {}) as {
    target?: string;
    userIds?: string[];
    title?: string;
    body?: string;
    level?: string;
  };
  if (!title?.trim() || !body?.trim()) {
    res.status(400).json({ error: "Title and body are required" });
    return;
  }
  const payload = { title: title.trim(), body: body.trim(), level: level || "info" };
  let sent = 0;
  if (target === "all") {
    sent = await createNotificationForUsers(await allUserIds(), payload);
  } else if (Array.isArray(userIds) && userIds.length > 0) {
    sent = await createNotificationForUsers(userIds, payload);
  } else {
    res.status(400).json({ error: "Choose a target (all users or specific users)" });
    return;
  }
  res.status(201).json({ sent });
});

// --- Global LLM configuration ----------------------------------------------

adminRouter.get("/llm", async (_req, res) => {
  res.json(await getLlmPublicView());
});

adminRouter.put("/llm/provider/:provider", async (req, res) => {
  try {
    const { apiKey, model } = (req.body ?? {}) as { apiKey?: string; model?: string };
    res.json(await setLlmProviderKey(req.params.provider, { apiKey, model }));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Failed to save" });
  }
});

adminRouter.delete("/llm/provider/:provider", async (req, res) => {
  res.json(await removeLlmProvider(req.params.provider));
});

adminRouter.put("/llm/active", async (req, res) => {
  try {
    const { provider } = (req.body ?? {}) as { provider?: string | null };
    res.json(await setLlmActiveProvider(provider ?? null));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Failed to set active" });
  }
});

// ── Temples ────────────────────────────────────────────────────────────

// Never expose the temple's password hash to the client.
function stripTemple<T extends { password_hash?: string | null }>(t: T) {
  const { password_hash, ...rest } = t;
  return rest;
}

adminRouter.get("/temples", async (_req, res) => {
  res.json({ temples: (await listAllTemples()).map(stripTemple) });
});

adminRouter.put("/temples/:id/status", async (req, res) => {
  const { status } = req.body as { status: string };
  if (!status || !["approved", "rejected"].includes(status)) {
    res.status(400).json({ error: "status must be approved or rejected" }); return;
  }
  const t = await updateTemple(req.params.id, { status });
  if (!t) { res.status(404).json({ error: "Temple not found" }); return; }
  res.json({ temple: stripTemple(t) });
});

// ── Feature flags ────────────────────────────────────────────────────────

adminRouter.get("/features", async (_req, res) => {
  res.json({
    features: await getFeatures(),
    meta: FEATURE_META,
  });
});

adminRouter.put("/features", async (req, res) => {
  const patch = (req.body ?? {}) as Record<string, unknown>;
  const clean: Partial<Record<FeatureKey, boolean>> = {};
  for (const k of FEATURE_KEYS) {
    if (typeof patch[k] === "boolean") clean[k] = patch[k] as boolean;
  }
  res.json({ features: await setFeatures(clean) });
});

// ── Festivals (admin-curated) + manual reminder run ─────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function apiFestival(f: FestivalRow) {
  return { id: f.id, name: f.name, description: f.description, eventDate: f.event_date, recurring: f.recurring };
}

adminRouter.get("/festivals", async (_req, res) => {
  res.json({ festivals: (await listFestivals()).map(apiFestival) });
});

adminRouter.post("/festivals", async (req, res) => {
  const { name, description, eventDate, recurring } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) { res.status(400).json({ error: "Name is required" }); return; }
  if (typeof eventDate !== "string" || !DATE_RE.test(eventDate)) { res.status(400).json({ error: "Valid date (YYYY-MM-DD) required" }); return; }
  const f = await createFestival({
    name: name.trim(),
    description: typeof description === "string" ? description.trim() : "",
    eventDate, recurring: recurring !== false,
  });
  res.status(201).json({ festival: apiFestival(f) });
});

adminRouter.put("/festivals/:id", async (req, res) => {
  const { name, description, eventDate, recurring } = req.body ?? {};
  if (eventDate !== undefined && (typeof eventDate !== "string" || !DATE_RE.test(eventDate))) {
    res.status(400).json({ error: "Invalid date" }); return;
  }
  const f = await updateFestival(req.params.id, {
    name: typeof name === "string" ? name.trim() : undefined,
    description: typeof description === "string" ? description.trim() : undefined,
    eventDate,
    recurring: typeof recurring === "boolean" ? recurring : undefined,
  });
  if (!f) { res.status(404).json({ error: "Festival not found" }); return; }
  res.json({ festival: apiFestival(f) });
});

adminRouter.delete("/festivals/:id", async (req, res) => {
  const ok = await deleteFestival(req.params.id);
  if (!ok) { res.status(404).json({ error: "Festival not found" }); return; }
  res.json({ ok: true });
});

adminRouter.post("/reminders/run", async (_req, res) => {
  const { sent } = await runReminderCheck();
  const { downgraded } = await runPlanExpiryCheck();
  res.json({ sent, downgraded });
});

// ── Promo codes ─────────────────────────────────────────────────────────

function apiPromo(p: PromoCodeRow & { redemptions?: number }) {
  return {
    id: p.id, code: p.code, plan: p.plan,
    expiresAt: p.expires_at ? Number(p.expires_at) : null,
    maxRedemptions: p.max_redemptions ?? null,
    durationDays: p.duration_days,
    enabled: p.enabled, redemptions: p.redemptions ?? 0,
    createdAt: Number(p.created_at),
  };
}

const DURATIONS = [7, 14, 30, 365];

adminRouter.get("/promos", async (_req, res) => {
  res.json({ promos: (await listPromoCodes()).map(apiPromo) });
});

adminRouter.post("/promos", async (req, res) => {
  const { code, plan, expiresAt, maxRedemptions, durationDays, enabled } = req.body ?? {};
  if (typeof code !== "string" || !code.trim()) { res.status(400).json({ error: "A code is required" }); return; }
  if (plan !== "pro" && plan !== "premium") { res.status(400).json({ error: "Plan must be pro or premium" }); return; }
  if (await getPromoByCode(code.trim())) { res.status(409).json({ error: "That code already exists" }); return; }
  const exp = expiresAt === null || expiresAt === undefined || expiresAt === "" ? null : Number(expiresAt);
  if (exp !== null && !Number.isFinite(exp)) { res.status(400).json({ error: "Invalid expiry" }); return; }
  const max = maxRedemptions === null || maxRedemptions === undefined || maxRedemptions === "" ? null : Math.max(1, Math.round(Number(maxRedemptions)));
  if (max !== null && !Number.isFinite(max)) { res.status(400).json({ error: "Invalid max redemptions" }); return; }
  const dur = DURATIONS.includes(Number(durationDays)) ? Number(durationDays) : 30;
  const p = await createPromoCode({
    code: code.trim().toUpperCase(), plan, expiresAt: exp,
    maxRedemptions: max, durationDays: dur, enabled: enabled !== false,
  });
  res.status(201).json({ promo: apiPromo(p) });
});

adminRouter.patch("/promos/:id", async (req, res) => {
  const { plan, expiresAt, maxRedemptions, durationDays, enabled } = req.body ?? {};
  if (plan !== undefined && plan !== "pro" && plan !== "premium") { res.status(400).json({ error: "Invalid plan" }); return; }
  const p = await updatePromoCode(req.params.id, {
    plan: plan === "pro" || plan === "premium" ? plan : undefined,
    expiresAt: expiresAt === undefined ? undefined : (expiresAt === null || expiresAt === "" ? null : Number(expiresAt)),
    maxRedemptions: maxRedemptions === undefined ? undefined : (maxRedemptions === null || maxRedemptions === "" ? null : Math.max(1, Math.round(Number(maxRedemptions)))),
    durationDays: durationDays !== undefined && DURATIONS.includes(Number(durationDays)) ? Number(durationDays) : undefined,
    enabled: typeof enabled === "boolean" ? enabled : undefined,
  });
  if (!p) { res.status(404).json({ error: "Promo code not found" }); return; }
  res.json({ promo: apiPromo(p) });
});

adminRouter.delete("/promos/:id", async (req, res) => {
  const ok = await deletePromoCode(req.params.id);
  if (!ok) { res.status(404).json({ error: "Promo code not found" }); return; }
  res.json({ ok: true });
});

// ── Contact-us messages ──────────────────────────────────────────────────

function apiContact(c: ContactMessageRow & { account_email?: string | null }) {
  return {
    id: c.id, name: c.name,
    email: c.email ?? c.account_email ?? null,
    category: c.category, message: c.message, status: c.status,
    fromAccount: Boolean(c.user_id),
    createdAt: Number(c.created_at),
  };
}

adminRouter.get("/contact", async (_req, res) => {
  res.json({ messages: (await listContactMessages()).map(apiContact) });
});

adminRouter.post("/contact/:id/status", async (req, res) => {
  const { status } = (req.body ?? {}) as { status?: string };
  if (!status || !["new", "read", "resolved"].includes(status)) {
    res.status(400).json({ error: "Invalid status" }); return;
  }
  const m = await setContactStatus(req.params.id, status);
  if (!m) { res.status(404).json({ error: "Message not found" }); return; }
  res.json({ message: apiContact(m) });
});

// ── Billing events (refunds / disputes from Stripe webhooks) ─────────────

function apiBillingEvent(b: BillingEventRow & { account_email?: string | null }) {
  return {
    id: b.id, kind: b.kind, detail: b.detail,
    email: b.account_email ?? null,
    amount: b.amount == null ? null : Number(b.amount),
    currency: b.currency, action: b.action,
    createdAt: Number(b.created_at),
  };
}

adminRouter.get("/billing-events", async (_req, res) => {
  res.json({ events: (await listBillingEvents()).map(apiBillingEvent) });
});

// ── Feature feedback ─────────────────────────────────────────────────────

function apiFeedback(f: FeedbackRow & { account_email?: string | null }) {
  return {
    id: f.id,
    feature: f.feature,
    rating: f.rating,
    comment: f.comment,
    status: f.status,
    email: f.account_email ?? null,
    createdAt: Number(f.created_at),
  };
}

adminRouter.get("/feedback", async (_req, res) => {
  const [entries, summary] = await Promise.all([listFeedback(), feedbackSummary()]);
  res.json({ entries: entries.map(apiFeedback), summary });
});

adminRouter.post("/feedback/:id/status", async (req, res) => {
  const { status } = (req.body ?? {}) as { status?: string };
  if (!status || !["new", "read", "actioned"].includes(status)) {
    res.status(400).json({ error: "Invalid status" });
    return;
  }
  const f = await setFeedbackStatus(req.params.id, status);
  if (!f) { res.status(404).json({ error: "Feedback not found" }); return; }
  res.json({ entry: apiFeedback(f) });
});
