# Reminders

Personal date reminders (e.g. annual rituals / death anniversaries) plus opt-in
festival reminders, delivered by email and in-app. Gated by the `reminders`
[feature flag](feature-flags.md).

## Where it lives

A top-level **⏰ Reminders** page from the header (logged-in users).
`src/components/RemindersView.tsx`.

## Personal reminders

Each reminder has a title, date, **recurrence** (`annual` for yearly rituals, or
`once`), a **lead time** ("remind me N days before" — on the day … 1 month),
notes, and an on/off switch.

- `GET /api/reminders` → `{ reminders, festivals }` (festivals include the user's
  subscription state).
- `POST /api/reminders/reminders`, `PUT/DELETE /api/reminders/reminders/:id`.

## Festivals (opt-in)

An **admin-curated** list of festivals/special dates that users choose to
subscribe to, each with its own lead time.

- Subscribe/unsubscribe: `POST /DELETE /api/reminders/festivals/:id/subscribe`.
- Admin manages the list under **Admin console → Reminders**
  (`GET/POST/PUT/DELETE /api/admin/festivals`).

## Delivery — pluggable email + in-app fallback

Every due reminder always creates an **in-app notification** (the bell). If an
email provider is configured it **also** sends real email; otherwise it's logged.

```
# .env — optional; without these, reminders are in-app only
RESEND_API_KEY=
REMINDER_FROM_EMAIL=
```

`server/mailer.ts` sends via the **Resend** HTTP API when both are set.

## The scheduler

`server/reminderScheduler.ts` runs ~10 s after boot and then **hourly**:

- `runReminderCheck()` — for each enabled reminder / festival subscription,
  computes the upcoming occurrence and fires when `today` is within
  `[occurrence − leadDays, occurrence]`. A per-occurrence guard (`last_notified`)
  makes runs **idempotent**, so it never double-sends.
- `runPlanExpiryCheck()` — reverts lapsed promo plans (see
  [promos-and-payments.md](promos-and-payments.md)).

Admins can trigger a run immediately: **Admin console → Reminders → "Run reminder
check now"** (`POST /api/admin/reminders/run`, returns `{ sent, downgraded }`).

## Tables

`reminders`, `festivals`, `festival_subscriptions`.
