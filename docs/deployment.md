# Deployment

Production hosting for Aistrology.

> **Railway is the supported path, and the app is deployed on it.**
> For step-by-step instructions and a troubleshooting guide covering every
> failure hit during the real deployment, see
> **[railway-deployment.md](railway-deployment.md)**.
>
> This page covers *why* Railway, the constraints that shaped the choice, the
> comparison with Render / Cloud Run, and the scale-out plan.

## The app in one paragraph

A static **Vite/React** SPA (`dist/`) + a long-running **Express** API
([`server/index.ts`](../server/index.ts)) + **PostgreSQL**. Auth is a stateless
JWT cookie (no server session store). The API also runs an **in-process hourly
scheduler** (`startReminderScheduler` → `setInterval`, see
[`server/reminderScheduler.ts`](../server/reminderScheduler.ts)) and an
**in-memory per-IP rate limiter**. Stripe webhooks need a **stable HTTPS
endpoint with the raw body** ([`server/index.ts`](../server/index.ts)).

## The three constraints that shape every option

1. **In-process scheduler.** The hourly reminder/promo-expiry job runs inside the
   API process. Consequences:
   - **Scale-to-zero / serverless breaks it** (the instance sleeps → the interval
     never fires). Cloud Run and Railway's optional "serverless" mode are affected.
   - **Horizontal autoscale double-fires it** (N replicas → N runs → duplicate
     emails / downgrade passes).
   - **Fix:** extract it to a platform **cron** that calls the already-exported
     `runReminderCheck()` + `runPlanExpiryCheck()`. Mandatory before autoscaling;
     mandatory on Cloud Run from day one.
2. **In-memory rate limiter.** Per-process counters; horizontal scaling dilutes
   the global limit and cold starts reset it. Move to Redis if you scale out
   (not correctness-critical).
3. **Same-origin cookie.** The SPA uses relative `fetch("/api/…")` and a same-site
   `aistro_session` cookie. Keep the SPA and API same-origin (serve `dist/` from
   Express, or use a host rewrite) to avoid CORS + cross-site cookie friction.

## Deploying to Railway

Full instructions live in **[railway-deployment.md](railway-deployment.md)** —
service layout, every variable, the verification checklist, and a troubleshooting
section covering each failure encountered in practice.

The short version: one always-on service serving the API *and* the built SPA
(single origin, so the session cookie and relative `fetch` paths just work), plus
a Postgres service in the **same** project.

### What is already wired up

| Piece | Where |
| ----- | ----- |
| Build + start + healthcheck | [`railway.json`](../railway.json) |
| Production start | `npm start` -> `tsx server/index.ts` (`tsx` is a runtime dependency, so it survives dev-dependency pruning) |
| Static SPA serving | `server/index.ts` serves `dist/` with an SPA fallback in production (`SERVE_STATIC` overrides) |
| Postgres TLS | `server/db.ts` — automatic for remote hosts, skipped for `localhost` / `*.railway.internal` |
| Environment detection | `RAILWAY_ENVIRONMENT` etc. imply production, so a missing `NODE_ENV` can't leave dev login enabled |
| Preflight | `npm run deploy:check` exits non-zero on unsafe or missing config |

### Operational notes

- **One replica by default.** The reminder/promo sweep runs *in-process* on an
  hourly timer, and the rate limiter and quota table are in-memory. Two replicas
  would double-sweep and split the counters — see the cron setup below to lift
  that limit.
- **Leave "serverless / app sleeping" off** while the in-process scheduler is
  active: a sleeping process never fires the timer.
- **Database:** Railway Postgres is a container + volume with backups, not
  managed HA. Fine for launch; swap in Neon/Supabase/RDS later by changing
  `DATABASE_URL` (TLS is handled automatically).

### Scheduler as a cron service (needed before scaling out)

The sweep is also available as a **one-shot process that exits**, which is what a
platform cron needs:

```bash
npm run scheduler:run          # scripts/run-scheduled.ts
```

It runs `runReminderCheck()` + `runPlanExpiryCheck()`, logs what it dispatched,
closes the pool and exits — **non-zero if either check failed**, so a bad run
shows up as a failed cron run. It is **idempotent**: reminders are guarded by
`last_notified` and promo downgrades by the plan/expiry columns, so a retried or
duplicated run sends nothing twice.

