# Changelog

A running record of the features and fixes delivered in this line of work.
Grouped by area, roughly in the order they were built. File paths are relative
to the repo root.

---

## Home page & UX

- **Long-form article** — added "Decoding the Patterns: Rethinking Our
  Relationship with Astrology" to the landing page, themed to the app, with the
  ASCII source diagram reworked into a styled flow diagram, a destiny/free-will
  card pair, a pull-quote, and a disclaimer. (`src/App.tsx`, `src/styles.css`)
- **Hero polish** — eyebrow pill, stronger headline hierarchy, icon-chip feature
  bullets, consistent section rhythm/dividers, and a "Simple pricing" eyebrow on
  Plans.
- **Functional "Sign in" CTA** — the hero's sign-in button now opens the sign-in
  menu (the `AccountBar` menu state was lifted so it can be controlled). Replaced
  the passive "use the button top-right" text.
- **Hero visual** — a faint, slowly-rotating zodiac **mandala** (inline SVG)
  behind the sign-in / birth-form panel; respects `prefers-reduced-motion`.
- **Birth form hints** — a note telling users to Google their birth city's
  latitude/longitude and enter it manually if it isn't listed, and a clear
  explanation of the **DST** checkbox (with "India never uses DST" guidance).
  (`src/components/BirthForm.tsx`)

## Bug fixes

- **Sign out returns home** — signing out now clears the loaded chart and returns
  to the landing page instead of staying on the tabbed reading view.
- **Build-breaking `setShowAuth`** — a temple CTA referenced an undefined setter;
  pointed it at the real `setSignInOpen` (unblocked `npm run build`).
- **Temple auth used `req.session`** — the temples router assumed
  express-session, but the app uses JWT cookies; rewritten to the JWT pattern.
- **`crypto` not defined** — temple DB helpers used bare `crypto.randomUUID()`;
  switched to the imported `randomUUID`.

## Consultations

- DB-backed marketplace: **Premium** users publish a provider profile (offer),
  **Free/Pro** users browse approved providers and request bookings, providers
  manage incoming requests. Admin approves offers.
- Reachable as a top-level **Consultation** page (header link) — no chart needed.
- Files: `server/consultation.ts`, `src/components/ConsultationView.tsx`.

## Temples & Pooja Services

- **Separated the two concerns:**
  - **Temple Affiliation** — a home-page-linked **Temple Portal** where temple
    officials register and manage their temple, pooja services, and event
    calendar.
  - **Pooja Services** — a browse-only tab where logged-in users discover temples
    and their services/events.
- **Temples are their own accounts** — separate credentials (email + password)
  and a dedicated session (`aistro_temple` cookie), fully decoupled from
  astrology users. Public register/login, temple-scoped management, admin
  approval. (`server/temples.ts`, `src/components/TempleAffiliationView.tsx`,
  `src/components/PoojaServicesView.tsx`)
- **Home-page positioning fix** — the Temple Affiliation section was rendering at
  half width (missing `grid-column: 1 / -1`); now a full-width band with an even
  3-card feature row.

## Admin module

- **Secured admin console** — a super-admin is **seeded from `.env`**
  (`ADMIN_EMAIL` / `ADMIN_PASSWORD`) and can never be created via public
  registration. Admin access requires an **elevated session** obtained through a
  separate login that also needs `ADMIN_ACCESS_CODE`. Every `/api/admin/*` route
  is behind `requireAdmin`. See [admin-console.md](admin-console.md).
- **Sections:** Overview, Usage & Limits, Users (create/edit plan+role,
  suspend), Approvals (consultation offers), Temples (approve), Reminders,
  Promo Codes, Notifications, AI/LLM, Features.
- Files: `server/admin.ts`, `server/auth.ts`, `src/components/AdminView.tsx`.

## Notifications

- In-app **notification bell** (unread count, dropdown, mark read/all).
- Admin can broadcast to all users or target specific users.
- Files: `server/notifications.ts`, `src/components/NotificationBell.tsx`.

## Global (admin-managed) LLM config

- LLM provider keys moved from **per-user** to a single **global** config set by
  admins; all users' AI features (Justify/Translate) run on it. The per-user
  AI-settings UI was removed. (`server/llm.ts`, `AI / LLM` admin section)

## Feature flags

- Admin can enable/disable major features: **Consultations**, **Temples & Pooja
  Services**, **Vastu**, **Reminders**. Disabled features are hidden in the UI
  **and** blocked at the API (403) via `requireFeature`. Flags ride along in
  `/auth/me`. Files: `server/features.ts`, `Features` admin section.

## Reminders

- **Personal reminders** — users add important dates (e.g. annual rituals /
  death anniversaries), choose annual or one-time, a "remind me N days before"
  lead, notes, on/off.
- **Festivals** — an admin-curated list users **opt into**.
- **Delivery** — a pluggable mailer sends real email via **Resend** when
  `RESEND_API_KEY` + `REMINDER_FROM_EMAIL` are set; otherwise reminders arrive as
  in-app notifications (and are logged). An in-process **scheduler** dispatches
  due items (hourly, idempotent via a per-occurrence guard).
- Admin manages festivals and can "Run reminder check now".
- Files: `server/reminders.ts`, `server/reminderScheduler.ts`, `server/mailer.ts`,
  `src/components/RemindersView.tsx`.

## Promo codes & payments

- **Promo codes** — admin-issued codes granting Pro/Premium for a fixed
  **duration** (1 week / 2 weeks / 1 month / 1 year), with an optional
  **max-redemptions** cap and code validity window; **once per user**; auto-
  **downgrade to Basic (Free)** when the grant lapses.
