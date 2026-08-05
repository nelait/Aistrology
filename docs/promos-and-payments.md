# Promos & Payments

How plans are granted in Aistrology — via **Stripe subscriptions** (paid) or
**promo codes** (temporary, admin-issued) — and how the two stay compatible.

## Plans

| Plan | Internal id | Notes |
| ---- | ----------- | ----- |
| Basic | `free` | Default. "Basic" and "Free" refer to the same tier. |
| Pro | `pro` | Paid, or promo-granted. |
| Premium | `premium` | Paid, or promo-granted. "Ideal for professionals". |

## Source of truth

A user's entitlement is derived from three columns on `users`:

| Column | Meaning |
| ------ | ------- |
| `plan` | `free` \| `pro` \| `premium` — the active plan. |
| `plan_expires_at` | If set, the plan is a **temporary promo grant** that reverts to `free` after this time. If `NULL`, the plan is **permanent** (a real Stripe subscription, an admin comp, or plain free). |
| `plan_source` | How the plan was granted: `stripe` (a subscription), `manual` (an admin comp), `promo`, `disputed` (access revoked by a chargeback — see [Refunds & disputes](#refunds--disputes)), or `null` (free). Lets the Stripe reconcile leave comps / promos / disputed users alone. |
| `stripe_customer_id` | The Stripe customer, once the user has started checkout. |

**The golden rule:** `plan_expires_at` is set **only** by promo redemptions.
Anything that grants a real/permanent plan clears it. This is what keeps the
promo auto-downgrade job from ever touching a paying customer.

---

## Payments (Stripe)

### Configuration (`.env`)

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...          # from `stripe listen` or the Dashboard
STRIPE_PRO_PRICE_ID=price_...
STRIPE_PREMIUM_PRICE_ID=price_...
```

When `STRIPE_SECRET_KEY` is unset, the checkout endpoints return 503 and only
promo codes / admin plan changes can grant paid plans.

### Flow

1. **Checkout** — `POST /api/billing/checkout { plan }` creates a Stripe
   Checkout session. On a user's first checkout a Stripe **customer** is created
   and its id stored via `setStripeCustomerId()` — this does **not** change the
   plan or clear a promo expiry (the plan is only granted once payment
   completes).
2. **Webhook** — `POST /api/billing/webhook` (raw body, signature-verified):
   - `checkout.session.completed` → `setUserPlan(plan)` — grants the paid plan.
   - `customer.subscription.updated` → `active`/`trialing` ⇒ plan from price id;
     any other status ⇒ `free`.
   - `customer.subscription.deleted` → `free`.
   - `invoice.payment_failed` → logged, **and** the user gets an in-app
     "Payment failed — update your card" notification. The actual downgrade
     happens when the subscription status turns non-active (see below).
   - `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed` →
     refunds and chargebacks. See [Refunds & disputes](#refunds--disputes).
3. **Manage / cancel** — `POST /api/billing/portal` opens the Stripe billing
   portal, where the user cancels or updates their card. Cancelling "at period
   end" keeps access until the period ends (`subscription.updated` keeps the
   plan); the final `subscription.deleted` then drops them to `free`.

### Blocking on non-payment

Access is gated purely by `users.plan`. When a failed renewal moves the Stripe
subscription to `past_due` / `unpaid` / `canceled`, `customer.subscription.updated`
grants the plan **only** for `active`/`trialing` status — otherwise `free`. So a
failed payment blocks paid features; a later successful retry restores them.

### Status & reconciliation (missed-webhook safety net)

`GET /api/billing/status` returns `{ plan, stripeConfigured, subscription,
reconciled }`. When the user has a Stripe customer (and isn't on an active
promo), it fetches the live subscription, surfaces its **status**, **renewal /
cancel date**, and `cancelAtPeriodEnd`, and **reconciles** the stored plan with
Stripe — catching any webhook that was missed. The Billing view calls this on
open and refreshes the app if the plan changed. It never touches a promo grant
(`plan_expires_at` set).

`setUserPlan()` **always sets `plan_expires_at = NULL`** — a real subscription is
never a temporary grant. Files: [`server/stripe.ts`](../server/stripe.ts),
`setUserPlan` / `setStripeCustomerId` in [`server/db.ts`](../server/db.ts).

---

## Refunds & disputes

**The app never issues refunds and never moves money.** Refunds are executed by a
human operator in the **Stripe Dashboard**; the app only *reacts* to the webhook
events Stripe emits — notifying people, revoking access on a chargeback, and
recording an audit trail. Nothing here calls a Stripe "refund" or "transfer" API.

### Refund — `charge.refunded` (notify only)

When an operator refunds a charge in Stripe:

- The **user** gets an in-app "Refund issued" / "Partial refund issued"
  notification with the amount (full vs. partial is detected from
  `amount_refunded >= amount`).
- All **admins** get a notification.
- A `billing_events` row is recorded (`kind = 'refund'`,
  `action = 'notified (access unchanged)'`).

**Access is deliberately left unchanged.** A refund does not by itself cancel a
subscription, so the plan is untouched — if access should also end, the operator
cancels the subscription in Stripe (which then flows through
`customer.subscription.deleted` → `free`). Notify-only is the safe default so an
automated system never revokes a plan a human didn't intend to end.

### Dispute opened — `charge.dispute.created` (revoke access)

A dispute (chargeback) is adversarial — the cardholder told their bank the charge
was wrong. On this event the app **immediately revokes the paid plan**:

- `markPlanDisputed(user.id)` sets `plan = 'free'`, `plan_expires_at = NULL`, and
  **`plan_source = 'disputed'`**.
- The user is notified ("Plan suspended — payment dispute") and admins get a
  `⚠ Chargeback` alert including the dispute reason.
- A `billing_events` row is recorded (`kind = 'dispute_opened'`,
  `action = 'access revoked'`).

**Why the `disputed` marker matters:** a dispute does **not** cancel the Stripe
subscription, so it is still `active`. Without a marker, the next
[reconcile-on-load](#status--reconciliation-missed-webhook-safety-net) would see
the active subscription and *restore* the plan — undoing the revoke. The
reconcile therefore **skips `plan_source = 'disputed'`** (just as it skips
`manual` comps and promo grants), so the revoke holds until the dispute closes.

### Dispute closed — `charge.dispute.closed` (restore or keep revoked)

- **Won** → the plan is restored from the customer's live subscription
  (`livePlanForCustomer` → `setUserPlan`, which clears the `disputed` marker); the
  user is notified "Access restored"; `billing_events` records
  `action = 'plan restored to <plan>'`.
- **Lost / other** → access **stays revoked**; admins are notified;
  `billing_events` records `action = 'access remains revoked'`.

### Admin visibility

Two surfaces, both fed by the events above:

1. **Notifications** — every refund/dispute pushes an in-app notification to all
   admins (via `notifyAdmins` → `listAdminIds` → `createNotificationForUsers`).
2. **Audit trail** — a persistent, read-only list under **Admin console →
   Billing** (`GET /api/admin/billing-events`, backed by the `billing_events`
   table). Unlike notifications (which get marked read), this is a durable
   history showing kind, amount, account, detail, the action taken, and time.

### Required Stripe webhook events

The endpoint must be subscribed to these event types (in addition to the four
subscription/invoice events): `charge.refunded`, `charge.dispute.created`,
`charge.dispute.closed`. Add them under **Developers → Webhooks → (endpoint) →
Select events**, or include them in your `stripe listen` forward.

### Summary

| Event | Access change | User notified | Admin notified | `billing_events` |
| ----- | ------------- | ------------- | -------------- | ---------------- |
| `charge.refunded` | none (by design) | yes | yes | `refund` |
| `charge.dispute.created` | **revoked** → `free` / `disputed` | yes | yes | `dispute_opened` |
| `charge.dispute.closed` (won) | restored to live plan | yes | yes | `dispute_closed` |
| `charge.dispute.closed` (lost) | stays revoked | no | yes | `dispute_closed` |

Files: [`server/stripe.ts`](../server/stripe.ts) (webhook cases, `notifyAdmins`,
`livePlanForCustomer`), `markPlanDisputed` / `recordBillingEvent` /
`listBillingEvents` / `listAdminIds` in [`server/db.ts`](../server/db.ts),
`GET /api/admin/billing-events` in [`server/admin.ts`](../server/admin.ts),
Billing section in [`src/components/AdminView.tsx`](../src/components/AdminView.tsx).

---

## Promo codes

Admin-issued codes that grant Pro/Premium **for a fixed duration**, bypassing
Stripe. Managed under **Admin console → Promo Codes**.

### Creating a code (admin)

Fields: **Code**, **Grants** (Pro/Premium), **Duration** (1 week / 2 weeks /
1 month / 1 year), **Max redemptions** (blank = unlimited), **Code valid until**
(optional date the code stops being redeemable), and enable/disable.

Endpoints: `GET/POST/PATCH/DELETE /api/admin/promos`. Storage: `promo_codes`
(+ `promo_redemptions`).

### Redeeming (user)

In **Plans & Billing → "Have a promo code?"**, or `POST /api/promo/redeem { code }`.
Validation order:

1. Code exists, is **enabled**, and is within its **valid-until** window.
2. The user hasn't **already redeemed** this code (once per user).
3. The code is under its **max-redemptions** cap.
4. The user is **not on a permanent paid plan** (see compatibility below).

On success: `setUserPlanWithExpiry(plan, now + duration)`, a redemption row is
recorded, and the user gets a "Plan upgraded 🎉" notification stating the expiry
date. Files: [`server/promo.ts`](../server/promo.ts).

### Auto-downgrade

A scheduled job reverts lapsed grants back to Basic (Free):

- Runs **hourly** (and 10 s after boot) via the scheduler, and on demand from
  **Admin → Reminders → "Run reminder check now"**.
- `runPlanExpiryCheck()` → `listExpiredPromoUsers()` (rows where
  `plan_expires_at < now` and `plan <> 'free'`) → `downgradeToFree()` + a
  "Promo plan ended" notification.

Because the query only selects rows **with `plan_expires_at` set**, and only
promos ever set that column, the job can only expire promo grants.
File: [`server/reminderScheduler.ts`](../server/reminderScheduler.ts).

---

## Compatibility rules (Stripe ⇄ promos)

The two systems share `plan` / `plan_expires_at`. These rules keep them safe:

1. **A real subscription is permanent.** Every Stripe-driven plan change
   (`setUserPlan`) clears `plan_expires_at`. So a former promo user who later
   subscribes is **never** wrongly downgraded when the old promo would have
   lapsed.
2. **A promo can't shadow a subscription.** Redemption is blocked for anyone on a
   permanent paid plan (`plan != free && plan_expires_at IS NULL`) — otherwise
   the promo's expiry could later downgrade a paying customer below the tier they
   pay for. They manage their plan through Stripe instead.
3. **The downgrade job never touches subscribers.** It only acts on rows with
   `plan_expires_at` set (promo grants only).
4. **Starting checkout is side-effect-free.** Creating the Stripe customer stores
   only the customer id; the plan/expiry are untouched until the webhook confirms
   payment.

### Interaction matrix

| Scenario | Result |
| -------- | ------ |
| Free user redeems a promo | Temporary plan + expiry; reverts to Basic when it lapses |
| Promo user redeems again | Replaces/extends the grant |
| Promo user later subscribes (Stripe) | Expiry cleared → permanent; never wrongly downgraded |
| Stripe subscriber redeems a promo | **Blocked** — "manage your subscription in Billing" |
| Downgrade job runs on a subscriber | No-op (their `plan_expires_at` is `NULL`) |
| Stripe subscription cancelled | Reverts to `free` (webhook) |

---

## Admin operations

- **Grant/adjust a plan directly (comp):** Admin console → **Users** → change a
  user's plan. This is a permanent **manual comp** (`plan_source = 'manual'`):
  - Marked `manual`, so the Stripe reconcile-on-load **won't overwrite it** even
    for users who have a Stripe customer id (e.g. a former subscriber). Shown as
    a **COMP** tag in the Users table.
  - **Blocked (409)** if the target has an **active Stripe subscription** — a
    local change can't stop billing, so those users must be managed in Stripe.
- **Issue promos:** Admin console → **Promo Codes**.
- **Force an expiry sweep:** Admin console → **Reminders** → "Run reminder check
  now" (also processes promo downgrades).

> Note: a real Stripe subscription (via the webhook) supersedes a comp — it sets
> `plan_source = 'stripe'`. Comps are intended for users who don't have an active
> subscription.

## Operational notes & limitations

- **Webhooks must be configured** for cancellations and payment failures to
  reflect: set `STRIPE_WEBHOOK_SECRET` and register the endpoint (dev:
  `stripe listen --forward-to localhost:8787/api/billing/webhook`). The
  reconcile-on-load in `GET /api/billing/status` is a safety net for missed
  webhooks, but it only runs when a user opens Billing.
- **`past_due` is treated as an immediate block** (no grace period). To allow a
  grace window, keep the plan while `past_due` and only drop on `canceled`.
- **Promo expiry precision:** access is read from `users.plan` and the downgrade
  sweep runs hourly, so a user may keep a promo plan up to ~1 hour past its exact
  expiry. For to-the-second precision, treat a lapsed grant as `free` at read
  time in `getUserPlan` / `/auth/me`.
