# Birth-Time Rectification & Event Analysis — Research and Plan

Status: **Phase A shipped** (event capture + deterministic event analysis, with
the null arm). Phases B–F not started. Rectification itself is not built.

Two features were asked for:

1. **Rectification** — a user who does not know their birth time answers questions
   about dated past events, and we work backwards to an approximate birth time
   (and therefore the rest of the chart).
2. **Event analysis** — a user enters their major life events and we explain,
   from the chart and its dashas and transits, why classical Jyotisha would say
   they happened when they did.

## The single most important finding

**These are not two features. Feature 2 is the scoring function that Feature 1
runs in a loop.**

```
score(chart, event) → { strength, reasons[] }

Feature 2 = run it once, on the chart the user already has → show the reasons.
Feature 1 = run it over ~1440 candidate birth times → rank → show the best window.
```

Build **Feature 2 first**. It is independently valuable, far lower risk, needs no
new maths, and it produces the thing Feature 1 cannot exist without. Building
Feature 1 first would mean inventing the scoring function blind and having no way
to inspect whether it is any good.

---

## Part 1 — What birth time actually controls

Everything below is measured against this engine, not assumed. Reference chart:
12 June 1985, Hyderabad, swept minute by minute across the full 24 hours.

### Sensitivity table

| Quantity | Changes per day | Resolution it can give you |
| -------- | --------------: | -------------------------- |
| Lagna sign (D1, whole-sign) | 12 | ~120 min |
| Moon nakshatra | 1 | — |
| Moon pada | 4 | ~6 h |
| **D9 (Navāṁśa) lagna** | **108** | **~13.3 min** |
| **D10 (Daśāṁśa) lagna** | **114** | **~12.6 min** |
| **Vimshottari timeline** | continuous | **see below** |

### The dasha timeline is the fine-resolution instrument

The Moon moves 0.493°/hour. The dasha balance at birth is the fraction of the
Moon's nakshatra already traversed, so *every* dasha boundary for the whole life
slides as the birth time moves. Measured drift, and the closed form
`(0.493°/60 ÷ 13°20′) × lordYears × 365.25` days per minute:

| Lord of the birth nakshatra | Years | Boundary drift per **minute** of birth time | A 10-min error moves every boundary by |
| --- | --: | --: | --: |
| Sun | 6 | 1.35 days | 14 days |
| Ketu / Mars | 7 | 1.58 days | 16 days |
| Moon | 10 | 2.25 days | 23 days |
| Jupiter | 16 | 3.60 days | 36 days |
| Mercury | 17 | 3.83 days | 38 days |
| Rahu | 18 | 4.05 days | 41 days |
| Saturn | 19 | 4.28 days | 43 days |
| Venus | 20 | 4.50 days | 45 days |

Read the other way round — which is the whole basis of event-based
rectification: **an event you can date to ±30 days, if you believe it marks a
dasha transition, constrains the birth time to roughly ±8 minutes.**

Confirmed empirically: for this chart the 3rd Mahādaśā start moved 229.8 days
between a 10:00 and an 11:00 birth.

### There is a discontinuity, and it dictates the algorithm

Once (occasionally twice) per day the Moon crosses into the next nakshatra. At
that instant the starting dasha lord changes and **the entire 120-year timeline
restructures** — the objective function jumps.

Consequence: **no gradient descent, no bisection, no Newton.** The search must be
a grid scan. Which is fine, because:

### The engine is fast enough for brute force

Measured on this machine:

| Operation | Time |
| --------- | ---: |
| `computeChart` | **0.024 ms** |
| `computeVimshottari` (90 y, 3 levels) | 0.115 ms |
| `computeVimshottari` (90 y, 2 levels) | 0.012 ms |
| `computeTransits` | 0.021 ms |

A full 24-hour scan at 1-minute resolution is 1440 candidates ≈ **200 ms**, and
at 10-second resolution ≈ 1.2 s. **This runs in the browser.** No server, no job
queue, no new infrastructure, no per-run cost. That is a significant and
non-obvious result — it means the expensive-sounding feature is the cheap half.

The expensive half is the LLM narration, which should be quota'd exactly like
`justify` and `chat` already are.

---

## Part 2 — The central risk: everything explains everything

This deserves to be stated before any design, because it is the failure mode
that would make both features worthless while looking like they work.

There are 9 dasha lords × 3 nested levels, 12 houses, 27 nakshatras, aspects,
transits and dozens of yogas. **For any date whatsoever, some combination can be
narrated as an explanation.** A scoring function built by looking at real events
and adding rules until they fit will reach 100% "accuracy" and mean nothing.

This makes three things mandatory, not optional:

1. **The karaka mapping is fixed in advance and in writing** — event type →
   houses, karakas and vargas — sourced from classical texts, committed before
   any user data is scored, and never tuned to make a particular chart work.
