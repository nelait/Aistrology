# Mobile Responsiveness — Analysis & Plan

Status: **all four phases shipped.**

## How this was measured

Not by eye. The app was driven in a real Chromium at 375×812 (iPhone-class)
and 768×1024 (tablet), signed in with a cast chart, and audited
programmatically:

- **Overflow sweep** — every one of the 19 module tabs was opened and every
  element under `<main>` measured against the viewport, recording anything
  whose right edge crossed it, plus `document.scrollWidth`.
- **Chrome budget** — absolute document offset of the first content pixel.
- **Form controls** — the stylesheet parsed for every `input` / `select` /
  `textarea` rule with a `font-size` under 16px.
- **Grid audit** — every multi-column `grid-template-columns` declared outside
  a `max-width` media query, to find grids with no mobile fallback.
- **Bundle** — gzip size of the production build.

Where a fix is claimed below as *verified*, it was injected into the running
page and the measurement repeated.

## Summary

The app is in better shape than expected: **18 of 19 tabs have no horizontal
overflow at 375px**, tables already use an `overflow-x: auto` wrapper, the
lessons drawer and chat window already have mobile rules, and the celebrity
picker was made mobile-aware when it was built. There is no "mobile is broken"
emergency.

The problems are two, and they are different in kind:

1. **One real layout bug** on the Kundli tab (page-level horizontal scroll).
2. **The app is mobile-*correct* but not mobile-*usable*.** It takes **1,242
   vertical pixels of header and navigation before the first pixel of content**
   on an 812px-tall screen. Every visit, every tab, starts with a scroll past
   1.5 screens of chrome.

The second is the whole ballgame. Everything else is polish.

---

## Findings

### F1 — Kundli tab scrolls horizontally (P0, **fixed**)

| | |
| --- | --- |
| Measured | `document.scrollWidth` **757px** at a 375px viewport |
| Culprit | `.chart-layout` grid column resolves to 737px |
| Tabs affected | Kundli only |

`.chart-layout` drops to `grid-template-columns: 1fr` at ≤900px. But `1fr` is
shorthand for `minmax(auto, 1fr)`, and `auto` as a *minimum* means
**min-content** — which, for the planet table with `white-space: nowrap` on
every cell, is 737px. The grid column is forced wider than the screen, and the
`.table-wrap { overflow-x: auto }` that already wraps the table never gets a
chance to scroll, because its container was never constrained.

This is why Transit is fine and Kundli is not: Transit's table is not a grid
item, so its wrapper actually bounds it.

**Fix** (verified live — `scrollWidth` went 757 → 375):

```css
@media (max-width: 900px) {
  .chart-layout { grid-template-columns: minmax(0, 1fr); }
  .chart-layout > * { min-width: 0; }
}
```

The table then scrolls inside its own wrapper, exactly like Transit.

### F2 — 1,242px of chrome before content (P1, **fixed**)

Absolute document offsets at 375×812:

| Band | Height | Notes |
| ---- | -----: | ----- |
| `.app-header` | **418px** | brand 81 + identity 198 + nav 82 |
| `.tabs` | **575px** | 19 tabs × ~49px, ~2.5 per row → 8 rows |
| `.calc-settings` | **203px** | ayanamsa / node / language selects + note |
| **Content starts at** | **1,242px** | on an 812px screen |

The tab nav alone is **71% of the viewport**. The reading content — the entire
point of the app — begins below the fold of the *second* screen, and switching
modules means scrolling back up through all of it.

At 768px this collapses to 470px of chrome, which is fine. The pain is
specific to phone widths.

### F3 — Every form control triggers iOS focus-zoom (P0, **fixed**)

**21 stylesheet rules** set a `font-size` below 16px on an `input`, `select`
or `textarea`. Mobile Safari zooms the page whenever a control under 16px
receives focus, and does not zoom back out on blur.

Affected, among others: `.birth-form input` (15px) — the app's front door —
plus `.chat-input input` (13px), `.calc-settings select` (13px),
`.contact-form` (14px), `.muhurta-form` (14px), `.note-title-input` (14px),
`.consult-form` (14px), `.admin-form` (14px), `.limit-input` (13px),
`.festival-lead select` (12px).

So on an iPhone: tap the birth-date field → the page jumps and zooms → the
user pinches back out → taps the next field → it happens again.

### F4 — Tap targets below 44px (P2, **fixed**)

