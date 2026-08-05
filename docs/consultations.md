# Consultations

## Provider types

Every offer declares what it is — **Astrologer**, **Priest**, or **Astrologer &
Priest** (`provider_type` on `consultation_offers`, default `astrologer`). The
provider picks it in their profile form; the directory shows it as a badge and
offers an **All / Astrologers / Priests** filter with live counts.

A provider set to **both** appears under either filter, so nobody is hidden by
being versatile. Unknown values sent to the API fall back to `astrologer`, and
existing offers were migrated to `astrologer` automatically.

A lightweight marketplace connecting seekers with astrologers, built on the
existing accounts. Gated by the `consultation` [feature flag](feature-flags.md).

## Roles

| Who | Can do |
| --- | ------ |
| **Premium** users | Publish a provider **offer** and manage incoming booking requests. |
| **Free / Pro** users | Browse **approved** providers and request bookings. |
| **Admin** | Approve or reject provider offers. |

## Where it lives

A top-level **Consultation** page reached from the header link (no birth chart
required). `src/components/ConsultationView.tsx`.

## Provider offers (Premium)

A provider profile has a display name, headline, bio, specialties, languages,
per-session rate, and contact email. New/edited offers enter as **`pending`**
and only appear in the directory once an admin approves them.

- `PUT /api/consultation/offer` — create/update own offer (Premium only, else 403).
- Admin: **Admin console → Approvals** → approve/reject. On decision the provider
  gets an in-app notification.

## Bookings (any signed-in user)

- `POST /api/consultation/booking { offerId, topic, preferredTime, message, contactEmail }`
  — request a session against an **approved** offer (you can't book your own).
  Subject to the per-plan daily **booking** quota (see [rate-limiting.md](rate-limiting.md)).
- Providers see incoming requests and set status
  (`POST /api/consultation/request/:id/status`) to `confirmed` / `declined` /
  `completed`. The seeker's contact email is revealed to the provider only after
  they confirm.

## Data & endpoints

- Bundle for the page: `GET /api/consultation` → `{ plan, canOffer, providers,
  offer, bookings, requests }`.
- Tables: `consultation_offers`, `consultation_bookings`.
- Server: `server/consultation.ts`; admin bits in `server/admin.ts`.

## Lifecycle

```
Premium user submits offer ──▶ pending ──▶ admin approves ──▶ listed in directory
                                                              │
Free/Pro user books ◀─────────────────────────────────────────┘
        │
        └▶ provider confirms/declines ──▶ seeker notified
```
