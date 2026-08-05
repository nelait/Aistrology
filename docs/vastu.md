# Vastu Shastra Analysis

Aistrology includes a **Vastu Shastra** module that analyses the suitability
of a property for a user based on their Vedic birth chart, a property
questionnaire, and an optional floor plan image upload.

## Overview

Vastu Shastra is the ancient Indian science of architecture and spatial
arrangement. This feature combines traditional Vastu rules with the user's
Jyotish birth chart to produce a personalised property suitability report.

### User Flow

1. Navigate to the **Vastu** tab (requires a cast birth chart)
2. Fill out the **12-question property questionnaire**
3. Optionally **upload a floor plan** image (Pro/Premium only)
4. Click **"Analyse Vastu Suitability"** for an instant rule-based analysis
5. Click **"Get AI Analysis"** for LLM-enhanced insights (Pro/Premium only)

---

## Questionnaire Fields

| # | Field | Options | Vastu Significance |
|---|---|---|---|
| 1 | Property Facing Direction | N, NE, E, SE, S, SW, W, NW | Cross-referenced with Lagna direction |
| 2 | Main Entrance Position | N, NE, E, SE, S, SW, W, NW | Mouth of the Vastu Purusha — most important placement |
| 3 | Kitchen Location | N, NE, E, SE, S, SW, W, NW | Ideal: SE (Agni/fire corner) |
| 4 | Master Bedroom | N, NE, E, SE, S, SW, W, NW | Ideal: SW (earth/stability) |
| 5 | Bathroom Location | N, NE, E, SE, S, SW, W, NW | Ideal: NW or W (wind corner) |
| 6 | Water Source / Tank | N, NE, E, SE, S, SW, W, NW | Ideal: NE (Ishanya — purest corner) |
| 7 | Staircase Position | N, NE, E, SE, S, SW, W, NW | Ideal: SW, S, or W (heavy elements) |
| 8 | Pooja Room | N, NE, E, SE, S, SW, W, NW | Ideal: NE or E (sunrise/sacred) |
| 9 | Garden / Open Space | N, NE, E, SE, S, SW, W, NW | Ideal: N, NE, or E (open/light) |
| 10 | Garage / Parking | N, NE, E, SE, S, SW, W, NW | Ideal: NW or SE |
| 11 | Plot Shape | Square, Rectangle, L-shaped, Irregular | Square best (balanced Vastu Purusha) |
| 12 | Land Slope | N, NE, E, SE, Flat, S, SW, W, NW | NE slope ideal (water flows to Ishanya) |

---

## Analysis Engine

The analysis engine in `src/astro/vastu.ts` is a pure-function module
(no network calls) that produces a `VastuResult` with:

- **Overall score** (0–100): weighted 60% room/property Vastu + 40% astrological alignment
- **Room factors**: each room scored 0–10 with severity (good/moderate/bad) and remedy
- **Astrological factors**: chart-based cross-references
- **Top remedies**: prioritised by severity (worst areas first)

### Scoring Logic

Each room is scored by comparing its actual direction against classical
ideal placements:

| Match Type | Score |
|---|---|
| Exact ideal direction | 10 |
| Adjacent direction (±1 on compass) | 6 |
| Neutral direction | 4 |
| Opposite direction | 2 |

Overall severity thresholds:
- **Good** (≥8): No remedies needed
- **Moderate** (5–7): Acceptable, minor remedies suggested
- **Bad** (<5): Significant Vastu defect, strong remedies recommended

### Astrological Cross-References

The engine checks four chart factors:

| Factor | What it checks | Source |
|---|---|---|
| **Lagna Direction** | Ascendant sign → auspicious facing directions | Parashari Jyotish + Vastu Purusha Mandala |
| **4th House Lord** | Property house lord strength (exalted/own/debilitated) | Brihat Parashara Hora Shastra, Ch. 15 |
| **Mars (Bhoomi Karaka)** | Significator of land — house placement | Jataka Parijata, Ch. 9 |
| **Venus (Sukha Karaka)** | Significator of comfort — kendra vs. dusthana | Brihat Parashara Hora Shastra, Ch. 3 |

