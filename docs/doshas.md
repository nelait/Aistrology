# Doshas

Detects the classic afflictions of a birth chart and explains each one — why it
forms, what it traditionally signifies, and a customary remedy. Pure astrology
logic (no LLM/API), mirroring the yoga detector.

- **Engine:** [`src/astro/doshas.ts`](../src/astro/doshas.ts) — `detectDoshas(chart)`.
- **UI:** the **Doshas** tab (`src/components/DoshasView.tsx`), a core reading
  tab like Predictions/Dasha (not behind a feature flag).

## Output shape

```ts
interface Dosha {
  name: string;
  sanskrit?: string;
  severity: "high" | "moderate" | "low";  // shown as Strong / Moderate / Mild
  planets: PlanetName[];
  houses?: number[];
  description: string;   // why it forms in THIS chart
  effect: string;        // what it signifies
  remedy: string;        // customary upaya
  cancellation?: string; // mitigating factors present in the chart
}
```

Cards are colour-coded by severity (red / gold / green). If nothing is found, a
reassuring "No major doshas detected" state is shown.

## Detected doshas & rules

All house numbers are whole-sign from the Lagna unless noted. "Conjunct" means
same sign.

| Dosha | Rule (as implemented) | Severity |
| ----- | --------------------- | -------- |
| **Mangal (Manglik)** | Mars in house 1, 2, 4, 7, 8 or 12. Also cross-checked from the Moon. | High for 7th/8th, else Moderate; **Low** if Mars is exalted/own/Moolatrikona (noted as a mitigating factor). |
| **Kaal Sarpa** (Anant…Sheshnag) | All 7 planets fall on one side of the Rahu–Ketu axis. Type named by Rahu's house. | High (Moderate when a planet sits on the axis → partial). |
| **Surya Grahan** | Sun conjunct Rahu or Ketu. | Moderate |
| **Chandra Grahan** | Moon conjunct Rahu or Ketu. | Moderate |
| **Guru Chandal** | Jupiter conjunct Rahu (or Ketu). | Moderate |
| **Angarak** | Mars conjunct Rahu. | Moderate |
| **Shrapit** | Saturn conjunct Rahu. | High |
| **Pitra** | Rahu/Ketu in the 9th house, **or** Sun conjunct Rahu/Ketu/Saturn. | Moderate |
| **Kemadruma** | Moon with no planet in the sign before/after it and none alongside (isolated Moon). | Moderate |
| **Shakata** | Moon in the 6th, 8th or 12th house from Jupiter. | Low |

### Kaal Sarpa detection

Each planet's arc is measured forward from Rahu: `(lon − Rahu.lon + 360) mod 360`.
Ketu sits at 180°. If all seven planets have an arc ≤ 180 (or all ≥ 180), they're
hemmed on one side → Kaal Sarpa. A planet within ~1° of the axis makes it a
**partial** Kaal Sarpa. The 12 type names map to Rahu's house
(Anant, Kulik, Vasuki, Shankhpal, Padma, Mahapadma, Takshak, Karkotak,
Shankhachud, Ghatak, Vishdhar, Sheshnag).

## Worked example (Mahatma Gandhi)

Libra Lagna, Mars/Mercury/Venus in Libra (1st), Moon + Rahu in Cancer (10th):

- **Mangal Dosha** — Mars in the 1st (and a Manglik house from the Moon).
- **Chandra Grahan Dosha** — Moon conjunct Rahu.

## Justify (AI explanation)

Each dosha card carries the same **"✦ Justify with sources"** button as the other
modules. It streams an AI justification grounded in the classical references shown
for that dosha, plus an enhanced reading.

- **Grounding:** `doshaReferences(dosha)` in
  [`src/astro/references.ts`](../src/astro/references.ts) supplies the `facts` and
  attributed `references` (Phaladeepika, Saravali, BPHS, Jataka Parijata, and —
  honestly labelled — "Traditional Jyotisha practice" for later doshas such as
  Kaal Sarpa, Shrapit and Angarak).
- **Availability:** shown only for **Pro/Premium** users when an LLM engine is
  active (Admin → AI/LLM). Free users and an unset engine hide it. With no API
  key, the offline **demo** engine composes the justification from the references;
  a real key streams a live response.

See [feature-flags.md](feature-flags.md) and the AI/LLM admin section for how the
shared engine is configured.

## Scope & disclaimer

Covers the widely-taught chart doshas above. Not included: match-only doshas that
need two charts (e.g. Nadi Dosha — see the Marriage Match tab), and transit-based
afflictions like Sade Sati (see the Transit tab). Dosha strength depends on
dignity, aspects and the whole chart, so treat the output as a study aid — not
medical, legal, financial or psychological advice.
