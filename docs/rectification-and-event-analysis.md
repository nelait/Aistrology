# Birth-Time Rectification & Event Analysis — Research and Plan

Status: **All phases shipped (A–F).** Event analysis with a null arm, the
ablation study, the engine work it called for, birth-time rectification, LLM
narration over the deterministic findings, and opt-in accuracy collection.

The feature still carries its **"traditional method, unvalidated"** label, and
will until the accuracy reports in Phase F say otherwise. That is now a
question with an answer rather than a permanent disclaimer.

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

## Part 3b — Phase B: what the ablation measured

`npm run ablation` (`scripts/ablation.ts`). There is no ground truth to measure
accuracy against, so it measures four things that do not need any: how often
each layer fires, how often removing it changes the percentile a user sees, how
correlated the layers are, and — the one that matters for Phase D — whether a
layer carries **birth-time information** at all.

### Layer contribution, 150 (chart, event, date) triples

| Layer | Fires | Mean pts | Share of score | Mean \|Δpercentile\| | Never changes rank |
| --- | --: | --: | --: | --: | --: |
| dasha | 98.0% | 32.2 | **83.1%** | 23.1 | 6.7% |
| transit | 36.0% | 7.3 | 6.9% | 6.2 | 22.7% |
| yoga | 21.3% | 6.0 | 3.4% | 3.4 | 50.7% |
| boundary | 20.7% | 7.0 | 3.8% | 4.2 | 28.0% |
| varga | 10.7% | 10.0 | 2.8% | 2.8 | 63.3% |

No pair of layers correlates above 0.3 — they are independent, not echoes.

### Identifiability, 30 subjects × 5 events, full-day scan

Hold a birth time as truth, generate events the model calls strongly indicated
at that time, scan all 1440 minutes, see where it lands. Chance is a
360-minute error. "Plateau" is how wide the winning region is — for
rectification that plateau **is** the window a user should be shown.

| Config | Median err | ≤60 min | Plateau |
| --- | --: | --: | --: |
| all layers | **1m** | 100% | 4m |
| without transit | 1m | 96.7% | 4m |
| without varga | 1m | 100% | 4m |
| without yoga | 1m | 100% | 4m |
| without boundary | 15m | 83.3% | 8m |
| without dasha | 2m | 90.0% | 4m |
| only boundary | **1m** | 96.7% | 4m |
| only dasha | 14m | 80.0% | 8m |
| only transit | 61m | 50.0% | 128m |
| only varga | 284m | 20.0% | 84m |
| only yoga | 486m | 6.7% | 340m |

**This is circular by construction** — events generated by the model, recovered
by the model. It measures whether a layer carries birth-time information, not
whether the astrology is true. Nothing here can test the latter.

### Findings, and what was done about them

1. **Rectification should use `dasha` + `boundary` only.** Dropping transit,
   varga and yoga leaves recovery unchanged at a 1-minute median, while each of
   them *alone* lands at or worse than the 360-minute chance level on a curve so
   flat the plateau runs to 84–340 minutes. They would add cost and flatten the
   sum. `LayerSwitches` was added to the scorer so Phase D can turn them off
   cleanly rather than the harness reaching inside.
2. **The boundary layer is the sharpest instrument, not the dasha layer.**
   Boundary alone recovers to a 1-minute median; dasha alone manages 14. That
   follows from Part 1 — boundaries slide 1.35–4.5 days per minute of birth
   time — but it was not the expected ordering, and it says a rectification flow
   should prioritise events that happen *at a moment* over ones that describe a
   state.
3. **All five layers stay for event *analysis*.** varga and yoga change nothing
   about the percentile half to two-thirds of the time, which is a weak showing
   — but when they do fire they produce the reasons a reader actually finds
   useful ("Venus rules the D9 lagna and was running"). They are poor evidence
   about birth time and decent evidence about meaning; those are different jobs.
   Nothing was re-weighted: tuning weights without ground truth is precisely the
   post-hoc fitting Part 2 warns against.

### What Phase C changed, measured

Re-running the same harness after the engine work, against the Phase B numbers:

| Layer | Never changes rank (before → after) | \|Δpercentile\| |
| --- | --- | --- |
| varga | 63.3% → **44.7%** | 2.8 → **4.2** |
| transit | 22.7% → **17.3%** | 6.2 → 6.3 |
| dasha | 6.7% → **2.7%** | 23.1 → 24.1 |

The varga layer improved most, and for a plain reason: four karaka rows had been
falling back to D1 or D9 because the engine stopped at D12, and the varga layer
skips D1 entirely. Pointing them at the D4, D16, D24 and D30 the texts actually
name took the layer from inert two-thirds of the time to inert 45%.

Ashtakavarga tightened the transit layer by scaling each transit by the bindus
the graha's own varga gives the sign it occupies — five or more and it gives its
better results there, three or fewer and it struggles however well placed it
looks. Concretely, on the test chart a Saturn transit with 2 bindus dropped one
reading from the 76th percentile to the 64th. The layer says less often that
nothing has changed.