A sample of one tab found 10 interactive elements under 40px tall, including
`.export-btn` (37px), `.nav-consult-btn` (37px), the `.calc-settings` selects
(31px) and the feedback thumbs (36px). Apple's HIG and Android's Material both
call for 44–48px.

### F5 — `100vh` on mobile browsers (P2, **fixed**)

`.chat-window` uses `height: calc(100vh - 100px)` at ≤480px, and the lessons
drawer uses `height: 100%` inside a `100vh`-ish overlay. On iOS Safari and
Chrome Android `100vh` is the *large* viewport height — it excludes the URL
bar that is actually on screen — so the bottom of the chat window (the input
row) can sit underneath the browser chrome. `100dvh` is the fix.

### F6 — Everything ships to every phone (P2, **fixed**)

Production build: **752KB JS (219KB gzipped)** in a single chunk, plus 120KB
CSS (21KB gz). Nothing is code-split.

The two obvious passengers:

| Module | Source size | Who needs it |
| ------ | ----------: | ------------ |
| `AdminView.tsx` | 61KB | admins only — a handful of accounts |
| `lessons.ts` + `LessonExamples.tsx` + `LessonVisuals.tsx` | 69KB | only after the Lessons drawer is opened |

That is ~17% of the source bundle downloaded on a phone by users who will
never render it.

### F7 — Breakpoints are ad hoc (P3, **fixed**)

Eleven distinct `max-width` values are in use: 420, 480, 520, 560, 600, 640,
680, 700, 720, 820, 900. Each was chosen locally, for one component, at the
time it was written. Nothing is wrong today, but there is no shared idea of
"phone" — so the next component invents a twelfth number, and a change at 560
silently doesn't apply to something that broke at 600.

### F8 — Minor (**fixed**)

- `repeat(auto-fill, minmax(320px, 1fr))` on `.doshas-list` and
  `.muhurta-days` overflows by ~30px on 320px-wide devices (iPhone SE 1st gen,
  small Androids). Lowering the min to 260px fixes it and changes nothing on
  larger screens.
- No mobile regression coverage of any kind (see Testing below).

---

## Plan

Four phases. Phase 1 and 2 are the ones that matter; 3 and 4 are worth doing
but nobody will notice them the way they'll notice Phase 2.

### Phase 1 — Fix what's broken ✅ shipped

Measured after, at 375×812: **all 19 tabs report `document.scrollWidth === 375`**
(Kundli was 757), the planet table scrolls inside its own wrapper
(`clientWidth` 335 / `scrollWidth` 758) exactly like Transit, the Kundli SVG
fits at 335px (was 420), and **every form control on screen measures 16px**.
Desktop re-checked at 1280px and is byte-for-byte unchanged: the grid still
resolves to `420px 758px`, the table is not clipped, and the selects are back
to their intended 13px — the override is scoped to ≤640px.

| # | Change | Files |
| - | ------ | ----- |
| 1.1 | `.chart-layout` → `minmax(0, 1fr)` + `min-width: 0` (F1) | `styles.css` |
| 1.2 | One mobile rule lifting every form control to 16px at ≤640px (F3) | `styles.css` |
| 1.3 | `100vh` → `100dvh` for the chat window and drawers (F5) | `styles.css` |
| 1.4 | `minmax(320px…)` → `minmax(260px…)` on two grids (F8) | `styles.css` |
| 1.5 | CSS-source regression guard, 5 assertions | `styles.mobile.test.ts` |

**The guard found 12 more instances of F1 than the browser audit did.** The
sweep only catches a bare `1fr` that overflows *with today's content*;
`.billing-plans`, `.kuta-grid`, `.article-cards`, `.contact-form-grid` and eight
others carry the identical latent bug and would blow out the moment a long
unbroken string or a wide child landed in them. All 12 were converted — that is
the argument for checking the source rather than only the rendering.

On 1.2 — do **not** edit all 21 rules. Desktop density is deliberate and worth
keeping. One scoped block preserves it and fixes the phone:

```css
@media (max-width: 640px) {
  input, select, textarea { font-size: 16px; }
}
```

CSS-only, no component changes, no behaviour change above 640px.

### Phase 2 — Reclaim the screen ✅ shipped

Measured at 375×812, first content pixel: **1,242px → 353px.**

