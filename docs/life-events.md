# Life Events, Explanations & Birth-Time Rectification

What the **Events** tab does, how to use it, and where each number comes from.

This is the usage guide. The reasoning behind the design — the measurements, the
things that were tried and rejected, the honest limits — is in
[Rectification & event analysis](rectification-and-event-analysis.md), which is
worth reading before trusting any of it.

## The three views

The Events tab has three sub-tabs, all reading the currently selected profile.

| Sub-tab | What it is |
| ------- | ---------- |
| **From the chart** | Milestones the chart *predicts* — Mahadasha changes, Sade Sati windows, Saturn/Jupiter/nodal returns. Nothing to enter. |
| **Your life events** | Events you report, read back against the chart. |
| **Unknown birth time** | Uses those events to search for a birth time you do not know. |

## Events belong to a profile, not to you

An event row carries both a `chart_id` and a `user_id`, and they do different
jobs. The **chart** is who the event is about; the **user** is only who owns the
data. So a Premium user managing family members or clients keeps a separate
event list per person, and switching profiles switches the list.

Two consequences:

- Events need a **saved** profile. Cast a chart without saving and the tab says
  so — there is no `chart_id` to attach them to.
- How many people you can track is your profile allowance: 1 on Free, 2 on Pro,
  10 on Premium (see [Rate Limiting](rate-limiting.md)).

A profile holds up to 100 events.

## Entering an event

Four fields, and the last two matter more than they look.

| Field | Why it exists |
| ----- | ------------- |
| **What happened** | One of 20 types. Free text cannot be scored, so the type is what maps the event to houses, karakas and a divisional chart. |
| **When** | The date. |
| **How well do you know the date?** | Exact / month / year / roughly. This sets the scoring window — and in rectification it *caps the precision of the answer*. |
| **How sure are you it happened then?** | Weights the event when several are combined. |

Rejections are explained in the page: a missing date, a future date, a date
before 1800. (They used to fail silently — the browser's own validation blocked
the form before the handler ran, so the button simply did nothing.)

## Reading an event

Expand a row and you get, in order of contribution:

```
Running then: Mercury / Sun / Sun   (Mahadasha / Antardasha / Pratyantardasha)

◑ Antardasha of Sun: Sun is the natural karaka of this matter.      — BPHS
◑ Mahadasha of Mercury: Mercury occupies the 12th house.            — BPHS
⟡ The date falls close to the start of the Sun Antardasha.          — BPHS
☄ Transiting Saturn was in the 9th house — with 7 bindus in its
  own ashtakavarga, a strong placement.                        — Phaladeepika
```

Five layers contribute, each citing its source: **dasha** lords, **boundary**
proximity, **transits** (weighted by [Ashtakavarga](divisional-charts.md)),
the **divisional chart**, and natal **yogas** that the running lords activate.

Only the strongest link per lord counts. A lord that both owns and occupies the
7th does not score twice — the texts do not say it is twice as likely, and
stacking is how a scorer starts explaining everything.

### The percentile is the number that means something

Each event shows a band (*Strongly / Moderately / Weakly / Not indicated*) and a
percentile. **The percentile is the honest measure.** It is the same scoring run
against 200 random dates in the same life: 90th means the chart really does
single this date out; near 50 means it says nothing in particular.

A raw score out of 100 would be unfalsifiable. This is not.

### Dissent

Where the chart fails to support an event, the reading says so under *"What the
chart does not support"*. A system that only ever agrees with you is not
analysing anything.

### Plain-words explanation (Pro/Premium, AI engine required)

**✦ Explain this in plain words** turns the findings into prose. The model is
given only the computed facts, the classical sources they came from, and
instructions forbidding it to add anything, to forecast, or to say the chart
*caused* the event.

Turning the AI engine off costs the prose and nothing else — the reasons, the
citations and the percentile are all still there, because the model never
produced them. It runs on the `justify_stream` quota.

## Finding an unknown birth time

Under **Unknown birth time**. Needs at least two events on the profile.

The basis: every dasha boundary in a chart slides by **1.35 to 4.5 days for each
minute of birth time**. So a well-dated event is evidence about the clock.