The identifiability conclusions did **not** move: rectification should still use
`dasha` + `boundary` only. `only varga` improved from a 284-minute median to
219 with a much tighter plateau (84m → 24m), consistent with the new divisions
being finer — but it remains far worse than the two layers that matter.

### The scaling law that bounds what may be promised

20 subjects, 5 events, dasha+boundary, with noise added to the event dates —
because a real user reports the date something happened, not the date this model
likes best:

| Date error | Median birth-time error | ≤30 min |
| --- | --: | --: |
| exact | 1m | 100% |
| ±7d | 2m | 90% |
| ±20d | 7m | 90% |
| ±45d | 16m | 85% |
| ±90d | 31m | 50% |

Roughly **birth-time error ≈ date error ÷ 3**. A user who is a month out on
their dates cannot be handed a ten-minute answer, and the Phase D interface must
not imply otherwise.

Also measured: **more events do not compensate for worse dates.** With ±20d
noise, going from 2 events to 8 moved the median from 5m to 7m — inside the
noise. Ask for *accurate* dates, not more of them.

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

### As shipped

`src/astro/rectify.ts` + `src/components/RectifyView.tsx`.

Measured on a hidden birth time of 09:42, with five well-dated events:
**window 09:37–09:53, verdict "Narrowed", z = 10.1 above the null**, all five
events agreeing. Run against the same profile with roughly-guessed dates it
returns **Inconclusive**, which is the point.

Three decisions came out of measurement rather than design:

**1. The null arm decides the verdict, not the peak.** The scorer peaks sharply
whatever dates it is given — arbitrary dates measured 2.9 standard deviations
above the day's own mean, which reads as high confidence and means nothing. So
the same scan runs on shuffled dates and the real separation is judged against
that distribution. A first attempt used a *percentile* over the null runs and
had to be abandoned: the false-positive rate moved from 20% to 36% purely by
changing the number of null runs from 6 to 20, because finer rank granularity
let more sets clear the bar. The z-score does not drift that way.

**2. The threshold is deliberately conservative.** Measured over 30 charts,
arbitrary dates as control and model-optimal dates as signal:

| Threshold | False positives | True positives |
| --- | --: | --: |
| z ≥ 2.0 | 20% | 97% |
| z ≥ 3.0 | 10% | 87% |
| **z ≥ 3.5** | **7%** | **77%** |
| z ≥ 4.0 | 3% | 70% |

The distributions genuinely overlap — arbitrary dates reached z = 4.29 at worst,
real events fell to 1.92 at best — so no threshold separates them cleanly.
Telling someone their birth time was found in noise is a worse failure than
telling them to add more events, and "inconclusive" is an honest, actionable
answer. Note also that the signal arm is the easiest possible case, so the
real-world true-positive rate will be below 77%.

**3. The window is widened to what the dates support.** The scoring plateau on
its own overstates the result: measured against known birth times, 6-minute
plateaus routinely sat 11 minutes from the truth. Windows are widened to
±1.5 × the precision the dates allow (a *median* error means half of cases
exceed it), and the raw plateau is kept alongside for reference. After the
change the true time fell inside the reported window in every test case.

### Phase E — narration

`src/astro/eventNarrative.ts` maps a computed `EventAnalysis` into a request for
the **existing** `/api/llm/justify/stream` endpoint. No new endpoint, no new
quota, no new client plumbing: that endpoint's contract is already "explain
these supplied facts, cite only these supplied sources, invent nothing", which
is exactly the requirement. It inherits the paid-plan gate and the
`justify_stream` daily quota.

Every claim the model is permitted to make has already been computed. Turning
the AI engine off costs the prose and nothing else — the reasons, the citations
and the percentile are all still on screen, because the model never produced
them.

**What reviewing the output changed.** The shared system prompt asks for "an
enhanced, personalised prediction" in the second paragraph, which is right for
Justify and wrong here. Left alone, a 44th-percentile event — chance, in other
words — came back promising "a strong potential for intellectual growth and
achievement". Two guidelines fixed it: the event has already happened so nothing
may be forecast, and a band-specific instruction on how confident the prose is
allowed to sound. The same event now opens "only weakly supported by the chart,
with a score of 44% against random dates" and closes "the chart does not
particularly account for it".

Counter-indications are passed in as facts and the model is told to state them.
On that weak reading it named both: the running Sade Sati, and the D24 lagna
lord being absent from the dasha lords.

### First contact with real data — and it says no

All fifty sample charts now carry documented life events, read from Wikipedia
(see [Life events](life-events.md)) — 344 events in total. Running the rectifier
across them is the first time any of this has met real-world data rather than
events the model generated for itself.

**48 of 50 came back `Inconclusive`.** Two did not: Y. S. Rajasekhara Reddy
(z = 3.5) and Yogi Adityanath (z = 4.0).