| Band | Before | After |
| ---- | -----: | ----: |
| `.app-header` | 418px | **195px** |
| `.tabs` | 575px | **63px** |
| `.calc-settings` | 203px | **63px** |
| **Content starts at** | **1,242px** | **353px** |

Verified: all 20 tabs still report `scrollWidth === 375`; the strip pins to the
top (`getBoundingClientRect().top === 0` at `scrollY` 900) and centres the
active tab on a programmatic change; the settings disclosure goes 63 ↔ 249px
and back. Re-checked at 360×740 (no overlap, same 353px), 700×900 (strip
active, header still desktop-style), 768×1024 (unchanged — below the strip's
720px breakpoint the nav is still a 233px wall, which is 23% of a 1024px screen
rather than 71% of an 812px one, so it was left alone) and 1280px, where the
header is byte-for-byte what it was: identity still `flex` not `grid`, the
`UNSAVED` badge and the account name still shown, pill still 279px.

**2.1 — Module navigation: 575px → 63px.** ✅ Replace the wrapping wall at
≤720px with a single horizontally-scrolling strip: hide `.tab-sub`, one row,
`scroll-snap-type: x proximity`, and scroll the active tab into view on
change. Sticky under the header so switching modules never requires scrolling
up. *Saves ~525px.*

Considered and rejected: a `<select>` dropdown (kills discoverability — users
would stop finding Muhurta and Vastu), and a bottom tab bar (only fits 5 of 19
and hides the rest behind "More").

**2.2 — Header: 418px → 195px.** ✅ The labelled two-block identity cluster
("VIEWING PROFILE" / "SIGNED IN AS") was built to a desktop brief and is right
there. On phones it should collapse to one row: brand mark, profile pill
(name + ▾), avatar. The tagline, the full birth-detail line, and the
Export / Reminders / Consultation buttons move into the profile and account
menus, which already exist. *Saves ~320px.*

**2.3 — Calculation settings: 203px → 63px.** ✅ Ayanamsa, lunar node and
language are set once and rarely revisited. Collapse them behind a
`⚙ Chart settings` disclosure at ≤720px, closed by default, showing the
current values as a summary line. *Saves ~160px.*

**Two things the plan got wrong, found only by building it:**

- *`behavior: "smooth"` does not work on a scroll-snap container.* The
  "centre the active tab" scroll silently sprang back to where it started; the
  default (instant) behaviour lands and snaps correctly. Measured both ways.
- *The header collapse needed `display: contents`, not flexbox.* Simply putting
  the two identity blocks on one row left the profile pill — which lives inside
  a `.profile-switcher` wrapper — resolving its `max-width: 100%` against a
  wrapper that was itself content-sized. The pill rendered 279px wide inside a
  138px column and drew straight over the notification bell. Dissolving both
  blocks with `display: contents` and placing their children explicitly in one
  grid fixes it *and* frees the birth-detail line to span the full width
  instead of being trapped in a 138px column, where it read `01/01/1990 · 1…`.

Layout is not testable in jsdom, so the two mechanisms are guarded at the
stylesheet level instead (`styles.mobile.test.ts`) — both assertions were
confirmed to fail when the rules are removed.

### Phase 3 — Touch and polish ✅ shipped

Zero controls under 44px on any of the 20 tabs at 375px (was 10 on the one tab
sampled, and more once every tab was swept — sub-tabs at 31px, antardasha rows
at 40px, the Vastu selects at 37px, the plan buttons at 36px). The admin nav
went from a **210px wall to a 57px strip**, verified by injecting the real admin
markup into the live page rather than guessing, since an admin session was not
available in the browser.

Two things worth recording, because the plan called this phase "mechanical, low
risk" and only one half of that was true:

- **The touch-target rules had to go last in the file.** Several controls carry
  an earlier, more specific size — the header pills are pinned to 42px so they
  line up with each other — and at equal specificity source order decides. In
  the middle of the file the rule silently lost.
- **The breakpoint migration is not neutral, it is directional.** Every value
  moved *outward* (≤600 → 640, ≥680 → 900), so content now collapses at a
  *wider* viewport than before, never a narrower one. That direction can't
  introduce an overflow that wasn't already there, which is why it was safe to
  do in bulk. The reverse would not have been.

The one deliberate behaviour change: the nav strip and settings disclosure moved
from 720px to the 900px token, so **iPad portrait (768px) now gets them too** —
first content pixel there went 602px → 395px. That was the open question left at
the end of Phase 2, answered in the direction the measurements pointed.