1. Say what you *do* remember — "morning", "after sunset" — if anything. This
   cuts the search space for free.
2. **Search for the time.** ~1 second, entirely in your browser; nothing is sent
   anywhere.
3. Read the result.

### What you get, and what you do not

**A window, never a time.** The reported window is widened to the precision the
dates can support, because the score curve peaks far more sharply than wobbly
dates deserve — 6-minute plateaus were measured sitting 11 minutes from the
truth. Expect roughly **date error ÷ 3**: month-precision dates justify about
±10 minutes, not better.

**A verdict, including "Inconclusive".** This scoring peaks sharply whatever
dates it is given, so the verdict is judged against the same scan on *unrelated*
dates. If your events do not beat that, the answer is *Inconclusive* — a real
answer, not a failure. Roughly 7% of arbitrary date sets still slip through; the
threshold was deliberately set to prefer a false "inconclusive" over a false
confidence.

**Which events disagree.** Each event is reported with where the winning window
sits among its own scores across the day. A dissenting event is worth more than
an agreeing one: either its date is wrong, or the window is.

### If you already know your birth time

After a scan you can ask *"Show me how close it got"* — the search ran without
using the stored time, so the comparison is a genuine held-out test.

You are then asked whether the result may be kept, with what would be stored
itemised: the error, the window width, the verdict, how many events and how well
dated, and your birth **decade**. Never the birth time, the date, the place or
any event. Declining sends nothing.

This is the only licence-clean route to real validation — no public dataset of
birth times exists that can be used (see Part 5 of the research). Aggregates
appear in **Admin → Rectifier accuracy**.

## Documented events on the sample charts

Eight of the celebrity sample charts carry real life events read from Wikipedia
— Rajinikanth, Kamal Haasan, Amitabh Bachchan, Jawaharlal Nehru, Indira Gandhi,
Barack Obama, Abraham Lincoln and John F. Kennedy. Pick one from **⭐ Other
celebrities** and they appear automatically, tagged `doc`, with a link to the
source. They are held in the app, never written to the database, and cannot be
deleted — they are not the user's records.

Each row keeps the precision its source gave. Where Wikipedia said only a year,
the date sits at 1 July and is marked year-precision; a month-only date sits on
the 15th. That is deliberate — it minimises the worst-case error and stops the
data claiming a precision no source supports.

**Read them in *Unknown birth time*, not in the readings.** These figures'
birth times are not known, so the chart uses a 12:00 placeholder — and moving
that placeholder across the day changes the Lagna, the running Mahadasha, and
therefore the whole reading. The tab says so. Rectification is the tab these
events are actually for, because it derives a time instead of assuming one.

The accuracy check is disabled on these charts: there is no real time to compare
a window against, so nothing is offered and nothing is recorded.

**What happens when you run it:** all eight come back *Inconclusive*. That is
not a bug — a control using the same charts and the same date precisions, with
dates fitted to a chosen birth time, recovers that time to within 2–7 minutes.
See [the research](rectification-and-event-analysis.md#first-contact-with-real-data--and-it-says-no).

## Honesty

The feature is labelled **"traditional method, unvalidated"** in the interface.
It applies classical rules as written; it has never been tested against real
birth certificates, and nothing in it is evidence that the rules predict
anything. That label comes off only if the accuracy reports earn it.

## Where things live

| File | Role |
| ---- | ---- |
| [`src/astro/eventKaraka.ts`](../src/astro/eventKaraka.ts) | The prior: event type → houses, karakas, varga, with sources |
| [`src/astro/eventAnalysis.ts`](../src/astro/eventAnalysis.ts) | Scoring, the null arm, `scoreEventDate()` |
| [`src/astro/rectify.ts`](../src/astro/rectify.ts) | The day scan, windows, confidence |
| [`src/astro/eventNarrative.ts`](../src/astro/eventNarrative.ts) | Maps findings onto the Justify endpoint |
| [`server/lifeEvents.ts`](../server/lifeEvents.ts) | Storage and the accuracy endpoint |
| [`scripts/ablation.ts`](../scripts/ablation.ts) | `npm run ablation` — the measurements behind the design |