Those two are the interesting part, and they are almost certainly noise. The
threshold was chosen at a **measured 7% false-positive rate** on arbitrary
dates, which over fifty charts predicts about 3.5 spurious "conclusive" results.
Two were observed. The real data is therefore performing *slightly below* what
pure chance would produce — which is as clean a null result as this could give.

An earlier run on the first eight charts gave the same answer with separation z
between −2.4 and 1.7.

| | Real documented events | Control |
| --- | --- | --- |
| Verdict | Inconclusive, 8 of 8 | Conclusive, 5 of 5 |
| Error vs. planted time | — | **2–7 minutes** |
| Separation z | −2.4 to 1.7 | **3.8 to 9.6** |

The control matters, because without it this would just look like a broken
feature. It uses the *same charts*, the *same event types* and the *same date
precisions* — only the dates are moved to fit a birth time of 14:20. The
machinery finds that easily. Given what actually happened to those eight people,
it finds nothing.

**What this does and does not show.** It is not proof that Jyotisha is wrong,
and it cannot be: the birth times are unknown, so there is no answer to be right
or wrong about. What it shows is narrower and still worth stating — *this*
implementation, on *these* events, at *these* date precisions, does not separate
the real dates from unrelated ones. Caveats: n = 8; many dates are year-only,
which the scaling law says caps resolution near an hour; and a practising
Jyotishi might choose different events, or weight them differently.

It is also, in a real sense, the feature working. A rectifier that produced a
confident time for all eight would be the thing to worry about.

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

### A licence-clean route to real data — **shipped**

Users who already know their birth time are the one source of ground truth that
needs no licence, because the data is theirs. The search has just run **without**
using the stored time, so comparing the two is a genuine held-out test.

**Events → Unknown birth time**, after a scan:

1. *"Do you already know this birth time?"* — nothing happens unless asked.
2. The comparison is shown **first**: recorded time, window centre, the error in
   minutes, and whether the true time fell inside the window. This is useful to
   the user whether or not they contribute.
3. *Then* consent is asked, itemising exactly what would be stored.

What is stored: the error, whether it landed inside, the window width, the
verdict, the separation z, how many events and how well dated, the time-of-day
constraint, and the birth **decade**. What is not: the birth time, the date, the
place, or any event. The `user_id` is kept for one reason — so the row goes when
the account does — and is never read back. Declining sends nothing at all,
verified by intercepting `fetch`.

The write endpoint **rejects** anything that would poison the statistic (an
error outside 0–720 minutes, an unknown verdict, an impossible event count) and
**sanitises** what is merely descriptive (a nonsense decade becomes null, a wild
z is clamped). Rejecting the second class would lose otherwise good reports.

**Admin → Rectifier accuracy** shows aggregates only: reports, % inside window,
median error, % within 30 minutes and 2 hours, broken down by verdict. The row
to watch is `inconclusive` — those are the runs the feature declined to answer,
and if their error is no worse than the confident rows then the confidence
signal is not working.

---

## Part 6 — Engine gaps found

| Gap | Status |
| --- | ------ |
| **Ashtakavarga not implemented** | ✅ **Closed in Phase C.** `src/astro/ashtakavarga.ts` — Bhinnashtakavarga for the seven grahas plus Sarvashtakavarga. Wired into the transit layer, which is where classical practice actually uses it. |
| **Vargas stop at D12** | ✅ **Closed in Phase C.** D4, D16, D24, D30 and D60 added. All four karaka rows that were falling back to a coarser chart now read the one the texts name. |
| **`assessCurrentPeriod` anchors the timeline wrong** | ✅ **Fixed in Phase C.** It now uses `birthDateUT`, and the date formatting reads UT too. Verified identical output from four viewer timezones. |
| **Only one dasha system** | Open. Vimshottari alone is a single witness; serious rectifiers cross-check with a second (Jaimini Chara, Yogini). Not needed for Phase D — the ablation showed Vimshottari boundaries alone recover a birth time to a 1-minute median — but it would be a genuine second opinion. |
| **No known-birth-time dataset** | Open, and unresolvable on current terms. See Part 5. |

---

## Part 7 — Suggested phasing

| Phase | Scope | Why here |
| ----- | ----- | -------- |
| **A** ✅ | Event capture (taxonomy, date precision, per-profile storage) + Feature 2 deterministic explanation, no LLM, **plus the null arm** | Ships user value alone; produces the scorer Feature 1 needs |
| **B** ✅ | Ablation harness (`npm run ablation`) + identifiability study | Settled which layers Phase D should use, and bounded what it may claim |
| **C** ✅ | Fixed the dasha anchor; added Ashtakavarga, D4, D16, D24, D30 and D60 | Accuracy prerequisites for fine resolution |
| **D** ✅ | Rectification scan, heatmap, confidence UI | The headline feature, on a scorer that has been tested. The retrodiction loop is the one piece not built. |
| **E** ✅ | LLM narration over the deterministic reasons | Reuses the *Justify* endpoint, prompt contract and quota outright |
| **F** ✅ | Opt-in accuracy collection from users who know their birth time | The only licence-clean route to real ground truth |

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
