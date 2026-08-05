# Lessons

Built-in courses that teach **Vedic astrology** and **Vastu Shastra** alongside
the tools — available to **everyone** (signed in or not), from anywhere in the app.

## Where it lives

The **📖 Lessons** handle on the right edge of the main page slides out a drawer
([`src/components/LessonsDrawer.tsx`](../src/components/LessonsDrawer.tsx)) with a
**subject switcher** at the top:

| Subject | Content | Modes |
| ------- | ------- | ----- |
| **☸ Astrology** | [`src/data/lessons.ts`](../src/data/lessons.ts) — 15 chapters | Chapters + Worked examples |
| **🏠 Vastu** | [`src/data/vastuLessons.ts`](../src/data/vastuLessons.ts) — 7 chapters | Chapters |

The astrology chapters also appear in the full-page **Learn tab** (`LearnView`),
kept for long-form reading once a chart is open. Progress is shared storage but
counted per subject (lesson ids are unique across courses).

## Tracks & chapters

Fifteen chapters in three tracks, progressing from foundations to interpretation:

| Track | Chapters | Topics |
| ----- | -------- | ------ |
| **Beginner** | 1–7 | What Vedic astrology is, **how a chart is cast** 🖼, **North/South chart styles** 🖼, Grahas, Rashis, Bhavas, **reading a chart step by step** 🖼 |
| **Advanced** | 8–12 | Nakshatras, Vimshottari Dasha, Drishti (aspects), **vargas & the Navamsa** 🖼, **transits & Sade Sati** 🖼 |
| **Pro** | 13–15 | Yogas, the theory of remedies, **Ashtakoota matchmaking** 🖼 |

Each chapter carries a level chip, an estimated reading time, a summary, and
plain-language sections (Sanskrit terms introduced alongside their meaning).

### Visuals

Chapters marked 🖼 include diagrams
([`src/components/LessonVisuals.tsx`](../src/components/LessonVisuals.tsx)):
a birth-data → chart casting flow, the **North Indian diamond** (fixed houses,
Lagna highlighted, anti-clockwise order), the **South Indian grid** (fixed signs,
Aries anchor, the Lagna diagonal stroke), an annotated worked example
(Leo Lagna → Sun in house 10), the **navamsa split** (one 30° sign → nine 3°20'
slices), the **Sade Sati path** (Saturn crossing the 12th/1st/2nd from the Moon,
with phases), and the **koota weights** (the eight tests as bars summing to 36).
They are pure themed SVG/HTML — a section adds one by setting `visual: "<id>"`;
both the drawer and the Learn tab render it.

## Worked examples

The drawer has a second mode — **🧭 Worked examples**
([`src/components/LessonExamples.tsx`](../src/components/LessonExamples.tsx)):
seven personas taken **end-to-end from casting to reading**, each in six visual
steps (birth details → the cast chart → find the Lagna → follow the Lagna lord →
the Moon & dignity standouts → the reading), with a step dot navigator and
Prev/Next.

The charts are **computed live by the app's own engine** (`computeChart`), and
each step's text is largely derived from the computed placements, so every claim
stays astronomically true. The mini-Kundli highlights the relevant houses/planets
per step and colours dignity (green exalted, gold own sign, red debilitated;
`*` = retrograde).

**Both chart styles.** Every walkthrough has a **North Indian / South Indian**
toggle, and the step text adapts to the style — the North version reads by fixed
houses, the South version tells you to find the diagonal ◢ Lagna stroke and count
clockwise. Examples 6–7 open in South style by default and teach South-specific
mechanics; switching styles mid-walkthrough is the fastest way to see how the two
layouts encode the same chart.

| # | Persona | Style | Teaches |
| - | ------- | ----- | ------- |
| 1 | Asha — noon in New Delhi | North | The full five-step routine (Pisces Lagna) |
| 2 | Ravi — sunrise in Chennai | North | Sunrise births; exalted vs debilitated in one chart |
| 3 | Nina — the same instant, in New York | North | Place changes the frame: same sky, Libra rises |
| 4 | Asha's evening twin — Delhi 18:00 | North | Time moves the Lagna: six hours = three signs |
| 5 | Meera — Delhi, 2011 | North | Reading a subtle chart: a hidden (12th-house) Lagna lord |
| 6 | Kiran — sunrise in Hyderabad | **South** | Find the ◢ stroke, count houses clockwise; a 3-planet Lagna cluster |
| 7 | Lakshmi — morning in Madurai | **South** | Sign clusters: Mercury exalted **and** Venus debilitated in one box |

## Drawer UX

- **Track filter** — All / Beginner / Advanced / Pro segmented control, with
  per-track completion counts.
- **Chapter reader** — one chapter at a time with **← Prev / Next →** navigation;
  **Next** marks the current chapter complete (or use the explicit
  "Mark complete" toggle).
- **Progress** — a bar in the header (n/9 · %) plus green ✓ ticks per chapter.
  Stored in `localStorage`, keyed per user (`aistro_lessons_done:<userId>`), so it
  survives reloads. Guests get their own key.
- **"✨ See it live" deep links** — when a chart is loaded, chapters link straight
  to the app surface they teach (Kundli, Dasha timeline, Predictions/yogas,
  Remedies). Hidden when no chart is loaded.
- Esc or backdrop click closes; full-width on mobile.

## Vastu course

Seven chapters in the same three tracks, taught in plain language and matched to
the rules the app's [Vastu](vastu.md) analyser actually applies — so a lesson and
the tool never disagree. Every chapter deep-links to the **Vastu** tab.

| Track | Chapters | Topics |
| ----- | -------- | ------ |
| **Beginner** | 1–4 | What Vastu is (and an honest framing of it), **the eight directions & five elements** 🖼, **the nine zones & Brahmasthan** 🖼, **room-by-room placement rules** 🖼 |
| **Advanced** | 5–6 | **Plot shape, slope, facing & entrance** 🖼, Vastu doshas & practical remedies |
| **Pro** | 7 | Vastu meets Jyotisha — Lagna-suited directions, the 4th lord, Mars as Bhoomi Karaka |

Vastu visuals: the **eight-direction compass** (element-tinted, with lords and the
Brahmasthan), the **3×3 zone mandala** with each zone's preferred use, the
**placement table** (mirroring `IDEAL_PLACEMENT` in
[`server`-side `src/astro/vastu.ts`](../src/astro/vastu.ts)), and the
**slope diagram** (high SW → low NE).

Chapter 4's table is deliberately the same data the analyser scores against:
kitchen → SE, master bedroom → SW, bathroom → NW/W, water → NE, staircase →
SW/S/W, pooja → NE/E, garden → N/NE/E, garage → NW/SE.

## Adding a chapter

Add an entry to `LESSONS` in [`src/data/lessons.ts`](../src/data/lessons.ts) (or
`VASTU_LESSONS` in [`src/data/vastuLessons.ts`](../src/data/vastuLessons.ts)) with
`level` (`"Beginner" | "Advanced" | "Pro"`), `minutes`, an optional
`seeIn: { tab, label }` deep link, and its sections. Both surfaces, the track
counts and the progress tracking pick it up automatically. Keep ids unique across
the two courses — progress is stored in one set.
