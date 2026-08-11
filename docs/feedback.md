# Feature Feedback

A "Was this helpful?" strip at the foot of every feature tab, so users can rate
a module and say what's wrong with it, and admins can see which parts of the
product need work.

The point is per-feature attribution. The [Contact us](admin-console.md) form
already collects free-text messages, but a message rarely says *which* screen
prompted it. Feedback is always tagged with the module the user was looking at,
which makes it rankable.

## What the user sees

At the bottom of the active tab:

```
Was Muhurta helpful?    [👍 Yes]  [👎 No]
```

Picking a thumb opens an optional comment box — "What worked well?" for 👍,
"What was missing or wrong?" for 👎 — with **Send feedback** and **Cancel**.
Nothing is submitted until Send is pressed, so a stray tap costs nothing.
After sending, the strip collapses to a thank-you line.

Details that matter:

- **Signed-in only.** The endpoint requires auth, so the widget is hidden for
  guests rather than letting them write a comment and then hit a 401.
- **Resets on tab switch.** The widget keys off the active tab; switching
  modules clears any draft, so feedback always describes what is on screen.
- **A comment is optional.** A bare 👍/👎 is a valid submission — the ratio is
  useful on its own.
- **Failures are surfaced**, not swallowed: if the POST fails (e.g. the daily
  quota is hit) the error is shown and the user is *not* falsely thanked.

## Where it lives

One `<FeatureFeedback feature={tab} label={…} />` is rendered in
[`src/App.tsx`](../src/App.tsx) just before `</main>`, using the active tab id
as the feature key. That single mount covers every module — Kundli,
Predictions, Dasha, Events, Transit, Forecast, Doshas, Muhurta, Remedies, the
three Match modules, Career, Health, Mental Health, Vastu, Pooja Services,
Notes, Plans & Billing and Learn — with no per-view edits, and any tab added
later is covered automatically.

## Admin → Feedback

A new section in the admin console, next to Contact.

**Summary bars**, one per feature, sorted worst-first — the feature with the
lowest positive share is at the top, because that is where the product work is.
Each row shows the positive percentage as a bar plus the raw counts
(`👍 3 · 👎 1 · 4 ratings · 2 comments`). Clicking a feature name filters the
list below to it.

**Entry list**, newest first, showing the thumb, the feature, the submitter's
email, the comment (or "rating only — no comment"), the timestamp and the
status. Filters for feature, rating and status sit above it.

**Status** is a light triage workflow: `new` → `read` → `actioned`. Nothing is
deleted; the table is the record of what users told you and what you did about
it.

## API

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| `POST` | `/api/feedback` | user | Submit `{ feature, rating, comment? }` |
| `GET` | `/api/admin/feedback` | admin | `{ entries, summary }` |
| `POST` | `/api/admin/feedback/:id/status` | admin | Set `new` / `read` / `actioned` |

`rating` must be `"up"` or `"down"`; `feature` must be non-empty. Anything else
is a `400`. Comments are trimmed to 2000 characters and the feature key to 60,
so a crafted request can't bloat the table.

## Quota

Submissions count against a daily per-plan quota under the `feedback` key, so a
bored user or a script can't flood the admin view:

| Plan | Feedback/day |
| ---- | ------------ |
| free | 20 |
| pro | 40 |
| premium | 60 |

Like every other quota these are the code defaults and are editable in
**Admin → Plan Limits** (see [Rate Limiting](rate-limiting.md)). Exceeding the
limit returns `429` and the widget shows the message rather than pretending the
feedback was recorded.

## Storage

```sql
CREATE TABLE feedback (
  id         UUID PRIMARY KEY,
  user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  feature    TEXT NOT NULL,
  rating     TEXT NOT NULL,               -- up | down
  comment    TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'new', -- new | read | actioned
  created_at BIGINT NOT NULL
);
```

`ON DELETE SET NULL` keeps the feedback when an account is deleted — the
product signal outlives the account, and the row becomes anonymous rather than
disappearing. Indexes on `created_at DESC` and `feature` back the two queries
the admin view makes.

The table is created by `initDb()` like every other table, so it appears on the
next boot with no migration step.

## Files

| File | Role |
| ---- | ---- |
| [`server/feedback.ts`](../server/feedback.ts) | `POST /api/feedback` — auth, validation, quota |
| [`server/db.ts`](../server/db.ts) | Table + `createFeedback` / `listFeedback` / `feedbackSummary` / `setFeedbackStatus` |
| [`server/admin.ts`](../server/admin.ts) | Admin read + status endpoints |
| [`src/components/FeatureFeedback.tsx`](../src/components/FeatureFeedback.tsx) | The widget |
| [`src/components/AdminView.tsx`](../src/components/AdminView.tsx) | `FeedbackSection` |
| [`src/App.tsx`](../src/App.tsx) | Single mount point covering every tab |

Tests: `src/components/FeatureFeedback.test.tsx` (8) and
`src/components/FeedbackSection.test.tsx` (9).