- **Stripe ⇄ promo compatibility** — fixed two real bugs so a paying subscriber
  is never wrongly downgraded and a subscription can't be shadowed by a promo.
- **Refunds & disputes (webhook-driven, never money-moving)** — the app now
  reacts to three more Stripe events. It never issues refunds itself:
  - `charge.refunded` → **notify only** (user + admins); access unchanged, since
    a refund doesn't cancel a subscription.
  - `charge.dispute.created` → **revoke the paid plan immediately**
    (`plan_source = 'disputed'`, which the reconcile-on-load skips so an active
    subscription can't silently restore it); alert user + admins.
  - `charge.dispute.closed` → restore the live plan if **won**, else stay revoked.
  - **Admin visibility** — admin notifications **plus** a persistent read-only
    **Billing** audit trail (`billing_events` table, **Admin → Billing**).
- Full details: **[promos-and-payments.md](promos-and-payments.md)** (see
  *Refunds & disputes*).
- Files: `server/promo.ts`, `server/stripe.ts`, `server/admin.ts`, DB helpers in
  `server/db.ts`, `src/components/AdminView.tsx`, `src/api/client.ts`.

## Astro Chat (Phases 1–3)

- **Streaming AI chat for logged-in users**, grounded in the loaded chart and the
  current module — a floating panel available across the reading view. Reuses the
  existing provider streaming layer (OpenAI / Anthropic / Gemini + `demo`).
- **Context injection** — the client summarizes the computed chart (ascendant +
  planet placements) and the active section, and threads it into the system
  prompt so answers are specific to the user's chart.
- **Access** — not paid-only: a small free daily allowance (`chat` quota:
  free 5 / pro 50 / premium 200) as an upgrade hook; a `chat` feature flag lets
  admins toggle it.
- **Persistence (Phase 2)** — conversations and messages are saved
  (`chat_conversations` / `chat_messages`), so history survives reloads. The
  panel has a history list, New chat, resume, and delete; every conversation is
  scoped to its owner (SQL-enforced, cross-user access returns 404). The stream
  endpoint auto-creates + auto-titles a conversation and writes each turn.
- Endpoints: `POST /api/llm/chat/stream` (SSE, same framing as `justify/stream`)
  and the `GET`/`DELETE /api/chat/conversations[/:id]` CRUD router.
- **Module hooks (Phase 3)** — a shared `AstroChatProvider` + `AskAiButton`; the
  Doshas, Muhurta and Vastu views now show a "✦ Ask AI" button that opens the
  panel and starts a fresh conversation seeded with that specific finding (the
  chart summary is still injected automatically).
- **Grounded free-typed questions** — the chat context now carries
  `findings[]`: detected doshas are always injected (so "do I have any doshas?"
  names the real ones), and Muhurta/Vastu publish their computed results while
  visible via `usePublishChatContext`. The system prompt tells the model to
  prefer these over generic reasoning.
- **Profile scoping fix** — switching profiles now resets the chat thread (was
  leaving the previous profile's conversation on screen); history is unaffected.
- **Validation** — context builders extracted to a pure module
  (`src/chat/context.ts`) with deterministic unit tests incl. **cross-profile
  isolation**, plus a **contradiction scanner** (`src/chat/contradictions.ts`)
  that flags replies asserting placements that disagree with the chart — both run
  in `npm test`. A live golden-set eval `npm run eval:chat` (factual anchors,
  cross-profile differentiation, dosha grounding, contradiction scan) covers the
  nightly/pre-release layer. A **component test** (`ChatPanel.test.tsx`, jsdom +
  Testing Library) verifies the profile-switch reset. See
  [astro-chat.md](astro-chat.md) § Validation.
- Full details & roadmap: **[astro-chat.md](astro-chat.md)**.
- Files: `server/llm.ts`, `server/chat.ts`, `server/db.ts`, `server/features.ts`,
  `server/rateLimit.ts`, `src/components/ChatPanel.tsx`, `src/chat/AstroChat.tsx`,
  `src/api/client.ts`, `src/App.tsx`, `src/main.tsx`, and the Doshas/Muhurta/Vastu
  views.

## Life events — what the chart says about what actually happened

Phase A of [rectification & event analysis](rectification-and-event-analysis.md).
Under **Events → Your life events**: add dated events and see what classical
Jyotisha reads in each moment — the dashas that were running, the transits, the
divisional chart the texts send you to, and any natal yoga that was live.

- **The karaka table is a prior, not a model.** Twenty event types mapped to
  houses, karakas and vargas, each row citing its source, written before any
  user data was scored and never to be tuned to make a chart come out right.
  With nine dasha lords over three nested levels, twelve houses, aspects and
  transits, *some* combination can be narrated as an explanation for any date
  whatsoever — that discipline is the only thing standing between this feature
  and astrology-flavoured noise.
- **Only the strongest link per lord counts.** A lord that both owns and
  occupies the 7th does not score twice; the texts do not say it is twice as
  likely, and stacking is how a scorer starts explaining everything.
- **Every event is scored against 200 random dates in the same life**, and the
  percentile — not the raw score — is what the UI shows. It is self-calibrating:
  near 50 means the chart says nothing in particular about that date, and the
  feature says so in as many words. Costs ~2 ms, so it shipped now rather than
  in Phase B as planned.
- **The null arm immediately caught two defects**, neither visible from the
  output: the yoga layer ran only for the real event and not for null samples,
  inflating every percentile by ~4 points (53.9 → 49.4 against the 50.0 a
  meaningless scorer must produce); and ties counted as "beaten", now on the
  mid-rank convention.
- **The regression test is exact, not statistical.** The statistical form could
  only see a 4-point shift against a 1.6 standard error — too close to call
  without flaking. `scoreEventDate()` is exported to assert the invariant that
  scoring must not depend on whether anyone is listening; it is also the hot
  path rectification will call per candidate birth time.
- **Dissent is shown, not hidden.** Each reading lists what the chart does *not*
  support. A system that only ever agrees with the user is the failure mode.
- **Labelled "traditional method, unvalidated"** in the UI, per the decision in
  Part 5 of the research — there is no licence-clean source of real birth times
  to validate against, and recovering one would prove the search works, not the
  astrology.
- Analysis is entirely client-side; the server stores events and nothing more,
  so there is no quota. The whole Events tab is a 23.5 kB lazy chunk.
- 16 new tests, 374 pass.
- Files: `src/astro/eventKaraka.ts`, `src/astro/eventAnalysis.ts` (+ `.test.ts`),
  `server/lifeEvents.ts`, `server/db.ts`, `server/index.ts`, `src/api/client.ts`,
  `src/components/LifeEventsView.tsx`, `src/components/EventsTab.tsx`,
  `src/App.tsx`, `src/styles.css`.

## Mobile responsiveness — Phases 3 & 4

**Phase 3 — touch and breakpoints.**

- **Zero controls under 44px** on any of the 20 tabs at 375px. The audit had
  sampled one tab and found 10; sweeping all of them turned up more — sub-tabs
  at 31px, antardasha rows at 40px, the Vastu selects at 37px, the plan buttons
  at 36px. Inline text links are deliberately excluded: WCAG 2.2 "Target Size
  (Minimum)" exempts inline targets, and padding them out would have added
  ~26px to the header's birth-detail line to no end.
- **The touch rules live at the end of the stylesheet on purpose.** Several
  controls carry an earlier, more specific size (the header pills are pinned to
  42px so they line up), and at equal specificity source order decides — in the
  middle of the file the rule silently lost.
- **Eleven breakpoints became two** (`640px` phone, `900px` tablet), documented
  at the top of the stylesheet with the reason they can't be CSS variables (a
  variable is invalid inside a media query without a PostCSS plugin this build
  doesn't have). The migration is *directional*, not neutral: every value moved
  outward, so content now collapses at a **wider** viewport than before, never a
  narrower one — a direction that cannot introduce an overflow that wasn't
  already there, which is what made it safe to do in bulk.
- **Admin console swept at 375px**: the 14-section nav went from a **210px wall
  to a 57px strip**, reusing the module-tab treatment. Verified by injecting the
  real admin markup into the live page, since an admin session wasn't available
  in the browser.
- One deliberate behaviour change: the nav strip and settings disclosure moved
  from 720px to the 900px token, so **iPad portrait (768px) gets them too** —
  first content pixel there went 602px → 395px. That was the open question left
  at the end of Phase 2.

**Phase 4 — payload. Initial JS 749.56 kB → 372.86 kB; gzipped 219.38 kB →
120.42 kB, a 45% cut.** Vite's 500 kB chunk warning is gone.

- Beyond the admin console and lessons drawer the plan named, every secondary
  destination is now its own chunk — the three match views, Career, Health,
  Mental Health, Vastu, Muhurta, Pooja, Billing, Notes, Learn, Consultation,
  the temple portal, Reminders, Contact and the export modal. None of it is
  needed to render a kundli. One `<Suspense>` wraps the tab area, not one per
  view.
- **The lessons drawer had to be split in two.** Lazy-loading it wholesale would
  have taken the handle off screen until the chunk arrived; the handle and the
  open state stay eager in `LessonsDrawer`, and everything behind them moved to
  the new `LessonsPanel`, which is the lazy boundary.
- **Navigation is wrapped in `startTransition`.** Switching to a lazy view
  straight out of a click handler makes React suspend *synchronously* — it logs
  `A component suspended while responding to synchronous input` and answers by
  tearing the boundary down to the fallback, flashing "Loading…" even when the
  chunk is cached. Found in the browser console, not by any test; re-verified
  across thirteen lazy destinations with a console marker proving no new errors.
- **`ExportReport` mounts only while open.** It renders null when closed, but it
  was mounted as soon as a chart existed, which would have pulled its chunk onto
  the critical path regardless.
- Files: `src/App.tsx`, `src/components/LessonsDrawer.tsx` (rewritten),
  `src/components/LessonsPanel.tsx` (new), `src/styles.css`,
  `src/styles.mobile.test.ts`, `docs/mobile-responsive.md`.

## Mobile responsiveness — Phase 2

Reclaiming the screen: on a 375×812 phone the first pixel of content sat at
**1,242px** — 1.5 screenfuls of header and navigation on every tab, every visit.
Now **353px**.

- **Tab nav 575px → 63px.** Nineteen tabs wrapping into eight rows (71% of the
  viewport) became one horizontally-scrolling, scroll-snapping strip at ≤720px:
  sub-labels hidden, bleeding to the screen edges so it reads as scrollable, and
  **sticky at the top** so switching module never means scrolling back up. A
  `<select>` would have been smaller still, but it hides eighteen options behind
  a tap — nobody would discover Muhurta or Vastu again.
- **A `useEffect` centres the active tab** when it changes from anywhere other
  than a tap on it (loading a profile, a feature flag falling back to Kundli, a
  lesson's "see this in your chart" link). It scrolls the strip only —
  `scrollIntoView()` would move the page vertically and fight the sticky strip.
  **`behavior: "smooth"` had to be dropped**: a scroll-snap container cancels a
  smooth programmatic scroll and springs back, measured — the default lands and
  snaps correctly.
- **Header 418px → 195px.** Tagline hidden, brand scaled down, and the two
  identity blocks put on one row. That last part needed `display: contents`
  rather than flexbox: the profile pill lives inside a `.profile-switcher`
  wrapper, so its `max-width: 100%` resolved against a wrapper that was itself
  content-sized — the pill rendered **279px wide inside a 138px column and drew
  straight over the notification bell**. Dissolving both blocks into one grid
  with explicit placement fixes the overlap *and* lets the birth-detail line
  span the full width, where it reads in full instead of `01/01/1990 · 1…`.
  The labels the header was designed around ("Viewing profile" / "Signed in as")
  are kept; the `UNSAVED` badge and the account name give up their width to the
  profile name, which is what the pill is for.
- **Chart settings 203px → 63px.** Ayanamsa, lunar node and language are set
  once and rarely revisited, so on phones they collapse behind a
  `⚙ Chart settings · Lahiri (Chitrapaksha) · Mean node · English ▾` summary.
  The fields are always rendered — only CSS hides them — so desktop is
  untouched and the toggle never appears there.
- Verified at 375×812 (all 20 tabs `scrollWidth === 375`; strip pins at
  `top === 0` when scrolled; disclosure 63 ↔ 249px; a 26-character profile name
  truncates with an ellipsis and stays in its column), 360×740, 700×900,
  768×1024 and 1280px — where the header is exactly what it was: identity still
  `flex` not `grid`, badge and account name still shown, pill still 279px.
- Two more CSS-source guards, both confirmed to fail when the rules are removed.
- Files: `src/App.tsx`, `src/styles.css`, `src/styles.mobile.test.ts`,
  `docs/mobile-responsive.md`.

## Mobile responsiveness — Phase 1

Audit in [`docs/mobile-responsive.md`](mobile-responsive.md); this is the
CSS-only first phase of its four.

- **Kundli scrolled sideways on phones** (`document.scrollWidth` 757 at a 375px
  viewport). `.chart-layout` already collapsed to `grid-template-columns: 1fr`
  at ≤900px — but `1fr` means `minmax(auto, 1fr)`, and `auto` as a *minimum* is
  **min-content**, which for the planet table (`white-space: nowrap` on every
  cell) is 737px. The column was forced wider than the screen, so the
  `.table-wrap { overflow-x: auto }` already wrapping that table never got to
  scroll. `minmax(0, 1fr)` + `min-width: 0` on the children fixes it; the table
  now scrolls inside its own wrapper exactly like Transit.
- **iOS focus-zoom killed on phones.** 21 rules set form controls to 13–15px,
  and mobile Safari zooms the page on focus below 16px without zooming back —
  so every tap into the birth form, chat box or filter left the user pinching
  out. One `@media (max-width: 640px) { input, select, textarea { font-size:
  16px !important } }` fixes all 21 while leaving desktop density alone. The
  `!important` is load-bearing: every one of those rules is class-scoped and
  would outrank a bare element selector.
- **`calc(100vh …)` → `calc(100dvh …)`** (with the `vh` line kept as a fallback)
  for the chat window and celebrity modal — on iOS `100vh` is the *large*
  viewport height, so the chat input row could sit under the URL bar.
- **`minmax(320px, 1fr)` → `minmax(260px, 1fr)`** on `.doshas-list` and
  `.muhurta-days`, which overflowed on 320px-wide devices.
- **CSS-source regression guard** (`src/styles.mobile.test.ts`, 5 assertions).
  jsdom has no layout engine — `getBoundingClientRect()` returns zeros — so no
  test in this suite could have caught the Kundli bug, and pretending otherwise
  would be theatre. The guard instead asserts the two bug *classes* at their
  source. **It found 12 more bare-`1fr` grids than the browser sweep did**
  (`.billing-plans`, `.kuta-grid`, `.article-cards`, `.contact-form-grid`, …):
  the sweep only catches what overflows with *today's* content, while those
  carry the identical latent bug. All 12 converted.
- Verified at 375×812: all 19 tabs now report `scrollWidth === 375`, every
  on-screen form control measures 16px, the Kundli SVG fits at 335px (was 420).
  Desktop re-checked at 1280px and unchanged — grid still `420px 758px`, table
  unclipped, selects back at 13px.
- Files: `src/styles.css`, `src/styles.mobile.test.ts`,
  `docs/mobile-responsive.md`.

## Feature feedback (per-module 👍/👎)

- **"Was this helpful?" strip at the foot of every feature tab** — thumb up/down
  plus an optional comment, prompted differently per rating ("What worked well?"
  vs "What was missing or wrong?"). Nothing is sent until the user presses Send,
  so a stray tap costs nothing.
- **One mount covers every module.** Rather than editing ~20 view components,
  a single `<FeatureFeedback feature={tab} …/>` sits just before `</main>` in
  `src/App.tsx` and uses the active tab id as the feature key — so any tab added
  later is covered automatically.
- **Resets on tab switch** so feedback always describes what is on screen, and is
  **hidden for guests** (the endpoint requires auth — a signed-out visitor would
  otherwise write a comment and hit a 401).
- **Admin → Feedback**: per-feature summary bars **sorted worst-first** (lowest
  positive share at the top, since that's where the product work is), with raw
  counts, clickable to filter; then the entry list with feature/rating/status
  filters and a `new → read → actioned` triage. Nothing is deleted.
- **Quota'd** like every other feature (`feedback`: free 20 / pro 40 / premium 60
  per day, admin-editable in Plan Limits) so the admin view can't be flooded.
  A `429` is shown to the user rather than a false thank-you.
- **Two bugs caught in verification against the live API:** `feedbackSummary()`
  never selected `total`, so every summary bar would have rendered `0%` and
  "undefined ratings"; and `setFeedbackStatus()` returned `RETURNING *` without
  the users join, so marking an entry read/actioned dropped the submitter's email
  from the row the UI swapped in. Both fixed.
- **17 new tests** (8 widget + 9 admin section).
- Files: `server/feedback.ts`, `server/db.ts`, `server/admin.ts`,
  `server/rateLimit.ts`, `server/index.ts`,
  `src/components/FeatureFeedback.tsx` (+ `.test.tsx`),
  `src/components/AdminView.tsx`, `src/components/FeedbackSection.test.tsx`,
  `src/api/client.ts`, `src/App.tsx`, `src/styles.css`, `docs/feedback.md`.

## Sample charts — celebrity picker

- **"⭐ Other celebrities" button** beside the existing example chips opens a
  modal of **50 public figures** (20 South India, 20 North India, 10 US) with
  search across name/place/field and region filters. Picking one fills the birth
  form exactly like the existing Gandhi/Kalam examples, ready to cast.
- **Time zones are resolved from an IANA zone for the birth date**, not stored as
  fixed offsets — so historical rules apply automatically: Martin Scorsese's
  Nov-1942 New York birth correctly resolves to **UTC−4 (WWII war time)**, not
  EST, and Meryl Streep's June-1949 New Jersey birth to −4 (DST).
- **Birth times are not publicly documented** for these figures, so every entry
  uses 12:00 noon with `timeKnown: false`, and the modal says so plainly: signs,
  nakshatras and dashas are accurate, the Ascendant and houses are indicative.
  Inventing times would have been the alternative.
- **Data fix:** the source table gave Martin Scorsese longitude `-942`, outside
  the valid −180..180 range; corrected to New York's −74.0060. A test now guards
  the bounds for every entry.
- **Bug found in browser testing:** the picker renders inside the birth `<form>`,
  and its buttons had no `type`, so they defaulted to `type="submit"` — every
  region-filter click submitted the form, casting a chart from stale values and
  unmounting the modal. Fixed, with a regression test asserting every button is
  `type="button"` plus one that renders the picker inside a form and checks no
  submit fires.
- **24 new tests** (16 dataset + 8 component), including one that casts a chart
  for **all 50** entries and validates every planet.
- Files: `src/data/celebrities.ts` (+ `.test.ts`),
  `src/components/CelebrityPicker.tsx` (+ `.test.tsx`),
  `src/components/BirthForm.tsx`, `src/styles.css`.

## Custom-domain runbook

- Added **[custom-domain.md](custom-domain.md)** — a reusable checklist for
  pointing the app at a custom domain or moving it later. Confirms **no code
  changes are needed** (the session cookie sets no explicit `domain`, so it
  follows the host; nothing hardcodes a hostname), then covers DNS including the
  **apex-CNAME restriction** and the two ways round it, the required `APP_URL`
  update, OAuth redirect URIs, and the Stripe webhook's **new per-endpoint
  signing secret** — the one whose omission fails silently. Includes a
  verification list, rollback, and a symptom→cause table.

## Railway deployment — shipped, plus fixes found doing it

The app is **live on Railway**. Getting there surfaced several real defects,
all fixed and documented in the new runbook
**[railway-deployment.md](railway-deployment.md)**:

- **Build failed — `tsc: command not found`.** Railway sets
  `NPM_CONFIG_PRODUCTION=true`, so `npm install` skipped `devDependencies` where
  `typescript` and `vite` live. Build command now passes `--include=dev`.
- **Build failed — `EBUSY … rmdir '/app/node_modules/.cache'`.** Railway mounts a
  cache *inside* `node_modules`; `npm ci` deletes the tree wholesale and can't
  remove the mount. Switched to `npm install`.
- **Silent localhost fallback.** An unset/stale `DATABASE_URL` produced only an
  `ECONNREFUSED 127.0.0.1:5432` stack trace. Startup now fails fast, naming the
  received host, value length and prefix, and distinguishing *unset* /
  *localhost* / *unresolved `${{ }}` reference*.
- **Missing `NODE_ENV` was dangerous.** Production was inferred solely from
  `NODE_ENV`, so forgetting it on a host left the SPA unserved, the DB guard
  skipped and — worst — **passwordless dev login enabled in public**. Production
  is now also inferred from `RAILWAY_*` / `RENDER` / `FLY_APP_NAME` /
  `K_SERVICE` / `DYNO`.
- **`APP_URL` defaulted to localhost**, breaking OAuth, email-verification and
  Stripe redirects. It now derives from the platform's public domain when unset.
- **🔴 The startup banner logged the database password.** Deploy logs get pasted
  into chats and screenshots — the connection string is now redacted.
- Also added `.railwayignore` (no `.git` here, so `railway up` would otherwise
  have uploaded the local `.env`), and redacted working admin credentials from
  `docs/admin-console.md` before the repo went public.

## Railway deployment (setup)

- **The app now deploys as a single always-on service.** `server/index.ts` serves
  the built SPA from `dist/` with an SPA fallback when `NODE_ENV=production`
  (mounted after the API routes, so `/api/*` and `/auth/*` are never shadowed and
  unknown API paths still 404 as JSON). One origin keeps the same-site session
  cookie and relative `fetch` paths working with no CORS. `SERVE_STATIC=false`
  opts out if the frontend is hosted separately.
- **Production hardening:** `ALLOW_DEV_LOGIN` now defaults **off** when
  `NODE_ENV=production` and must be explicitly `"true"` to enable — previously it
  defaulted on, which would have let anyone sign in as any name on a public
  deploy.
- **Postgres TLS is automatic:** enabled for remote hosts (Railway's public
  proxy, Neon, Supabase), skipped for `localhost` and `*.railway.internal`;
  `sslmode=disable` and `PGSSLMODE` are honoured.
- **`tsx` moved to `dependencies`** so `npm start` survives dev-dependency
  pruning, plus a `start` script and `engines: node >=20`.
- **New [`railway.json`](../railway.json)** — Nixpacks build, `npm start`,
  healthcheck on `/api/health`, restart-on-failure, one replica.
- **New `npm run deploy:check`** ([`scripts/deploy-check.ts`](../scripts/deploy-check.ts))
  — a preflight that exits non-zero on placeholder secrets, missing
  `DATABASE_URL`, non-HTTPS `APP_URL`, dev login enabled in production, partial
  admin config or a missing build, and reports which integrations are live.
- Step-by-step instructions in [deployment.md](deployment.md#deploying-to-railway);
  `.env.example` gained a production section.
- **Scheduler extracted for scale-out.** The reminder/promo sweep is now also a
  one-shot process that exits — `npm run scheduler:run`
  ([`scripts/run-scheduled.ts`](../scripts/run-scheduled.ts)) — suitable for a
  Railway Cron service. It logs what it dispatched, closes the pool, and exits
  non-zero if either check failed so a bad run is visible. It is idempotent
  (verified: a second run dispatched 0 and sent no duplicate). `RUN_SCHEDULER=false`
  disables the in-process timer on the web service, which then boots with
  `scheduler✗(cron)`. With cron in place the only remaining per-process state is
  the rate limiter / quota table.
- **Fixed: reminder notifications named the wrong day.** `prettyDate` in
  `reminderScheduler.ts` formatted a UTC-pinned date without `timeZone: "UTC"`,
  so any server west of UTC told users their ritual or festival was **a day
  earlier** than it is (a reminder for 2026-08-05 read "4 August 2026"). Same
  class of bug as the Muhurta heading; found by running the new cron job against
  a seeded reminder.
- Files: `server/index.ts`, `server/config.ts`, `server/db.ts`,
  `server/reminderScheduler.ts`, `railway.json`, `scripts/deploy-check.ts`,
  `scripts/run-scheduled.ts`, `package.json`, `.env.example`.

## Muhurta — quality audit & fixes

- **Audited the module against external and analytic references.** Tithi was
  validated against published syzygy instants (New Moon 2026-08-12 17:37 UTC,
  Full Moon 2026-08-28 04:18 UTC): the module reads Amavasya/Purnima at sunrise
  on those dates and rolls to Pratipada the next day — exactly right. Sunrise/
  sunset was checked against **first principles** (not a third-party API) and
  matches the analytic half-day formula to under a minute (Delhi solstice 838.0
  analytic vs 838 computed; equator equinox 726.7 vs 727). GMST is exact to 4 dp
  and solar declination is correct at the solstice. The Rahu Kaal / Yamaganda /
  Gulika weekday tables match classical convention, Abhijit is centred on solar
  noon, and Brahma Muhurta spans 96→48 min before sunrise.
- **Fixed: ΔT was not applied.** `muhurta.ts` passed raw JD(UT) to the Sun, Moon
  and ayanamsa routines, while `engine.ts`, `events.ts` and `transits.ts` all use
  JD(TT). At ~69 s that is ~0.011° of Moon longitude — enough to flip a tithi or
  nakshatra right at a boundary. Now converts to TT for ephemerides while keeping
  sidereal time on UT (the correct split).
- **Fixed: tithi naming.** The 15th tithi of a paksha is now reported as
  "Purnima" / "Amavasya" rather than the redundant "Shukla Purnima" /
  "Krishna Amavasya".
- **Added `src/astro/muhurta.test.ts` (21 tests)** — the module previously had
  none. Covers the syzygy anchors, analytic day length, solar-noon symmetry,
  polar null-handling, southern hemisphere, window conventions and
  non-overlap, tithi continuity (allowing legitimate skips/repeats), field
  ranges, weekday/date agreement, rating spread and all six activities.
- **Fixed: Rahu Kaal shown under the wrong weekday (the "drastically different
  values" report).** `MuhurtaCard` formatted the UTC-pinned civil date with
  `toLocaleDateString` **without** `timeZone: "UTC"`. In any browser west of UTC
  the heading rendered the *previous* day — so Friday's Rahu Kaal (4th day-part,
  ~11:15) appeared under a "Thursday" heading, where a panchang would say ~14:00.
  The computed times were right; the label was a day out. The same bug was fixed
  in the admin festival list.
- **Fixed: stale timezone across DST.** The Muhurta form resolved the UTC offset
  once, when the city was picked, and reused it for the whole range — so a search
  spanning a DST transition (or any date change after picking) was an hour off.
  `MuhurtaLocation` now takes an optional IANA `zone` and resolves the offset
  **per date**; the form tracks the picked city's zone, recomputes on date change,
  and drops it if latitude/longitude/offset are hand-edited.
- **Fixed: inverted windows on a mismatched offset.** Sunrise and sunset were
  found independently within the local day, so if the declared UTC offset was
  badly wrong for the longitude (hand-entered coordinates) the sun could already
  be up at local midnight — the first sunset found belonged to the previous day,
  the daylight span went negative, and every derived window came out
  end-before-start (e.g. "Rahu Kaal 14:55–13:36"). Sunset is now paired with the
  sunrise it follows.
- **Verified against published values:** Rahu Kaal for Delhi on Mon 2026-08-03
  computes 07:25–09:05 against a published 07:24–09:05, and the day-part index
  matches the classical Sunday→Saturday order (8,2,7,5,6,4,3) for every weekday.
- Files: `src/astro/muhurta.ts`, `src/astro/muhurta.test.ts`,
  `src/components/MuhurtaView.tsx`, `src/components/AdminView.tsx`.

## Brand & positioning

- **New tagline** — "**Understand the sky. Align your space. Honour the ritual.**"
  The old "Vedic astrology — compute, understand, learn" described only one of
  the portal's four pillars; the new line covers astrology (sky), Vastu (space)
  and temples/poojas/reminders (ritual) in three invitations.
- Applied consistently to the header tagline, the browser/page **title**
  ("Aistrology · Vedic Astrology, Vastu, Temples & Learning") and the **meta
  description**, which now mention Vastu, temples, auspicious days and learning
  for search results.
- **Provider types (Astrologer / Priest / Both)** — consultation offers now
  declare what they are (`provider_type`, default `astrologer`, added by an
  idempotent migration that backfilled existing rows). Providers pick it in their
  profile form; the directory shows a type badge per card and an
  **All / Astrologers / Priests** filter with live counts. "Both" providers match
  either filter, and invalid values fall back to `astrologer` server-side.
- **Consultations & Astro Chat added to the pitch** — the hero was still missing
  two real pillars. Added bullets for **Consultations** (one-on-one sessions with
  approved astrologers and priests) and **Astro Chat** (chart-grounded Q&A), and
  put Consultations in the eyebrow and intro. The Consultation page itself was
  updated to match — it now welcomes **astrologers and priests** ("Are you an
  astrologer or a priest?", "Find an astrologer or priest"), which the provider
  model already supported via free-text specialities.
- **Hero copy reworked to match** — the landing hero pitched astrology alone,
  which undersold the new tagline. The eyebrow is now
  "Jyotisha · Vastu · Temples · Learning", the intro paragraph walks from the
  chart outward (Vastu → auspicious days → rituals/festivals → temples →
  lessons), and the feature bullets were rebalanced from 5 astrology-only items
  to 6 covering every pillar. The signed-out CTA copy was broadened to match.
- Files: `src/App.tsx`, `index.html`, `src/styles.css` (tagline kept on one line;
  wraps naturally below 700px).

## Landing page (UX)

- **Marketing sections are now visitor-only.** The pricing/plans block, the
  Temple Affiliation section and the long-form "Decoding the Patterns" article
  render only for **signed-out** visitors. Once signed in, the home screen is
  just the hero + birth form, so returning users land straight on the task.
  Plans stay available in the **Plans & Billing** tab.
- **Removed the header Temple button** — the temple portal is reached from the
  Temple Affiliation section on the landing page, so the header nav is now just
  Reminders · Consultation · Admin.
- Files: `src/App.tsx`.

## Profile switcher (UX)

- **Separated "profile" from "account".** Switching the profile (chart) you're
  viewing used to be buried in the account/auth dropdown (branded with the *user*,
  not the profile), with no indication of which profile was active. There's now a
  dedicated **profile switcher pill** in the header that always shows the active
  profile's name, plus a dropdown to **switch** (active profile marked ✓),
  **search** (for users with many profiles), **save** an unsaved chart, create a
  **＋ New chart**, and delete. The account menu is now just identity + sign out.
- **Phase 2 polish:** inline **rename** (via `PUT /api/charts/:id`), a
  **Recent / A–Z** sort toggle, and full **keyboard navigation** (↑/↓ to move the
  highlight, Enter to open, Esc to close).
- **Header layout fix:** the signed-in header used to overflow into a tall
  (~230px) wrapped row of controls floating under the brand. Reworked into two
  clean zones — the **current profile** shown prominently on the right of the
  brand row (**larger, bold name** + a muted birth-detail subtitle, filling the
  old empty gap), and a right-aligned **nav cluster** below (~144px; tidy at
  desktop/tablet/mobile). The active profile in the switcher dropdown is now
  clearly highlighted (gold ✓ + gold label + a gold left accent bar).
- **Labeled identity cluster:** the header's top-right is now a single aligned
  cluster with explicit labels — **"Viewing profile"** over the profile switcher
  (with the birth-detail subtitle) and **"Signed in as"** over the notification
  bell + account pill, separated by a divider. All three controls share a uniform
  42px height, and the nav row (Export/Reminders/Consultation/Temple/Admin) fits
  on one line. Responsive rules keep the cluster tidy and un-clipped on mobile.
- Files: `src/components/ProfileSwitcher.tsx` (+ `.test.tsx`, 8 tests),
  `src/components/AccountBar.tsx` (slimmed), `src/api/client.ts` (`renameChart`),
  `src/App.tsx`, `src/styles.css`.

## Astrology Lessons drawer

- **A slide-out lessons course, available from anywhere** (even signed-out, on
  the landing page) via a **📖 Lessons** handle on the right edge. The existing 9
  lessons were upgraded into a chaptered course with **Beginner / Advanced / Pro**
  tracks, per-track filters and completion counts, an overall progress bar,
  chapter reader with **Prev/Next** (Next marks read), a "Mark complete" toggle,
  and **"✨ See it live" deep links** into the matching app tab (Kundli, Dasha,
  Predictions, Remedies) when a chart is loaded. Progress persists per user in
  localStorage. The full-page **Learn** tab remains for long-form reading.
- **Chart-craft chapters with visuals** — the course grew to 15 chapters with
  six new illustrated ones. Beginner: *How a Chart Is Cast* (birth-data → chart
  flow diagram), *Chart Styles — North & South Indian* (both layouts as labelled
  SVG diagrams: fixed houses vs fixed signs, Lagna markers, reading order), and
  *Reading a Chart, Step by Step* (a five-step routine with an annotated worked
  example). Advanced: *Divisional Charts (Vargas) & the Navamsa* (a 30° sign
  splitting into nine slices) and *Transits & Sade Sati* (Saturn's three-phase
  path over the Moon). Pro: *Ashtakoota Matchmaking* (the eight kootas as
  weighted bars summing to 36). Diagrams are themed SVGs (`LessonVisuals.tsx`)
  rendered in both the drawer and the Learn tab via a `visual` field on lesson
  sections; each new chapter deep-links to its live tool (chart/varga selector,
  Transit tab, Marriage Match).
- **Worked examples mode** — the drawer gained a second mode with **seven
  end-to-end examples** (chart casting → chart reading), each a six-step visual
  walkthrough on a mini-Kundli **computed live by the app's engine**, with
  per-step house/planet highlighting and dignity colouring. The personas teach
  distinct points: the basic routine, sunrise births + dignity extremes, the same
  instant in another city (place moves the Lagna), the same day six hours later
  (time moves the Lagna), and a subtle 12th-house Lagna lord.
- **South Indian style in the examples** — every walkthrough now has a
  **North/South toggle** whose step text adapts to the style (fixed houses vs.
  "find the ◢ stroke and count clockwise"), plus **two new South-first examples**:
  *Kiran* (Hyderabad sunrise — a three-planet Lagna cluster) and *Lakshmi*
  (Madurai — Mercury exalted and Venus debilitated in the **same sign box**,
  which the fixed-sign grid makes obvious).
- Files: `src/components/LessonsDrawer.tsx`, `src/components/LessonVisuals.tsx`,
  `src/components/LessonExamples.tsx`, `src/data/lessons.ts` (levels retyped +
  reading time + deep links), `src/components/LearnView.tsx`, `src/App.tsx`,
  `src/styles.css`.
- **Vastu course** — the drawer gained a **subject switcher** (☸ Astrology /
  🏠 Vastu) and a second seven-chapter course covering what Vastu is, the eight
  directions & five elements, the nine zones & Brahmasthan, room-by-room
  placement, plot shape/slope/entrance, doshas & remedies, and Vastu-meets-
  Jyotisha. The placement rules taught are the same ones the Vastu analyser
  scores against, so lesson and tool never disagree. Four new diagrams
  (direction compass, zone mandala, placement table, slope). Track counts and
  progress are per-subject; every chapter deep-links to the Vastu tab.
- Files: `src/data/vastuLessons.ts`, `src/components/LessonVisuals.tsx`,
  `src/components/LessonsDrawer.tsx`, `src/styles.css`.
- See [lessons.md](lessons.md).

## Notes (per-profile, Pro/Premium)

- **Private per-profile notes** for Pro & Premium users — especially for Premium
  users managing many profiles (consultation prep, observations, follow-ups). A
  **Notes** tab lists the loaded profile's notes with add / inline-edit / delete;
  switching profiles switches the notes.
- Notes attach to a **saved chart**; the tab prompts to save first if the chart
  isn't saved. Free users don't see the tab and the API returns `403`; behind the
  `notes` feature flag. Scoped to the owner (SQL-enforced; cross-user → `404`).
- New `notes` table; endpoints `GET`/`POST`/`PUT`/`DELETE /api/notes`.
- Files: `server/notes.ts`, `server/db.ts`, `server/features.ts`,
  `src/components/NotesView.tsx`, `src/api/client.ts`, `src/App.tsx`.
- See [notes.md](notes.md).

## Admin-editable plan quotas

- The per-plan **daily quotas** (Astro Chat, Justify, Translate, Vastu, new
  charts, bookings) were hardcoded; they are now **DB-backed and editable** in
  **Admin console → Plan Limits** (a plan × feature grid). Saved to the `quotas`
  global setting and merged over the code defaults, applied **live** (no restart),
  with a "Reset to defaults". `0` blocks a feature for a plan.
- Endpoints `GET`/`PUT /api/admin/quotas` + `POST /api/admin/quotas/reset`.
- Files: `server/rateLimit.ts` (defaults + live table), `server/quotas.ts`
  (load/save/reset), `server/admin.ts`, `src/components/AdminView.tsx`
  (`LimitsSection`), `src/api/client.ts`. See
  [rate-limiting.md](rate-limiting.md#editing-the-limits-admin).

## Export / plan gating

- The PDF **Export** is shown to free users as a **blurred teaser** behind an
  "Upgrade to unlock" overlay (instead of being hidden), with the Print button
  swapped for an upgrade CTA. (`src/components/ExportReport.tsx`)

---

## New/changed environment variables

```
# Admin module
ADMIN_EMAIL=            ADMIN_PASSWORD=            ADMIN_ACCESS_CODE=
# Reminder email (optional; falls back to in-app)
RESEND_API_KEY=         REMINDER_FROM_EMAIL=
```

See `.env.example` for the full list.

## New database tables

`consultation_offers`, `consultation_bookings`, `notifications`,
`global_settings`, `temples`, `temple_services`, `temple_events`,
`reminders`, `festivals`, `festival_subscriptions`, `promo_codes`,
`promo_redemptions`, `contact_messages`, `billing_events`,
`chat_conversations`, `chat_messages`, `notes`, `feedback`, `life_events`. New `users` columns
include `role`, `suspended`, `plan_expires_at`, `plan_source` (now also takes
`'disputed'`), and (from earlier work) `email_verified`, `total_charts_created`.
All added idempotently in `initDb()`.
