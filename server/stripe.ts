import { Router, type Request, type Response } from "express";
import Stripe from "stripe";
import { config } from "./config";
import { currentUserId, requireAuth } from "./auth";
import {
  getUser, setUserPlan, setStripeCustomerId, findUserByStripeCustomer,
  createNotification, createNotificationForUsers, listAdminIds, markPlanDisputed,
  recordBillingEvent,
} from "./db";

export const billingRouter = Router();

// Plan hierarchy for comparison
const PLAN_RANK: Record<string, number> = { free: 0, pro: 1, premium: 2 };

function planFromPriceId(priceId: string): string {
  if (priceId === config.stripe.proPriceId) return "pro";
  if (priceId === config.stripe.premiumPriceId) return "premium";
  return "free";
}

function getStripe(): Stripe | null {
  if (!config.stripe.secretKey) return null;
  return new Stripe(config.stripe.secretKey);
}

/** Whether a Stripe customer has a subscription that is billing (or in dunning). */
export async function hasActiveSubscription(customerId: string | null): Promise<boolean> {
  const stripe = getStripe();
  if (!stripe || !customerId) return false;
  try {
    const subs = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 10 });
    return subs.data.some((s) => ["active", "trialing", "past_due", "unpaid"].includes(s.status));
  } catch {
    return false; // Stripe unreachable / unknown customer → treat as no active sub
  }
}

/** Push an in-app notification to every active admin (for billing/refund/dispute visibility). */
async function notifyAdmins(payload: { title: string; body: string; level?: string }): Promise<void> {
  const ids = await listAdminIds();
  if (ids.length) await createNotificationForUsers(ids, payload);
}

function customerIdOf(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : v.id;
}

/** Resolve the app user behind a Stripe charge id (charge → customer → user). */
async function userFromChargeId(stripe: Stripe, chargeId: string) {
  const charge = await stripe.charges.retrieve(chargeId);
  const customerId = customerIdOf(charge.customer as string | { id: string } | null);
  if (!customerId) return null;
  return findUserByStripeCustomer(customerId);
}

/** The plan a customer's live (active/trialing) subscription grants, else "free". */
async function livePlanForCustomer(stripe: Stripe, customerId: string): Promise<string> {
  const subs = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 10 });
  const active = subs.data.find((s) => ["active", "trialing"].includes(s.status));
  const priceId = active?.items.data[0]?.price.id ?? "";
  return active ? planFromPriceId(priceId) : "free";
}

// ---------- GET /api/billing/status ------------------------------------------

/**
 * Returns the user's plan plus live subscription details. Reconciles the stored
 * plan with Stripe (covers missed webhooks) — but never touches an active promo
 * grant (those have plan_expires_at set and aren't Stripe-driven).
 */
billingRouter.get("/status", requireAuth, async (req, res) => {
  const uid = (req as Request & { userId: string }).userId;
  const user = await getUser(uid);
  const stripe = getStripe();
  let plan = user?.plan ?? "free";
  let subscription: {
    status: string; plan: string; currentPeriodEnd: number | null; cancelAtPeriodEnd: boolean;
  } | null = null;
  let reconciled = false;

  // Never reconcile a promo grant, an admin comp, or a chargeback-suspended plan.
  const onPromo = Boolean(user?.plan_expires_at);
  const isManualComp = user?.plan_source === "manual";
  const isDisputed = user?.plan_source === "disputed";
  if (stripe && user?.stripe_customer_id && !onPromo && !isManualComp && !isDisputed) {
    try {
      const subs = await stripe.subscriptions.list({
        customer: user.stripe_customer_id, status: "all", limit: 10,
      });
      // Prefer a live subscription; fall back to the most recent.
      const live = ["active", "trialing", "past_due", "unpaid", "paused"];
      const sub =
        subs.data.find((s) => live.includes(s.status)) ??
        subs.data.sort((a, b) => b.created - a.created)[0];

      if (sub) {
        const priceId = sub.items.data[0]?.price.id ?? "";
        const entitled = sub.status === "active" || sub.status === "trialing";
        const stripePlan = entitled ? planFromPriceId(priceId) : "free";
        const anySub = sub as unknown as { current_period_end?: number; items: { data: Array<{ current_period_end?: number }> } };
        const periodEndSec = anySub.current_period_end ?? anySub.items.data[0]?.current_period_end ?? null;
        subscription = {
          status: sub.status,
          plan: planFromPriceId(priceId),
          currentPeriodEnd: periodEndSec ? periodEndSec * 1000 : null,
          cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
        };
        if (stripePlan !== plan) {
          await setUserPlan(uid, stripePlan);
          plan = stripePlan;
          reconciled = true;
        }
      } else if (plan !== "free") {
        // Customer exists but has no subscription → should be free.
        await setUserPlan(uid, "free");
        plan = "free";
        reconciled = true;
      }
    } catch (e) {
      console.warn("[stripe] status reconcile failed:", (e as Error).message);
    }
  }

  res.json({ plan, stripeConfigured: Boolean(config.stripe.secretKey), subscription, reconciled });
});

