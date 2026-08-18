# Rate Limiting & Abuse Prevention

Shastri enforces rate limits at multiple layers to control LLM costs,
prevent abuse, and protect server resources. All limits run **in-memory**
(no Redis required) and reset on server restart.

## Global Limits

| Scope | Limit | Window | Notes |
| ----- | ----- | ------ | ----- |
| **All API requests** | 100 per IP | 1 minute | Safety net against bots and scripts |
| **Registration** | 3 per IP | 1 hour | Prevents throwaway-account spam |
| **Admin login** | 5 per IP | 15 minutes | Brute-force lockout |

## Chart / Profile Limits

Chart creation is protected by **three independent checks**, all of which
must pass:

1. **Active profile limit** — maximum concurrent saved profiles.
2. **Lifetime chart counter** — total profiles ever created (prevents
   the *delete → recreate* bypass).
3. **Daily creation quota** — caps the number of new profiles per day.

| Check | Free | Pro | Premium |
| ----- | ---- | --- | ------- |
| Active profiles | 1 | 2 | 10 |
| Lifetime total | 1 | 5 | 30 |
| Daily creates | 3 | 10 | 30 |

> The lifetime counter is stored in the `total_charts_created` column on the
> `users` table and is incremented atomically on every `POST /api/charts`.
> Deleting a profile does **not** decrement it.

## LLM Endpoint Limits

Most AI endpoints (`/api/llm/justify`, `/api/llm/justify/stream`,
`/api/llm/translate`) are **blocked for free-plan users** (HTTP 403). Paid
users are subject to daily quotas. **Astro Chat is the exception** — it is *not*
paid-gated (free users get a small daily allowance as an upgrade hook):

| Endpoint | Free | Pro | Premium |
| -------- | ---- | --- | ------- |
| Justify | ✗ blocked | 30 / day | 100 / day |
| Justify (stream) | ✗ blocked | 30 / day | 100 / day |
| Translate | ✗ blocked | 20 / day | 60 / day |
| **Astro Chat** (`/api/llm/chat/stream`) | **5 / day** | 50 / day | 200 / day |

A `429` returns the remaining quota; the chat panel turns a free-user `429` into
an upgrade prompt. See [Astro Chat](astro-chat.md).

## Event narration

The **✦ Explain this in plain words** button on a life event does not have a
quota of its own — it reuses `/api/llm/justify/stream` outright, so it draws on
the **Justify (streaming)** allowance above and inherits its Pro/Premium gate.
Free users are not shown the button rather than being given one that always
returns 403. See [Life events](life-events.md).

The rectification scan itself is **not** quota'd: it runs entirely in the
browser and costs the server nothing. Nor is storing life events.

## Feature Feedback

The per-module "Was this helpful?" widget writes to a quota too, so a bored user
or a script can't flood the admin view:

| Endpoint | Free | Pro | Premium |
| -------- | ---- | --- | ------- |
| Feedback (`POST /api/feedback`) | 20 / day | 40 / day | 60 / day |

Exceeding it returns `429` and the widget shows the message instead of
pretending the feedback was recorded. See [Feature Feedback](feedback.md).

### Editing the limits (Admin)

All the per-plan daily numbers above (and the booking / new-chart / feedback quotas) are
**editable in the admin console** — no code deploy needed. **Admin console →
Plan Limits** shows a plan × feature grid; edits are saved to the DB and take
effect **immediately** (the live table is updated in memory on save, so running
requests pick up the new value on their next quota check). `0` blocks a feature
for that plan. "Reset to defaults" clears the overrides and reverts to the code
defaults.

- **Storage:** the `quotas` key in `global_settings`, holding only the effective
  grid; it is merged over the code defaults (`DEFAULT_PLAN_DAILY_LIMITS`) at boot
  (`loadQuotas()`), so a newly-added feature automatically gets its code default
  until an admin overrides it.
- **Code:** [`server/rateLimit.ts`](../server/rateLimit.ts) (defaults + live table
  + `getPlanDailyLimit`), [`server/quotas.ts`](../server/quotas.ts) (load / save /
  reset), admin routes `GET`/`PUT /api/admin/quotas` + `POST /api/admin/quotas/reset`.
- **Caveat:** the live table and the usage counters are in-memory per API
  instance — with multiple instances each keeps its own, so move both to a shared
  store (e.g. Redis) if you scale out. See [deployment.md](deployment.md).

### Response Cache

Identical Justify requests (same user + subject + basePrediction + language)
are cached in an in-memory LRU store:

- **TTL:** 24 hours
- **Max entries:** 10 000

A cache hit returns the stored response immediately without calling the LLM
provider, saving cost and latency. The cache is not persisted; it clears on
server restart.

## Consultation Booking Limits

| Plan | Bookings / day |
| ---- | -------------- |
| Free | 2 |
| Pro | 5 |
| Premium | 10 |

## HTTP Status Codes

| Code | Meaning |
| ---- | ------- |
| `403` | Plan too low (e.g. free user calling Justify) or lifetime limit hit |
| `429` | Rate / quota limit reached — the `error` field explains which one |

Both responses include structured metadata (`dailyLimit`, `dailyUsed`,
`retryAfterMs`, etc.) so the frontend can display contextual messages.

## Configuration

All limits are defined in [`server/rateLimit.ts`](../server/rateLimit.ts).
To change quotas, edit `PLAN_DAILY_LIMITS` or `PLAN_LIFETIME_CHART_LIMIT`.

## Architecture Notes

- **In-memory Maps** with periodic cleanup (stale entries removed every
  5–30 minutes depending on the tracker).
- Counters reset on server restart — acceptable for daily quotas since a
  restart mid-day gives users a small bonus rather than penalising them.
- For multi-server / horizontally-scaled deployments, switch to Redis-backed
  counters using the same `checkRateLimit` / `checkDailyQuota` interface.