2. **A null test.** Run the identical scoring on *randomised* event dates for the
   same chart. If random dates score as well as real ones, the feature measures
   nothing. This is cheap to build and is the single highest-value test in the
   whole plan.
3. **Report percentile, not absolute.** "This window explains your events better
   than 97% of random birth times" is a defensible claim and is self-calibrating.
   "94% match" is not.

---

## Part 3 — Feature 2: Event analysis — **shipped**

Lives under **Events → Your life events**. What was built, and where it differs
from the plan below:

| File | Role |
| ---- | ---- |
| [`src/astro/eventKaraka.ts`](../src/astro/eventKaraka.ts) | The prior: 20 event types → houses, karakas, varga, each row citing its source |
| [`src/astro/eventAnalysis.ts`](../src/astro/eventAnalysis.ts) | The scorer, the null arm, and `scoreEventDate()` — the hot path rectification will call |
| [`server/lifeEvents.ts`](../server/lifeEvents.ts) | Storage only. No quota: nothing on this path costs anything to run |
| [`src/components/LifeEventsView.tsx`](../src/components/LifeEventsView.tsx) | The UI, and the "traditional method, unvalidated" notice |

**The null arm shipped in Phase A rather than Phase B.** The plan had it later,
but it costs ~2 ms per event and it is the difference between a number that
means something and one that does not — so there was no reason to show users an
uncalibrated score first. Each event reports a percentile against 200 random
dates in the same life; near 50 means the chart says nothing in particular
about that date, and the UI says so in as many words.

**It immediately earned its place by catching two defects:**

1. The yoga layer ran only when reasons were being collected, so the real event
   could earn 6 points the null pool could never match. Every percentile was
   inflated by about four points — measured 53.9 before, 49.4 after, against
   the 50.0 a meaningless scorer must produce.
2. Ties counted as "beaten". Scoring is coarse and long stretches of a life
   score identically, so ties are common; now on the mid-rank convention.

Neither would have been visible from the output. Both are the exact failure
mode Part 2 warns about, and nothing except a null arm finds them.

The regression test for the first is **exact, not statistical** — the
statistical form could only see a 4-point shift against a 1.6 standard error,
too close to call without flaking. `scoreEventDate()` is exported for it and
asserts the invariant that scoring must not depend on whether anyone is
listening.

### Original design

## Part 3 (design) — Feature 2: Event analysis

### Input model

Precision matters more than the date. People misremember. Capture it:

| Field | Notes |
| ----- | ----- |
| `type` | from a fixed taxonomy (below) — free text cannot be scored |
| `date` | ISO date |
| `precision` | `exact` \| `month` \| `year` \| `approx-age` — drives the scoring window |
| `note` | free text, for the user and for the narration only, never for scoring |
| `confidence` | user's own certainty; weights the event |

### Event taxonomy → karaka mapping (the fixed prior)

Committed up front. Indicative, to be finalised against `references.ts`, which
already carries the classical-citation pattern used by *Justify*.

| Event | Houses | Karakas | Varga |
| ----- | ------ | ------- | ----- |
| Marriage | 7, 2, 11 | Venus, Jupiter (for women) | D9 |
| Childbirth | 5, 9 | Jupiter | D7 |
| Job / promotion | 10, 6, 11 | Sun, Saturn, Mercury | D10 |
| Job loss | 10, 8, 12 | Saturn | D10 |
| Business start | 7, 10, 11 | Mercury, Mars | D10 |
| Higher education | 4, 5, 9 | Jupiter, Mercury | D24 (absent) |
| Relocation / abroad | 3, 9, 12 | Rahu, Moon | D1 |
| Property / vehicle | 4 | Venus, Mars | D4/D16 (absent) |
| Illness / surgery | 6, 8 | Mars, Saturn | D30 (absent) |
| Bereavement (father) | 9, 8-from-9 | Sun | D1 |
| Bereavement (mother) | 4, 8-from-4 | Moon | D1 |
| Accident | 8, 6 | Mars, Rahu | D1 |
| Litigation | 6, 8 | Mars, Saturn | D1 |
| Financial gain | 2, 11 | Jupiter, Venus | D2 |
| Financial loss | 8, 12 | Saturn, Rahu | D2 |

Four of those want vargas this engine does not have (see Gaps).

### Scoring layers

For each event, deterministically, in this order:

1. **Dasha** — MD / AD / PD lords active on the date; do they own, occupy or
   aspect the event's karaka houses? Is the lord the karaka itself? Weight
   MD > AD > PD.
2. **Boundary proximity** — "change" events (marriage, job, relocation) score
   extra near a dasha transition; "state" events do not.
3. **Transit** — Saturn and Jupiter relative to natal Moon/lagna on the date;
   Sade Sati status; Jupiter over the karaka house. `computeTransits` already
   does this.
