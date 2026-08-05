# Accessing the Admin Console

The admin console is protected by a **two-step gate** by design: your account
password **plus** a separate access code. Even when signed in as the admin, you
cannot reach the console without the access code.

## Credentials

The super-admin is seeded at startup from three variables in your `.env`
(see [`.env.example`](../.env.example)):

| Variable            | Purpose                                        |
| ------------------- | ---------------------------------------------- |
| `ADMIN_EMAIL`       | The super-admin's sign-in email.                |
| `ADMIN_PASSWORD`    | Its password (also required at the admin gate). |
| `ADMIN_ACCESS_CODE` | The second factor for entering the console.     |

Set your own values before first run — the admin row is seeded once, from
whatever is in `.env` at that moment:

```bash
ADMIN_EMAIL=admin@yourdomain.com
ADMIN_PASSWORD=$(openssl rand -base64 18)
ADMIN_ACCESS_CODE=$(openssl rand -base64 12)
```

> **Never commit real values, and never reuse local ones in production.** This
> repository is public; treat anything in it as known to the world. On a hosted
> deploy set all three as platform secrets — `npm run deploy:check` fails the
> build if they are missing or only partly configured.

## Steps

1. Open the app at `http://localhost:5173`.
2. Click **Sign in** (top-right) and use the **email + password** form (not the
   dev-profile shortcut) with your `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
3. Once signed in, a **🛡️ Admin** button appears in the header. It only shows
   for admin-role accounts.
4. Click **🛡️ Admin**. You'll reach the **Admin sign-in** gate. Your email is
   pre-filled; enter the **password** again and your `ADMIN_ACCESS_CODE`, then
   **Enter admin console**.
5. You're in — the console's left rail lists every section: **Overview**,
   **Usage & Limits**, **Users**, **Approvals**, **Temples**, **Reminders**,
   **Promo Codes**, **Contact**, **Billing**, **Notifications**, **AI / LLM**,
   and **Features**.

## Leaving the console

- Use the **← Back to app** link (top-right of the console) to return to the app.
- Signing out drops the elevated session, so you'll re-enter the access code the
  next time you open the console.

## What you can do

| Section           | Purpose                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------- |
| **Overview**      | User, admin, offer, and pending-approval counts at a glance.                                   |
| **Usage & Limits** | Live usage dashboard — plan distribution, chart counts, signups, and the in-memory rate-limiter/cache state. |
| **Plan Limits**   | Edit the **per-plan daily quotas** (Astro Chat, Justify, Translate, Vastu, new charts, bookings) in a grid; saved to the DB, effective immediately. `0` blocks a feature; "Reset to defaults" reverts. See [Rate limiting § Editing](rate-limiting.md#editing-the-limits-admin). |
| **Users**         | List all users; create users (with plan + role); change plan/role; suspend/reactivate.         |
| **Approvals**     | Approve or reject consultation provider offers (new offers arrive as `pending`).               |
| **Contact**       | Read messages sent through the Contact-us form; mark them read / resolved.                      |
| **Billing**       | Read-only audit trail of refunds & disputes from Stripe (see [Refunds & disputes](promos-and-payments.md#refunds--disputes)). The app never issues refunds; disputes auto-revoke the user's plan. |
| **Notifications** | Broadcast to all users or target specific ones (info / success / warning).                      |
| **AI / LLM**      | Configure the global provider key **and pick the _Active engine_** (Off / Demo / a provider). All AI features — Justify, Translate, Vastu and **Astro Chat** — run on this config, and their UI is hidden while the engine is `Off`. See [Astro Chat § Enabling](astro-chat.md#enabling--operating). |
| **Features**      | Toggle whole features on/off (Consultations, Temples, Vastu, Reminders, **Astro Chat**). Disabling hides the UI and blocks the routes. |

## How admin access is secured

- The super-admin is **seeded from `.env` at startup** and can **never** be
  created through public registration (the admin email is reserved).
- Admin login (`/auth/admin/login`) requires the password **and** the access
  code. A leaked password alone cannot reach the admin area.
- Every `/api/admin/*` route requires an **elevated session** (the access code
  was supplied at login) **and** a live `role = admin` check.
- Self-protection: an admin cannot demote or suspend their own account.

## Notes

- The admin **password is only set on first seed**. Changing `ADMIN_PASSWORD` in
  `.env` afterwards won't update the existing admin row — update the password
  hash in the database, or reseed on a fresh database.
- The global LLM config starts empty, so AI features run in **demo mode** until
  an admin sets a real provider key under **AI / LLM**.