To hand the job over on Railway:

1. **Add a second service** from the same repo (Railway → *New* → *GitHub Repo*,
   same project so it shares the Postgres service).
2. Set its **Custom Start Command** to `npm run scheduler:run` and its
   **Cron Schedule** to `0 * * * *` (hourly).
3. Give it the same `DATABASE_URL` (and `RESEND_API_KEY` / `REMINDER_FROM_EMAIL`
   if you send reminder email).
4. On the **web** service set `RUN_SCHEDULER=false` so the sweep does not also
   run in-process. The boot log then shows `scheduler✗(cron)`.

With that in place the web service is stateless enough to scale replicas — the
remaining shared-state item is the in-memory rate limiter / quota table, which
should move to Redis before you raise the replica count.

> Railway cron requires the process to **exit**; a long-running command would
> block the next scheduled run. `scripts/run-scheduled.ts` exits explicitly.

### Rough cost

Hobby $5/mo (includes $5 usage) covers a small single-instance deployment plus
Postgres — realistically **~$5–15/mo** to start. Pro ($20/seat) is only needed
for replicas and higher limits.

---

## Alternatives considered

### Railway — simplest & cheapest to start (recommended first step)

One always-on container serving **both** the API and the static SPA, plus a
Postgres plugin. Because the service is always-on, the **in-process scheduler and
rate limiter work unchanged at a single instance** — the only required change is
adding `express.static(dist)` + an SPA fallback so it's one same-origin service.

- **Autoscale fork:** stay single-instance (no changes) → simple; or go multi-
  replica (Pro plan) → extract the scheduler to a **Railway Cron** service and
  move the limiter to a **Redis** plugin.
- **Cost (usage-based, ~$20/vCPU-mo, ~$10/GB-mo; verify current):** Hobby
  **~$5–15/mo**, Pro **~$20–35/mo**. No fixed managed-DB fee.
- **Caveat:** Railway Postgres is a container + volume with backups, not managed
  HA. Leave "serverless/app-sleeping" **off** if relying on the in-process cron.

### Render — managed PaaS, tidy separation

Static Site (free CDN) + Web Service (API, autoscale) + Managed Postgres + a
**Cron Job** for the scheduler. More managed than Railway; a bit more setup.

- **Cost:** web ~$7 (autoscale tier ~$25/instance), Postgres ~$7–20, static free →
  **~$15–30/mo** to start.

### Google Cloud Run — best for spiky/high traffic

Containers with scale-to-zero + per-request billing. **Forces the scheduler
extraction immediately** (scale-to-zero). Topology: **Firebase Hosting** (static
SPA + free CDN, with **rewrites to Cloud Run** to keep same-origin) → **Cloud
Run** (API) → **Cloud SQL** (Postgres) → **Cloud Scheduler** (hourly) →
**Secret Manager** (keys) → **Artifact Registry** + **Cloud Build**.

- **Cost:** Cloud Run near-free at low traffic (scale-to-zero); **Cloud SQL is the
  floor** (~$10–35/mo). Totals **~$15–40/mo**; min-instances=1 (no cold starts)
  adds ~$10–25.
- **Avoid** an external HTTPS Load Balancer for the frontend (~$18/mo fixed) — use
  Firebase Hosting's rewrite instead.
- **Cost lever:** swapping Cloud SQL for serverless Postgres (Neon/Supabase) can
  drop the DB floor toward ~$0–19 at low traffic.

## Recommendation

**Start on Railway single-instance** (least maintenance, lowest starting cost,
existing scheduler/limiter work as-is), and keep autoscale as a documented upgrade
path: extract the scheduler → cron, add Redis, then scale replicas. Move to Cloud
Run only once traffic is high and bursty enough to exploit scale-to-zero.

**The one change needed no matter what:** either `express.static(dist)` for a
single same-origin service (Railway/Render single service), or a host rewrite
(Firebase → Cloud Run) — plus the **scheduler extraction** the moment you enable
scale-to-zero or multiple replicas.

## Still open

- **Shared rate limiter / quota store** (Redis). The last piece of per-process
  state; move it before raising the replica count.
- **Render / Cloud Run configs** (`render.yaml`, `Dockerfile`, `cloudbuild.yaml`)
  — only if you move off Railway.
