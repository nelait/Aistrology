# Changing the domain

A reusable checklist for pointing Shastri at a custom domain — or moving it to
a different one later. Written against Railway, but only steps 2 is
platform-specific.

Replace `example.com` below with your domain.

---

## Nothing in the code changes

Verified, so you don't have to go looking:

| Concern | Status |
| ------- | ------ |
| Session cookie | Sets **no explicit `domain`** (`sameSite: "lax"`, `secure` in production), so it is host-only and follows whatever domain serves it. |
| CORS | Not applicable — the API and SPA are served from one origin. |
| Hardcoded hosts | None in `server/` or `src/`, apart from the localhost dev fallback in `server/config.ts`. |

Everything below is configuration, split between **the platform**, **your DNS**
and **three third parties** that store the URL on their side.

## The five things to change

| # | Where | What |
| - | ----- | ---- |
| 1 | Registrar | Own the domain |
| 2 | Railway + DNS | Add the custom domain, point DNS at it |
| 3 | Railway variables | `APP_URL` |
| 4 | Google / GitHub | OAuth redirect URIs |
| 5 | Stripe | Webhook endpoint **and its new signing secret** |

---

## 1. Register the domain

Nothing to say here beyond: do it first, since DNS propagation gates everything
after step 2.

## 2. Add the domain in Railway, then point DNS at it

App service → **Settings → Networking → Custom Domain** → enter `example.com`.
Railway returns a CNAME target such as `abc123.up.railway.app` and issues a TLS
certificate automatically once DNS resolves.

> ⚠️ **DNS forbids a CNAME on an apex (root) domain.** `www.example.com` is
> straightforward; `example.com` is not. Pick one of:

| Option | How | Trade-off |
| ------ | --- | --------- |
| **A — ALIAS/ANAME provider** (Cloudflare, DNSimple, Route 53…) | CNAME on `@` → Railway's target; the provider flattens it | Apex works directly. On Cloudflare set SSL mode to **Full (strict)**. |
| **B — `www` + redirect** | CNAME `www` → Railway's target, then a registrar-level redirect `example.com` → `www.example.com` | Simpler, works anywhere; canonical URL becomes `www.` |

Add **both** `example.com` and `www.example.com` in Railway so either resolves.

The existing `*.up.railway.app` domain keeps working throughout — there is no
downtime, and it stays as a fallback.

## 3. Set `APP_URL`

```
APP_URL = https://example.com
```

**Required — not optional.** When `APP_URL` is unset the app derives it from
`RAILWAY_PUBLIC_DOMAIN`, which remains the `*.up.railway.app` subdomain even
after a custom domain is added. Without this, OAuth returns, verification emails
and Stripe redirects all send users to the old host.

No trailing slash (one is trimmed automatically, but don't rely on it).

`APP_URL` is consumed by:
- the post-login bounce and OAuth callbacks (`server/auth.ts`)
- email-verification links (`server/auth.ts`)
- Stripe `success_url`, `cancel_url` and the billing portal `return_url`
  (`server/stripe.ts`)

## 4. Update the OAuth redirect URIs

These live with the provider and do **not** follow automatically. A stale value
produces `redirect_uri_mismatch` at sign-in.

- **Google** — Cloud Console → APIs & Services → Credentials → your OAuth 2.0
  client → *Authorised redirect URIs* → add
  `https://example.com/auth/google/callback`
- **GitHub** — Settings → Developer settings → OAuth Apps → your app →
  *Authorization callback URL* → `https://example.com/auth/github/callback`

Keep the old URLs registered until the new domain is confirmed working, then
remove them.

## 5. Move the Stripe webhook

Stripe dashboard → Developers → Webhooks → **Add endpoint**:

```
https://example.com/api/billing/webhook
```

Subscribe to the seven events the app handles:

```
checkout.session.completed
customer.subscription.updated
customer.subscription.deleted
invoice.payment_failed
charge.refunded
charge.dispute.created
charge.dispute.closed
```

🔑 **Stripe issues a different signing secret for every endpoint.** Copy the new
`whsec_…` into `STRIPE_WEBHOOK_SECRET`. Skip this and signature verification
fails **silently** — subscriptions, cancellations, refunds and disputes stop
being processed while checkout still appears to work.

Leave the old endpoint enabled until you've seen a successful delivery on the
new one, then delete it.

---

## Verify

1. Redeploy, then read the startup banner:
   ```
   App origin (APP_URL): https://example.com
   ```
2. `https://example.com/api/health` → `{"ok":true,"db":"up"}`
3. Load the app, hard-refresh, and **sign in** — this is the real test that the
   session cookie works on the new host.
4. If OAuth is configured, sign in with Google/GitHub (catches redirect-URI
   mistakes).
5. Stripe → Webhooks → **Send test webhook** → confirm a `200` on the new
   endpoint.
6. Check a certificate is live: the browser padlock, or
   `curl -sI https://example.com | head -1`.

## Rollback

Nothing is destructive. To back out, set `APP_URL` back to the
`*.up.railway.app` URL and redeploy — the Railway domain never stopped working.
Leave the DNS records in place while you investigate.

## Gotchas

| Symptom | Cause |
| ------- | ----- |
| Redirected to `*.up.railway.app` after login | `APP_URL` not updated (step 3) |
| `redirect_uri_mismatch` from Google/GitHub | OAuth redirect URI not added (step 4) |
| Subscriptions/refunds silently stop updating | `STRIPE_WEBHOOK_SECRET` still the old endpoint's (step 5) |
| Certificate warning / `ERR_SSL_*` | DNS hasn't propagated yet, or Cloudflare SSL isn't **Full (strict)** |
| Apex domain won't resolve, `www` works | Registrar has no ALIAS/ANAME support — use option B |
| Logged out after switching | Expected: the session cookie is host-only, so it doesn't carry across hostnames. Sign in again. |

## Related

- [railway-deployment.md](railway-deployment.md) — the full deployment runbook
- [deployment.md](deployment.md) — platform choice and scale-out plan
