# Deploying to Railway — full runbook

Step-by-step instructions for putting Shastri on Railway, written **after
doing it**. Every pitfall in [Troubleshooting](#troubleshooting) is one that
actually occurred, with the log line it produces and the fix.

For the comparison against Render / Cloud Run and the scale-out plan, see
[deployment.md](deployment.md).

---

## What you are building

**Two services in one Railway project:**

```
Railway project
├── Shastri   ← your app (API + built SPA, one origin)
└── Postgres     ← database (container + volume)
```

The app serves the API *and* the built frontend from the same process, so the
same-site session cookie and the client's relative `fetch("/api/…")` calls work
with no CORS configuration.

> **Both services must be in the SAME project.** A `${{Postgres.DATABASE_URL}}`
> reference cannot cross project boundaries. Creating Postgres as its own
> project is the single most common mistake.

## Prerequisites

- The repo on GitHub (Railway deploys from it and redeploys on every push).
- A Railway account. Hobby is $5/mo including $5 of usage; this app plus Postgres
  realistically runs **$5–15/mo**.
- Nothing else — no Docker, no CLI required if you use the dashboard.

---

## Step 1 — Create the app service

Railway dashboard → **New Project** → **Deploy from GitHub repo** → pick the
repository. Authorise Railway to read it if prompted.

It auto-detects [`railway.json`](../railway.json) and uses:

| Setting | Value |
| ------- | ----- |
| Build | `npm install --include=dev --no-audit --no-fund && npm run build` |
| Start | `npm start` (→ `tsx server/index.ts`) |
| Healthcheck | `/api/health`, 120 s timeout |
| Replicas | 1 |

> If **Settings → Build → Build Command** has anything in it, it **overrides**
> `railway.json`. Leave it blank, or paste the build command above.

The first build will likely succeed but the app will crash on startup — expected,
there is no database yet.

## Step 2 — Add Postgres *in the same project*

On the project canvas: **`+ New` → `Database` → `Add PostgreSQL`**.

Wait for it to show **Online** with a `postgres-volume` attached.

## Step 3 — Point the app at the database

This is the step that trips people up. Adding the variable is not enough — its
**value** must be right.

App service → **Variables** → add or edit `DATABASE_URL`:

**Option A — reference (preferred).** Type `${{` and pick from the dropdown:
```
${{Postgres.DATABASE_URL}}
```
It must render as a linked chip. Pasted as plain text it stays literal and fails.
The dropdown only lists `Postgres.*` once the database service exists.

**Option B — paste the literal (foolproof).** Postgres service → **Variables** →
reveal and copy `DATABASE_URL`, then paste it into the app service's
`DATABASE_URL`. Works identically; you just have to re-copy it if you ever rotate
the password.

Prefer the **private** host (`postgres.railway.internal`) if both are offered —
it stays on Railway's internal network, costs no egress and needs no TLS.
[`server/db.ts`](../server/db.ts) enables TLS automatically for public hosts and
skips it for private/local ones, so either works.

## Step 4 — Set the remaining variables

⚠️ **Railway pre-fills "Suggested Variables" by scanning `.env.example`.** Those
are *development placeholders*, and several are dangerous in production. Review
every one.

**Required:**

| Variable | Value |
| -------- | ----- |
| `DATABASE_URL` | from step 3 |
| `SESSION_SECRET` | 32+ random bytes — **not** the `change-me-…` placeholder |
| `LLM_ENC_SECRET` | 32+ random bytes (encrypts stored LLM keys at rest) |
| `ADMIN_EMAIL` | your admin sign-in address |
| `ADMIN_PASSWORD` | strong generated password |
| `ADMIN_ACCESS_CODE` | the console's second factor |

Generate the secrets locally so they never pass through a browser field or chat:

```bash
printf 'SESSION_SECRET=%s\nLLM_ENC_SECRET=%s\nADMIN_PASSWORD=%s\nADMIN_ACCESS_CODE=%s\n' \
  "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" \
  "$(openssl rand -base64 18)" "$(openssl rand -base64 12)"
```

**Must NOT be set:**

| Variable | Why |
| -------- | --- |
| `ALLOW_DEV_LOGIN` | 🔴 Enables passwordless sign-in **as any user**, including admin. Railway's autofill sets it to `true` — **delete it**. |
| `PORT` | Railway injects it; the server already reads `process.env.PORT`. |

**Optional:**

| Variable | Effect |
| -------- | ------ |
| `NODE_ENV=production` | Conventional; no longer load-bearing (see below). |
| `APP_URL` | Leave unset to auto-derive from the Railway domain. Set it once you have a custom domain. |
| `RUN_SCHEDULER=false` | Only when a cron service owns the reminder sweep. |
| `STRIPE_*`, `GOOGLE_*`, `GITHUB_*`, `RESEND_API_KEY` | Enable billing / OAuth / reminder email. |

> **`NODE_ENV` is a safety net, not a requirement.** The app detects Railway via
> `RAILWAY_ENVIRONMENT`, so forgetting it can't silently leave dev login on or
> stop the SPA being served. Set it anyway for convention.

## Step 5 — Expose the app

App service → **Settings → Networking → Public Networking → Generate Domain**.

If asked for a port, enter the one from the startup log (**8080** — the value
Railway injects as `PORT`). A wrong port here produces *"Application failed to
respond"* even though the app is healthy.

You get `<service>-production-xxxx.up.railway.app`. `APP_URL` resolves from it
automatically on the next boot.

## Step 6 — Verify

Redeploy and read the startup banner:

```
Shastri API on http://localhost:8080  [google✗ github✗ password✓ dev-login✗ admin✓ scheduler✓]
Postgres: postgresql://postgres:****@postgres.railway.internal:5432/railway
App origin (APP_URL): https://<your-domain>.up.railway.app
```

Read it as a checklist:

| Signal | Meaning |
| ------ | ------- |
| Banner printed at all | Database connected; all **22 tables** created (`initDb()` is idempotent — no migration step) |
| `dev-login✗` | Passwordless login disabled ✅ (`dev-login✓` in production is a security incident) |
| `admin✓` | Super-admin seeded from `ADMIN_*` |
| `scheduler✓` | Hourly reminder + promo-expiry sweep running |
| `Postgres: …@postgres.railway.internal` | Using the private network |
| `App origin` shows the real domain | OAuth / Stripe / email links will work |

Then check `https://<domain>/api/health` → `{"ok":true,"db":"up"}`.

## Step 7 — Post-deploy

1. **Sign in as admin.** Email + password form (not a social button) with
   `ADMIN_EMAIL` / `ADMIN_PASSWORD`, then the **🛡️ Admin** button and the second
   gate wanting the password again plus `ADMIN_ACCESS_CODE`.
2. **Turn on an AI engine** — Admin → **AI / LLM** → *Active engine*. Until then
   Astro Chat, Justify and the "✦ Ask AI" buttons stay hidden. See
   [astro-chat.md](astro-chat.md#enabling--operating).
3. **Stripe** — register the webhook at `https://<domain>/api/billing/webhook`
   subscribing to `checkout.session.completed`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`,
   `charge.dispute.closed`. Test keys need test price ids; live needs live.
4. **OAuth** — add `https://<domain>/auth/google/callback` (and the GitHub
   equivalent) as authorised redirect URIs.
5. **Custom domain** — see **[custom-domain.md](custom-domain.md)** for the full
   checklist (DNS and the apex-CNAME catch, `APP_URL`, OAuth redirect URIs, and
   the Stripe webhook's *new* signing secret).

---

## Troubleshooting

Every entry below was hit during the real deployment.

### Build: `sh: tsc: command not found`

Railway sets `NPM_CONFIG_PRODUCTION=true` (visible as `npm warn config
production` in the logs), so a plain `npm install` skips `devDependencies` —
where `typescript` and `vite` live.

**Fix:** the build command carries `--include=dev` (already in `railway.json`).
If you overrode the build command in Settings, restore it.

### Build: `EBUSY: resource busy or locked, rmdir '/app/node_modules/.cache'`

Railway mounts a build cache *inside* `node_modules`. `npm ci` deletes
`node_modules` wholesale and cannot remove that mount.

**Fix:** use `npm install`, not `npm ci`, in the build command.

### Start: `FATAL: the database is not configured for production`

The guard in [`server/index.ts`](../server/index.ts) fired before any confusing
stack trace. It prints what it received:

| Log line | Meaning | Fix |
| -------- | ------- | --- |
| `host="localhost" (starts "postgres://l…")` | `DATABASE_URL` still holds the `.env.example` autofill | Edit its **value** (step 3) — adding the variable isn't enough |
| `host="<unparseable>" (starts "${{Postgres.…")` | A reference was pasted as plain text | Re-enter it with the `${{` dropdown, or paste the literal string |
| `<not set — using the built-in localhost default>` | Variable missing | Add it |

### Start: `ECONNREFUSED 127.0.0.1:5432`

Older builds without the guard. Same root cause: `DATABASE_URL` unset or pointing
at localhost.

### Start: `getaddrinfo ENOTFOUND postgres.railway.internal`

The value is correct but the Postgres service is **in a different project**, so
the private hostname doesn't resolve. Move it into the same project.

### Browser: "Application failed to respond"

Railway's proxy reached the container but nothing was listening on the port it
tried. The app binds to all interfaces, so this is a settings mismatch.

**Fix:** Settings → Networking — make the domain's port match the one in the
startup banner (8080).

### Admin password doesn't work

`ensureAdminUser()` seeds the admin **once**. Changing `ADMIN_PASSWORD` after the
first successful boot has no effect — the stored hash is from that first boot.
(`ADMIN_ACCESS_CODE` *is* read live, so changing it works.)

**Fix:** update the `password_hash` in the database, or delete the admin row and
redeploy to reseed.

### Deploy logs leaked the database password

The startup banner used to print the full connection string. It now masks the
password. If you ran an older build, **rotate the Postgres password** — deploy
logs get pasted into chats and screenshots.

---

## Operational notes

- **Keep `numReplicas: 1`.** The reminder sweep runs in-process on an hourly
  timer, and the rate limiter and quota table are in memory. A second replica
  double-sends reminder emails and splits the counters.
- **Leave "app sleeping" off** while the in-process scheduler is active — a
  sleeping process never fires the timer.
- **To scale out:** move the sweep to a cron service (`npm run scheduler:run`,
  see [deployment.md](deployment.md#scheduler-as-a-cron-service-needed-before-scaling-out))
  and move the rate limiter to Redis, then raise the replica count.
- **Backups:** Railway Postgres is a container + volume, not managed HA. Fine for
  launch; swap `DATABASE_URL` to Neon/Supabase/RDS later — TLS is automatic.
- **Preflight:** `railway run npm run deploy:check` validates the whole config
  and exits non-zero on anything blocking.
