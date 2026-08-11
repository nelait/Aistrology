# Aistrology Documentation

Guides for the features and operations of the Aistrology app.

## Contents

- [Changelog](CHANGELOG.md) — everything built/changed, grouped by area.
- [Promos & Payments](promos-and-payments.md) — how Stripe subscriptions and
  promo codes grant plans, how the two stay compatible, and how refunds &
  disputes (chargebacks) are handled.
- [Admin Console](admin-console.md) — accessing the admin area, what each
  section does, and how admin access is secured.
- [Feature Flags](feature-flags.md) — turning whole features on/off across the app.
- [Astro Chat](astro-chat.md) — the logged-in AI chat grounded in the user's
  chart and current module: streaming, persisted history, per-module "Ask AI"
  hooks, and how its answers are validated per profile.
- [Notes](notes.md) — private per-profile notes for Pro/Premium users.
- [Lessons](lessons.md) — the built-in astrology course: Beginner/Advanced/Pro
  tracks in a slide-out drawer, with progress and live chart links.
- [Feature Feedback](feedback.md) — the per-module "Was this helpful?" widget
  and the admin view that ranks features by how users rate them.
- [Rectification & event analysis](rectification-and-event-analysis.md) —
  research and plan for deriving an unknown birth time from dated life events,
  and for explaining events from the chart. Not implemented.
- [Consultations](consultations.md) — provider offers, bookings, and approvals.
- [Reminders](reminders.md) — personal & festival reminders and the scheduler.
- [Rate Limiting](rate-limiting.md) — per-plan daily quotas and the global limiter.
- [Vastu](vastu.md) — the Vastu analysis feature.
- [Doshas](doshas.md) — chart-affliction detection rules and remedies.
- [Railway deployment](railway-deployment.md) — **step-by-step runbook** for the
  live deployment, plus troubleshooting for every failure hit in practice.
- [Changing the domain](custom-domain.md) — checklist for moving to a custom
  domain (DNS, `APP_URL`, OAuth redirect URIs, Stripe webhook secret).
- [Mobile responsiveness](mobile-responsive.md) — measured audit of the app at
  phone/tablet widths, and the phased plan to fix what it found.
- [Deployment](deployment.md) — why Railway, the constraints behind the choice,
  the Render / Cloud Run comparison, and the scale-out plan.

## Quick start (local)

```bash
npm install
npm run dev:all      # web (Vite, :5173) + API (Express, :8787)
```

Requires PostgreSQL running with a database named `aistrology`
(`createdb aistrology`). Configuration lives in `.env` — copy `.env.example`
and fill it in. Local sign-in works out of the box via the dev-profile shortcut
(`ALLOW_DEV_LOGIN=true`); OAuth and Stripe are optional.

## Roles & plans at a glance

| Concept | Values | Set by |
| ------- | ------ | ------ |
| Plan    | `free`, `pro`, `premium` | Stripe checkout, or an admin |
| Role    | `user`, `admin`          | Seeded super-admin, or an admin |

Premium is the "professional" tier — the only one that can offer consultation
services.