4. **Varga** — the relevant divisional chart's lagna lord and karaka placement.
5. **Yoga** — natal yogas whose participants are the active dasha lords, i.e. a
   dormant yoga being "switched on". `detectYogas` already exists.
6. **Ashtakavarga** — the classical instrument for exactly this question. **Not
   implemented.** Biggest single engine gap.

### Output

Per event: a strength score, ranked reasons with classical citations, and an
explicit *dissent* line when the chart does **not** explain the event. A system
that explains everything is the failure mode; showing where it fails is the
credibility signal.

### The LLM's role is narration only

Compute the reasoning deterministically, then optionally let the model phrase it
— exactly the existing *Justify* architecture, where references are supplied and
the model may only explain them. Two benefits: the feature works with the AI
engine off, and the model cannot invent astrology.

### Tone (a real product risk)

Bereavement, illness and accidents are in the taxonomy because users will enter
them. Never phrase output as the chart having *caused* the event. Frame as "what
classical Jyotisha reads in this period", keep it in the existing educational
register, and extend the disclaimer. This is worth an explicit copy review, not
a late thought.

---

## Part 4 — Feature 1: Rectification

### Stage 0 — Constrain the search before scoring anything

Cheapest win available. Ask for whatever partial knowledge exists:

- "Morning / afternoon / night", "before lunch", "after sunset"
- Hospital record, birth certificate range, a parent's recollection
- Day of week (catches a wrong *date*, which no amount of scoring will fix)

A "born in the morning" answer removes three quarters of the search space for
free and removes three quarters of the chances to overfit.

### Stage 1 — Grid scan

1-minute steps across the allowed window; ~200 ms for a full day. Optionally
refine the leading windows at 10-second steps.

### Stage 2 — Structural evidence (coarse, robust)

Lagna sign, D9 lagna, D10 lagna, Moon pada. Partitions the day into blocks of
~2 h / ~13 min / ~13 min / ~6 h respectively.

### Stage 3 — Temporal evidence (fine)

Feature 2's scorer over every user event, for every candidate. This is where the
resolution actually comes from — see the drift table.

### Stage 4 — Rank and present a distribution, never a point

The deliverable is a **24-hour heatmap plus the top three windows with their
spans**, not a single time. If the best window is 90 minutes wide, say 90
minutes. Show which events drove the result, and show the dissenters — an event
the winning window fails to explain is information the user should see.

### Stage 5 — Close the loop