// ---------- POST /api/billing/checkout ---------------------------------------

billingRouter.post("/checkout", requireAuth, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    res.status(503).json({ error: "Stripe not configured. Set STRIPE_SECRET_KEY in .env" });
    return;
  }

  const uid = (req as Request & { userId: string }).userId;
  const user = await getUser(uid);
  if (!user) { res.status(401).json({ error: "User not found" }); return; }

  const { plan } = req.body as { plan?: string };
  const priceId = plan === "premium" ? config.stripe.premiumPriceId
    : plan === "pro" ? config.stripe.proPriceId
    : null;

  if (!priceId) {
    res.status(400).json({ error: "Invalid plan. Use 'pro' or 'premium'." });
    return;
  }

  // Find or create Stripe customer
  let customerId = user.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email ?? undefined,
      name: user.name ?? undefined,
      metadata: { user_id: uid },
    });
    customerId = customer.id;
    // Only persist the customer id here — don't touch the plan/promo expiry.
    // The real plan is granted by the webhook once checkout completes.
    await setStripeCustomerId(uid, customerId);
  }

  // Create Checkout Session
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${config.appUrl}?billing=success`,
    cancel_url: `${config.appUrl}?billing=cancel`,
    subscription_data: {
      metadata: { user_id: uid, plan: plan! },
    },
  });

  res.json({ url: session.url });
});

// ---------- POST /api/billing/portal -----------------------------------------

billingRouter.post("/portal", requireAuth, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    res.status(503).json({ error: "Stripe not configured" });
    return;
  }

  const uid = (req as Request & { userId: string }).userId;
  const user = await getUser(uid);
  if (!user?.stripe_customer_id) {
    res.status(400).json({ error: "No active subscription" });
    return;
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripe_customer_id,
    return_url: `${config.appUrl}?tab=billing`,
  });

  res.json({ url: session.url });
});

// ---------- POST /api/billing/webhook ----------------------------------------
// NOTE: This handler receives raw body (configured in index.ts with express.raw)

billingRouter.post("/webhook", async (req: Request, res: Response) => {
  const stripe = getStripe();
  if (!stripe) { res.status(503).send("Stripe not configured"); return; }

  const sig = req.headers["stripe-signature"];
  if (!sig) { res.status(400).send("Missing stripe-signature header"); return; }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body as Buffer,
      sig,
      config.stripe.webhookSecret,
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", (err as Error).message);
    res.status(400).send("Webhook signature verification failed");
    return;
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode === "subscription" && session.customer) {
          const customerId = typeof session.customer === "string"
            ? session.customer : session.customer.id;
          const user = await findUserByStripeCustomer(customerId);
          if (user && session.subscription) {
            // Look up the subscription to find the price → plan
            const subId = typeof session.subscription === "string"
              ? session.subscription : session.subscription.id;
            const sub = await stripe.subscriptions.retrieve(subId);
            const priceId = sub.items.data[0]?.price.id ?? "";
            const plan = planFromPriceId(priceId);
            await setUserPlan(user.id, plan, customerId);
            console.log(`[stripe] User ${user.id} upgraded to ${plan}`);
          }
        }
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        const user = await findUserByStripeCustomer(customerId);
        if (user) {
          const priceId = sub.items.data[0]?.price.id ?? "";
          const plan = sub.status === "active" || sub.status === "trialing"
            ? planFromPriceId(priceId) : "free";
          await setUserPlan(user.id, plan);
          console.log(`[stripe] User ${user.id} subscription updated → ${plan} (${sub.status})`);
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        const user = await findUserByStripeCustomer(customerId);
        if (user) {
          await setUserPlan(user.id, "free");
          console.log(`[stripe] User ${user.id} subscription cancelled → free`);
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = typeof invoice.customer === "string"
          ? invoice.customer : invoice.customer?.id;
        if (customerId) {
          const user = await findUserByStripeCustomer(customerId);
          if (user) {
            console.warn(`[stripe] Payment failed for user ${user.id}`);
            // Stripe handles dunning/retries; nudge the user to fix their card.
            await createNotification(user.id, {
              title: "Payment failed",
              body: "We couldn't process your subscription payment. Update your card in Plans & Billing → Manage Subscription to keep your plan.",
              level: "warning",
            });
          }
        }
        break;
      }

      // (a) A refund was issued in the Stripe Dashboard. We never move money here —
      // just notify the user and admins. A refund does NOT by itself cancel the
      // subscription, so access is intentionally left unchanged.
      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge;
        const customerId = customerIdOf(charge.customer as string | { id: string } | null);
        if (customerId) {
          const user = await findUserByStripeCustomer(customerId);
          if (user) {
            const full = charge.refunded && charge.amount_refunded >= charge.amount;
            const amount = (charge.amount_refunded / 100).toFixed(2);
            const cur = (charge.currency || "").toUpperCase();
            console.log(`[stripe] Refund for user ${user.id}: ${cur} ${amount} (full=${full})`);
            await createNotification(user.id, {
              title: full ? "Refund issued" : "Partial refund issued",
              body: `A refund of ${cur} ${amount} is on its way to your original payment method. This does not change your plan — manage your subscription any time in Plans & Billing.`,
              level: "info",
            });
            await notifyAdmins({
              title: `Refund: ${user.email ?? user.id}`,
              body: `${full ? "Full" : "Partial"} refund of ${cur} ${amount}. Access is unchanged — cancel the subscription in Stripe if it should also end.`,
              level: "warning",
            });
            await recordBillingEvent({
              userId: user.id, kind: "refund",
              detail: `${full ? "Full" : "Partial"} refund to ${user.email ?? user.id}`,
              amount: charge.amount_refunded, currency: cur, action: "notified (access unchanged)",
            });
          }
        }
        break;
      }

      // (b) A dispute/chargeback was opened. This is adversarial, so revoke the
      // paid plan immediately (mark 'disputed' so reconcile won't restore it) and
      // alert both the user and admins.
      case "charge.dispute.created": {
        const dispute = event.data.object as Stripe.Dispute;
        const chargeId = customerIdOf(dispute.charge as string | { id: string } | null);
        if (chargeId) {
          const user = await userFromChargeId(stripe, chargeId);
          if (user) {
            console.warn(`[stripe] Dispute opened for user ${user.id} → revoking access`);
            await markPlanDisputed(user.id);
            await createNotification(user.id, {
              title: "Plan suspended — payment dispute",
              body: "A payment dispute (chargeback) was opened on your account, so your paid plan has been suspended. If this was a mistake, please withdraw the dispute with your bank or contact us.",
              level: "warning",
            });
            await notifyAdmins({
              title: `⚠ Chargeback: ${user.email ?? user.id}`,
              body: `A dispute was opened (reason: ${dispute.reason ?? "unknown"}). Access was revoked (plan → free, marked 'disputed'). Respond in the Stripe Dashboard.`,
              level: "warning",
            });
            await recordBillingEvent({
              userId: user.id, kind: "dispute_opened",
              detail: `Dispute opened (reason: ${dispute.reason ?? "unknown"})`,
              amount: dispute.amount, currency: (dispute.currency || "").toUpperCase(),
              action: "access revoked",
            });
          }
        }
        break;
      }

      // On dispute resolution: restore the live plan if we won, otherwise leave the
      // access revoked. Either way, keep admins informed.
      case "charge.dispute.closed": {
        const dispute = event.data.object as Stripe.Dispute;
        const chargeId = customerIdOf(dispute.charge as string | { id: string } | null);
        if (chargeId) {
          const charge = await stripe.charges.retrieve(chargeId);
          const customerId = customerIdOf(charge.customer as string | { id: string } | null);
          const user = customerId ? await findUserByStripeCustomer(customerId) : null;
          if (user && customerId) {
            if (dispute.status === "won") {
              const plan = await livePlanForCustomer(stripe, customerId);
              await setUserPlan(user.id, plan, customerId);
              console.log(`[stripe] Dispute won for user ${user.id} → restored plan ${plan}`);
              await createNotification(user.id, {
                title: "Access restored",
                body: `The payment dispute was resolved in your favour — your ${plan === "free" ? "account" : plan + " plan"} has been restored.`,
                level: "success",
              });
              await notifyAdmins({
                title: `Dispute won: ${user.email ?? user.id}`,
                body: `Dispute resolved (won). Plan restored to ${plan}.`,
                level: "info",
              });
              await recordBillingEvent({
                userId: user.id, kind: "dispute_closed",
                detail: "Dispute resolved: won",
                amount: dispute.amount, currency: (dispute.currency || "").toUpperCase(),
                action: `plan restored to ${plan}`,
              });
            } else {
              console.warn(`[stripe] Dispute ${dispute.status} for user ${user.id} → access stays revoked`);
              await notifyAdmins({
                title: `Dispute ${dispute.status}: ${user.email ?? user.id}`,
                body: `Dispute closed as ${dispute.status}. Access remains suspended.`,
                level: "warning",
              });
              await recordBillingEvent({
                userId: user.id, kind: "dispute_closed",
                detail: `Dispute resolved: ${dispute.status}`,
                amount: dispute.amount, currency: (dispute.currency || "").toUpperCase(),
                action: "access remains revoked",
              });
            }
          }
        }
        break;
      }
    }
  } catch (err) {
    console.error("[stripe] Webhook handler error:", err);
  }

  res.json({ received: true });
});