#### Lagna–Direction Mapping

| Lagna | Auspicious Directions |
|---|---|
| Aries | East, North |
| Taurus | North, West |
| Gemini | North, East |
| Cancer | North, North-East |
| Leo | East, North-East |
| Virgo | North, East |
| Libra | West, North |
| Scorpio | North, East |
| Sagittarius | North-East, East |
| Capricorn | South, West |
| Aquarius | West, North |
| Pisces | North-East, North |

---

## Floor Plan Upload

- **Formats**: JPEG, PNG
- **Max size**: 2 MB
- **Storage**: In-memory only — sent to LLM, then discarded (no persistence)
- **Gating**: Pro/Premium plan required
- When uploaded, the LLM's vision capability analyses the layout for:
  - Room placement relative to compass directions
  - Visible structural Vastu issues
  - Entrance and open space positioning

---

## LLM Integration

### Endpoint

```
POST /api/llm/vastu
```

**Request body:**

```json
{
  "chartSummary": "Lagna: Aries; Sun in Leo (house 5); ...",
  "vastuSummary": "Overall score: 72/100 — Good alignment...",
  "references": ["The NE is the most sacred corner... — Mayamatam, Ch. 7"],
  "floorPlanBase64": "data:image/jpeg;base64,...",  // optional
  "language": "English"  // optional
}
```

**Response:**

```json
{
  "provider": "gemini",
  "analysis": "3-5 sentence analysis...",
  "floorPlanObservations": "2-4 sentences on floor plan (null if no image)",
  "additionalRemedies": ["Remedy 1", "Remedy 2"]
}
```

### Multi-modal Support

When a floor plan image is provided, the endpoint auto-upgrades to a
vision-capable model:

| Provider | Text Model | Vision Model |
|---|---|---|
| OpenAI | configured model | gpt-4o |
| Anthropic | configured model | claude-sonnet-4-20250514 |
| Gemini | configured model | gemini-2.0-flash |

### Demo Mode

Without LLM keys configured, the rule-based analysis works fully. The AI
section returns generic remedies with a prompt to configure a provider.

---

## Rate Limits

Vastu analysis uses the same daily quota system as other LLM features:

| Plan | Daily Vastu Analyses |
|---|---|
| Free | 1 |
| Pro | 5 |
| Premium | 15 |

Quota is tracked in the `checkDailyQuota(userId, "vastu", limit)` system
in `server/rateLimit.ts`.

---

## Classical References

The grounding system (`src/astro/vastuReferences.ts`) provides textual
evidence from classical texts for the LLM to cite:

- **Mayamatam** — Chapters 3, 7, 11 (directions, NE/Ishanya, room placement)
- **Brihat Samhita** (Varahamihira) — Chapter 53 (East/NW directions, bathrooms)
- **Manasara** — Chapters 5, 9, 14 (plot shape, South direction, kitchen fallback)
- **Samarangana Sutradhara** (King Bhoja) — Chapter 15 (SW/earth element)
- **Vishwakarma Vastu Shastra** — Chapter 12 (kitchen/SE/Agni)
- **Vastu Purusha Mandala** — (North/Kubera, entrance, master bedroom)
- **Brihat Parashara Hora Shastra** — Chapters 3, 15 (4th house, Venus)
- **Jataka Parijata** — Chapter 9 (Mars as Bhoomi Karaka)

---

## File Reference

| File | Description |
|---|---|
| `src/astro/vastu.ts` | Core analysis engine (pure functions) |
| `src/astro/vastuReferences.ts` | Classical text references for LLM grounding |
| `src/astro/vastu.test.ts` | 7 unit tests |
| `src/components/VastuView.tsx` | UI component (questionnaire + results) |
| `server/llm.ts` | LLM endpoint (`POST /api/llm/vastu`) |
| `server/rateLimit.ts` | Daily quota config |
| `src/api/client.ts` | Frontend API types + method |
| `src/styles.css` | Vastu-specific CSS rules |