#### Original plan

- 3.1 Minimum 44px height for buttons, pills and selects at ≤640px (F4).
- 3.2 Standardize on three breakpoints and migrate the eleven existing values
  (F7): `--bp-phone: 640px`, `--bp-tablet: 900px`, `--bp-wide: 1200px`.
  Mechanical, low risk, but do it *after* Phase 2 so it isn't rewritten twice.
- 3.3 Sweep the admin console at 375px — it was never opened on a phone. Its
  tables already use `.admin-table-wrap`, but the 14-item section nav will have
  the same wrapping problem as the module tabs and can reuse 2.1's strip.

### Phase 4 — Payload ✅ shipped

| | Before | After |
| --- | ---: | ---: |
| Initial JS | 749.56 kB | **372.86 kB** |
| **gzipped** | **219.38 kB** | **120.42 kB** |

**−45% off the initial download**, and Vite's 500 kB chunk warning is gone.

Beyond the two boundaries the plan named (admin console, lessons drawer), every
secondary destination is now its own chunk — the three match views, Career,
Health, Mental Health, Vastu, Muhurta, Pooja, Billing, Notes, Learn,
Consultation, the temple portal, Reminders, Contact and the export modal. None
of it is needed to render a kundli, which is what the overwhelming majority of
visits do. A single `<Suspense>` wraps the tab area rather than one per view.

Two details the plan didn't anticipate:

- **The lessons drawer had to be split in two.** Lazy-loading it wholesale would
  have taken the handle off screen until the chunk arrived. The handle and the
  open/closed state stay eager in `LessonsDrawer`; everything behind them moved
  to `LessonsPanel`, which is the lazy boundary.
- **Navigation had to be wrapped in `startTransition`.** Switching to a lazy
  view straight out of a click handler makes React suspend *synchronously* — it
  logs `A component suspended while responding to synchronous input` and answers
  by tearing the boundary down to the fallback, a visible flash of "Loading…"
  even when the chunk is already cached. Caught in the browser console, not by
  any test. `setTab`/`setPage` now wrap their updates; re-verified across
  thirteen lazy destinations with a console marker to prove no new errors.
- **`ExportReport` is mounted only while open.** It renders null when closed,
  but it was mounted as soon as a chart existed — which would have pulled its
  chunk on the critical path anyway.

#### Original plan

- 4.1 `React.lazy` the admin console — it is already behind a role check and a
  separate page state, so this is a near-free ~61KB.
- 4.2 `React.lazy` the lessons drawer and its data — it is already behind a
  handle click. ~69KB.
- 4.3 Re-measure; consider `manualChunks` for the astro engine if the main
  chunk is still over 500KB.

Expect roughly a third off the initial JS, which on a slow connection is the
difference between a usable first paint and a blank screen.

---

## Testing

Be honest about what the current setup can and cannot catch.

**jsdom has no layout engine.** `getBoundingClientRect()` returns zeros there,
so none of the 349 existing tests could have caught F1, and no new vitest test
will catch the next one. Any claim otherwise would be theatre.

Two things that *are* worth adding:

1. **A CSS-source guard** (cheap, runs in the existing suite): parse
   `styles.css` and assert (a) no `input`/`select`/`textarea` rule sets a
   font-size under 16px without a `≤640px` override, and (b) no grid that goes
   single-column at a breakpoint uses bare `1fr`. This catches the two bug
   *classes* found here at their source, in milliseconds, with no new
   dependency.
2. **A Playwright smoke test** (real, but a new dependency): load at 375×812,
   walk all 19 tabs, assert `document.scrollWidth <= 375` on each. This is
   exactly the audit run by hand above, automated — ~40 lines, and it would
   have caught F1 on the day it was introduced.

Recommendation: do (1) in Phase 1 regardless. Do (2) if mobile is going to be
a first-class target, since it is the only thing that actually measures layout.

## Effort

| Phase | Scope | Rough size |
| ----- | ----- | ---------- |
| 1 | CSS only, 4 changes + source guard | small |
| 2 | Nav strip, header collapse, settings disclosure + tests | the bulk of the work |
| 3 | Touch targets, breakpoint tokens, admin sweep | medium |
| 4 | Two `React.lazy` boundaries + re-measure | small |

Phase 1 is worth shipping on its own — it fixes a real bug and the iOS zoom
without touching a single component.