Once a window is chosen, run Feature 2 on it and show the alignment. Then
generate a *checkable retrodiction* ("this time implies a significant change
around March 2011 — does that match anything?"). A yes/no answer is a new
constraint and re-runs the scan. This turns rectification into a conversation,
which is both better UX and better inference.

### The honest ceiling

| Claim | Defensible? |
| ----- | ----------- |
| Narrow to a lagna sign (~2 h) | Usually, with 3–5 well-dated events |
| Narrow to ~10–20 min | Sometimes, with several exactly-dated events |
| Narrow to the minute | **No.** Do not offer it. |

---

## Part 5 — Validation

This is the part that decides whether the feature is real.

1. **Hold-out test.** Charts with a *known* birth time and documented dated
   events. Hide the time, run the rectifier, measure the error distribution.
   Report median error, % landing in the correct lagna sign, % within 30 min.
2. **Null test** (Part 2). Randomised event dates. Non-negotiable.
3. **Ablation.** Score with dasha only, then + transits, then + vargas. If a
   layer does not improve hold-out accuracy, it is decoration and should be
   removed from the *scoring* (it can stay in the narration).

### Can we source a real-person validation set? — investigated, answer is no

The existing celebrity dataset is unusable: all 51 entries carry
`timeKnown: false`, deliberately, because their birth times are not public.
Three other routes were checked.

**Wikidata — ruled out, verified.** Wikidata's `P569` (date of birth) supports
time precision down to hour (`12`) and minute (`13`). Two SPARQL queries against
the live endpoint for *any* entity with precision ≥ 13, then ≥ 12, both returned
**zero bindings**. There is no open-licensed birth-*time* data there at all —
every date of birth on Wikidata is day precision or coarser.

**Astro-Databank — ruled out on licensing.** It is the only large collection of
AA-rated (birth-certificate-sourced) times. It is a wiki operated by Astrodienst
AG, a commercial company; the copyright page carries no free-licence statement,
and no CC or equivalent grant could be found. Bundling extracts into a public
repository is a licensing risk that a validation set does not justify.

**Reconstructing times from model memory — refused.** This would be the fastest
route and it is the wrong one. The entire feature turns on minute-level
resolution, and minute-level birth times are precisely the class of fact that
recall gets subtly wrong. A validation set with quietly incorrect ground truth
does not fail loudly — it produces a confident, specific, wrong accuracy figure,
which is worse than having no figure at all. It is the same failure this document
warns about in Part 2, committed one level further up.

**Decision: ship labelled "traditional method, unvalidated."**

Worth being clear that a real dataset would not, on its own, have removed that
label. Recovering a known birth time proves the *search* works. Proving the
*astrology* works needs a control arm — the same procedure on randomised event
dates, showing it beats chance — which is a research study, not a feature.

### What can be validated, and when

Two different claims, only one of which is reachable:

| Claim | Reachable? |
| ----- | ---------- |
| **A — engineering.** "Given events this model treats as strongly indicated, the scan recovers the birth time to within X minutes." | **Yes**, synthetically. |
| **B — astrological.** "Vimshottari dashas correlate with real life events." | **No.** Needs real people, real events and a control. Out of scope. |

Claim A is worth testing properly, because it catches real defects: a
multi-modal objective, a search that converges on the wrong lagna, or an
objective so flat that every candidate scores alike. The harness:

1. Pick a known birth time. Compute its chart.
2. Ask the *scorer* which dates it would call strongly indicated for a given
   event type, and take those as the synthetic event set.
3. Hide the time. Run the scan. Record the error.
4. Repeat across many charts, latitudes and dates → an error distribution and
   an achievable-resolution figure.
5. **Null arm:** the same scan on randomly dated events. If random events
   produce equally confident, equally narrow windows, the objective is
   degenerate and the feature is measuring nothing.

This tests the machinery against itself, which is exactly its limit and should
be stated wherever the numbers appear. **It belongs in Phase B, not now** —
there is no scorer yet for it to test.

### A licence-clean route to real data, later

Users who *do* know their birth time can opt in: they enter their events, the
rectifier runs with their time hidden, and the error is recorded. That
accumulates a genuine, consented validation set with no licensing problem, from
exactly the population that cares. It needs explicit opt-in, should store only
the error and not the events, and is a Phase F item.

---

## Part 6 — Engine gaps found

| Gap | Impact |
| --- | ------ |
| **Ashtakavarga not implemented** | The standard classical answer to "how strong is this transit/period". Biggest gap for both features. |
| **Vargas stop at D12** | No D16/D24/D30/D60. **D60 is the classical rectification chart** (~2 min resolution). Four taxonomy rows above want missing vargas. |
| **Only one dasha system** | Vimshottari alone is a single witness. Serious rectifiers cross-check with a second (Jaimini Chara, Yogini). |
| **`assessCurrentPeriod` anchors the timeline wrong** | It builds the birth `Date` from local components without `tzOffsetHours`, unlike `birthDateUT`. Measured: a 12.5-hour offset for a Hyderabad birth viewed from `America/Los_Angeles` — and *the error changes with the viewer's timezone*. Immaterial for a 19-year Mahādaśā; **not** immaterial for pratyantardashas, which these features depend on. Fix before building on it. |
| **No known-birth-time dataset** | See Part 5. |

---

## Part 7 — Suggested phasing

| Phase | Scope | Why here |
| ----- | ----- | -------- |
| **A** ✅ | Event capture (taxonomy, date precision, per-profile storage) + Feature 2 deterministic explanation, no LLM, **plus the null arm** | Ships user value alone; produces the scorer Feature 1 needs |
| **B** | Ablation harness — score with dasha only, then + transits, then + varga, and drop any layer that does not earn its place | The null arm came forward into A; this is what is left |
| **C** | Fix the dasha anchor; add Ashtakavarga and D60 | Accuracy prerequisites for fine resolution |
| **D** | Rectification scan, heatmap, confidence UI, retrodiction loop | The headline feature, on a scorer that has been tested |
| **E** | LLM narration over the deterministic reasons | Reuses the *Justify* pattern and its quota |
| **F** | Opt-in accuracy collection from users who know their birth time | The only licence-clean route to real ground truth |

Phases A and B together are the honest minimum before showing anyone a
rectified birth time.

## Data model sketch

Per-profile, like Notes — tie to `chart_id`, enforce isolation in SQL, create
idempotently in `initDb()`:

- `life_events` — `id, chart_id, user_id, type, event_date, precision, confidence, note, created_at`
- `rectification_runs` — `id, chart_id, user_id, window_start, window_end, resolution_seconds, top_windows (jsonb), score_percentile, chosen_time, created_at`

Keeping runs is what makes the retrodiction loop and any later accuracy audit
possible.

## Open questions for the product owner

1. Is rectification a **Premium** feature? It is cheap to compute but it is the
   most "expert" thing in the app, and it pairs naturally with the Premium
   multi-profile audience.
2. Do we ever show a **single** recommended time, or always a window? (Strong
   recommendation: always a window, with the option to commit one to the profile.)
3. ~~Validation dataset or unvalidated label?~~ **Settled: unvalidated label.**
   See Part 5 — no licence-clean source of real birth times exists.
