# Divisional Charts (Vargas) & Ashtakavarga

The engine's two classical strength instruments: the divisional charts, and the
points system used to judge how a graha will actually behave where it sits.

## Vargas

A rashi spans 30°. A varga subdivides it and maps each part to a sign by
classical (Parashari) rules, producing a chart that magnifies one area of life.
`divisionalSign(longitude, varga)` in [`src/astro/varga.ts`](../src/astro/varga.ts)
is the whole implementation.

Twelve are computed. Seven are offered in the chart toggle; five are computed
for the event-analysis karaka table and for rectification but not displayed.

| Varga | Parts | Read for | Shown |
| ----- | ----: | -------- | ----- |
| D1 Rāśi | 1 | the whole life | ✓ |
| D2 Horā | 2 | wealth | ✓ |
| D3 Drekkāṇa | 3 | siblings, courage | ✓ |
| D4 Chaturthāṁśa | 4 | home, land, fixed property | |
| D7 Saptāṁśa | 7 | children | ✓ |
| D9 Navāṁśa | 9 | marriage, dharma, real strength | ✓ |
| D10 Daśāṁśa | 10 | career, standing | ✓ |
| D12 Dvādaśāṁśa | 12 | parents, ancestry | ✓ |
| D16 Ṣoḍaśāṁśa | 16 | vehicles, comforts | |
| D24 Siddhāṁśa | 24 | learning, acquired skill | |
| D30 Triṁśāṁśa | 30 | misfortune, illness | |
| D60 Ṣaṣṭyāṁśa | 60 | the sum of past karma | |

Twelve buttons is a lot of chrome, and D60 changes every two minutes of birth
time — browsing it with an approximate time would suggest a precision nobody
has. `VargaInfo.displayed` gates it; every varga carries the metadata needed to
surface it whenever that is wanted.

### Two that are not like the others

**D30 is not an equal division.** The 30° split into five unequal stretches
ruled by the five non-luminaries — Mars, Saturn, Jupiter, Mercury, Venus from an
odd sign, and the reverse from an even one — and the resulting sign is that
ruler's own. The Sun and Moon hold no trimsamsa, so **D30 never returns Cancer
or Leo**; a test sweeps the whole zodiac confirming it.

**D60 is the rectification chart.** Sixty parts of 30′ each, which Parashara
weights above every other varga for judging a graha's real quality. It changes
every two minutes of birth time, which is exactly why it is the traditional
instrument for fixing an uncertain one — and, for the same reason, useless
unless the time is already known closely. A test counts the 59 changes across a
single sign.

### Birth-time sensitivity

How finely each quantity discriminates, measured across a full day:

| Quantity | Changes/day | Resolution |
| -------- | ----------: | ---------- |
| Lagna sign (D1) | 12 | ~120 min |
| D9 lagna | 108 | ~13.3 min |
| D10 lagna | 114 | ~12.6 min |
| D60 lagna | ~720 | ~2 min |

## Ashtakavarga

[`src/astro/ashtakavarga.ts`](../src/astro/ashtakavarga.ts).

Each of the seven grahas (the nodes take no part) gets a **Bhinnashtakavarga**:
twelve counts of benefic points contributed by eight sources — the seven grahas
and the Lagna. For each contributor there is a fixed list of houses, counted
from where that contributor sits, which receive a point. Adding the seven
together sign by sign gives the **Sarvashtakavarga**.

### The tables carry their own proof

Each graha's benefic places sum to a total every classical text quotes, and
those totals sum to 337 — the Sarvashtakavarga total.

| Sun | Moon | Mars | Mercury | Jupiter | Venus | Saturn | Total |
| --: | ---: | ---: | ------: | ------: | ----: | -----: | ----: |
| 48 | 49 | 39 | 54 | 56 | 52 | 39 | **337** |

A single mistranscribed number in the tables breaks one of these, so the tests
assert all eight across sixty charts. That is the most valuable test in the file
— it makes a transcription error impossible to ship quietly.

### How it is read

| Bindus (own varga) | Reading |
| -----------------: | ------- |
| 5+ | strong — the graha gives its better results in that sign |
| 4 | average |
| ≤3 | weak — it struggles there however well placed it looks |

Sarvashtakavarga per sign is read against the ~28-point average (337 ÷ 12):
30+ strong, 25–29 average, under 25 weak.

### Where it is used

In the transit layer of [event analysis](life-events.md): a transit is scaled by
the bindus the transiting graha's own varga gives the sign it occupies. That is
what the bare house test was missing — Saturn in the 9th means something
different with 7 bindus than with 2.

Measured effect: the transit layer went from saying "nothing changed" 22.7% of
the time to 17.3%. On one test chart a Saturn transit with 2 bindus dropped a
reading from the 76th percentile to the 64th.

**Ashtakavarga is computed but has no UI of its own.** It surfaces only inside
transit reasoning. A bindu table on the Transit tab would be a natural addition.

## Birth-time sensitivity, and what it is not good for

Ashtakavarga varies with birth time only through the Lagna, one of its eight
contributors — so it moves at lagna-sign granularity, roughly every two hours.
That makes it a good instrument for judging strength and a poor one for
rectification, which is why the rectifier does not use it. See Part 3b of
[the research](rectification-and-event-analysis.md#part-3b--phase-b-what-the-ablation-measured).
