# ☸ Shastri

**A complete Indian Vedic astrology (Jyotisha) application** — compute a precise
birth chart from time and place, understand what it means, learn the theory as
you go, and receive predictions and remedies with the reasoning behind them.

The astronomy is fully self-contained: Shastri computes planetary positions
with its own engine (no ephemeris files, no external APIs) entirely in the
browser. An **optional API server** adds social sign-in and cloud-saved charts —
the chart computation never leaves the client.

---

## What it does

| Area | What you get |
| --- | --- |
| **Kundli (chart)** | Sidereal (Nirayana) positions with the **Lahiri ayanamsa**, Lagna (Ascendant), whole-sign houses, **North & South Indian** chart styles, and seven **divisional charts** — Rāśi (D1), Horā (D2), Drekkāṇa (D3), Saptāṁśa (D7), Navāṁśa (D9), Daśāṁśa (D10) and Dvādaśāṁśa (D12). A **"What are D1–D12?" explainer** describes each one, and every varga is **interpreted for its life-area** — e.g. selecting D9 reads its Lagna, 7th house and karakas to explain **marriage**; D10 explains **career** — with a tone, classical basis and an AI **Justify** option. |
| **Predictions** | Personality (Lagna / Moon / Sun), Janma Nakshatra, planet-by-planet and house-by-house readings, dignity (exaltation/debilitation/own sign), and detected **Yogas** — each explained. Placements within ~6′ of a sign/nakshatra/pada boundary are flagged as **borderline** (±). |
| **Dasha** | The full **Vimshottari Dasha** 120-year timeline with nested **Antardasha** and **Pratyantardasha** sub-periods and the currently running Maha→Antar→Pratyantar, with an outlook derived from your chart. |
| **Events** | A life-milestone timeline derived from the chart — Mahadasha changes, **Sade Sati** windows, and **Saturn / Jupiter / nodal returns** — with your age at each. |
| **Transit (Gochara)** | Live transiting positions for any date, read from the natal Moon and Lagna, with classical **Chandra-gochara** favourability per graha and **Sade Sati** detection. |
| **Forecast** | **Daily and weekly** predictions combining the running Vimshottari dasha with the day's transits read from your natal Moon, with an overall tone and highlights. |
| **Remedies (Upaya)** | Per-planet gemstone, mantra, charity and lifestyle remedies — **each with its classical justification** — plus a chart-aware note on which planets to focus on. |
| **Accounts & saved charts** | Optional **email/password or Google / GitHub sign-in** and a personal library of saved charts (create, load, delete) — backed by the API server below. |
| **AI justification** | Bring your own **OpenAI / Claude / Gemini** key (or an offline demo). A **Justify with sources** button grounds each reading in curated classical references and **streams** an enhanced prediction. Keys are encrypted at rest. |
| **Languages** | With an AI engine configured, a single **Translate** toggle renders the readings across **Predictions, Dasha, Events and Forecast** — and AI justifications — in **Telugu, Tamil or Hindi** (the language list is one-line extensible to other Indian languages). |
| **General vs timing** | Every reading is labelled **General · natal** (holds for life) or **Current period** (dasha/transit-dependent), so it's clear which predictions are time-sensitive. |
| **Export** | One-click **Export** produces a print-ready report that opens with a **"life areas at a glance"** summary (marriage, career, children, wealth, siblings, parents — with tone), then the **chart diagram** (your North/South + D-chart choice, or **all D1–D12 side by side**), positions table, per-chart interpretation, predictions and current period (in the selected language) — save as PDF from the browser's print dialog. |
| **Learn** | Nine built-in lessons from foundations (zodiac, planets, houses) to nakshatras, dashas, aspects, yogas and the theory of remedies. |

## How the astronomy works

Everything is derived and explainable:

- **Time → Julian Day** in UT. Picking a city resolves the **historically
  correct UTC offset** for the birth date — daylight saving and past changes
  (e.g. India's 1942–45 wartime +06:30) applied automatically from the IANA
  zone. The instant is then shifted by **ΔT (TT − UT)** — Espenak–Meeus fit —
  before sampling body positions, since the ephemeris series run on Terrestrial
  Time while the Ascendant stays on UT.
- **Sun & Moon**: Meeus low-accuracy solar coordinates and a 60-term truncated
  ELP-2000/82 lunar theory (equinox of date).
- **Mercury–Saturn**: JPL "Keplerian Elements for Approximate Positions of the
  Major Planets" (Standish), computed heliocentrically and reduced to geocentric
  ecliptic longitude — retrograde motion falls out naturally.
- **Rahu / Ketu**: the **mean or true** lunar node (selectable), Ketu opposite.
- **Ascendant / MC**: from local sidereal time, obliquity and latitude.
- **Sidereal conversion**: tropical-of-date longitude minus the ayanamsa,
  consistent across all bodies. Four ayanamsa systems are selectable — **Lahiri**
  (≈ 23°51′ at J2000), **Raman**, **Krishnamurti (KP)** and **Fagan–Bradley**.

The engine is validated against a reference chart in
[`scripts/verify-engine.ts`](scripts/verify-engine.ts); positions match standard
Vedic software to well within the tolerance for sign, nakshatra and pada
placement.

> **Accuracy note.** These approximate theories are excellent for casting birth
> charts (sign, nakshatra, pada, dasha, houses). For research-grade positions to
> the arc-second across all epochs, a full Swiss Ephemeris integration would be
> the next step.

## Getting started

```bash
npm install
npm run dev        # start just the web app (Vite)
npm run dev:all    # start the web app AND the API server together
npm run server     # start only the API server (port 8787)
npm run build      # type-check and build the web app for production
npm run preview    # preview the production build
npm test           # run the Vitest suite (engine, dasha, forecast, events, …)
npm run verify     # run the astronomy engine self-check (human-readable)
```

Open the URL Vite prints (default <http://localhost:5173>). The astrology works
without the server; run `npm run dev:all` to also get sign-in and saved charts.

## Accounts, saved charts & the API server

The `server/` directory is a small **Express + PostgreSQL** API that provides
sign-in and per-user chart storage. In dev, Vite proxies `/api` and `/auth` to
it, so the browser sees a single origin.

Authentication:

- **Email + password** (database-driven) — register and sign in with an email
  and password. Passwords are hashed with scrypt (never stored in plaintext).
- **Google / GitHub OAuth** (optional) — enabled once you supply client
  credentials; falls back to hidden buttons otherwise.
- **Local dev profile** — a provider-less sign-in (`ALLOW_DEV_LOGIN`, on in dev,
  disable in production) so the signed-in experience works instantly.

Setup:

1. Create the database: `createdb shastri`
2. `cp .env.example .env`, set `SESSION_SECRET` and `DATABASE_URL`
   (default `postgres://localhost:5432/shastri`).
3. (Optional) register OAuth apps and add the client id/secret:
   - **Google** — <https://console.cloud.google.com/apis/credentials>, redirect URI `<APP_URL>/auth/google/callback`
   - **GitHub** — <https://github.com/settings/developers>, callback URL `<APP_URL>/auth/github/callback`
4. `npm run dev:all`.

The schema (`users`, `charts`, `user_settings`) is created automatically on first
start. Charts are stored per-user as JSONB and scoped by the session (a signed
JWT cookie).

### AI justification (bring your own key)

Open **AI settings** from the account menu to add an **OpenAI**, **Claude
(Anthropic)** or **Gemini** API key (or pick **Demo (offline)** to try it without
a key). Keys are encrypted at rest with AES-256-GCM (`LLM_ENC_SECRET`) and are
never returned to the browser — only the last 4 characters are shown.

When an engine is active, a **Justify with sources** button appears on each
**graha, bhava (house), yoga and the running dasha**. It sends the placement, the
chart facts, and a set of **paraphrased classical references** (BPHS, Phaladeepika,
Saravali, Uttara Kalamrita, Jataka Parijata) to the model, which **streams back**
(Server-Sent Events, token-by-token) a justification grounded in those sources
plus an enhanced prediction. The references come from the app's own knowledge
base (`src/astro/references.ts`), so citations are real, not invented — the model
only synthesises. The demo engine streams the same way from the references
offline. Results are AI-assisted and clearly labelled as such.

## Project structure

```
src/
  astro/            The astronomy + astrology engine
    time, obliquity, sun, moon, planets, nodes, ascendant   → positions
    engine.ts       → assembles the full sidereal chart
    dasha.ts        → Vimshottari timeline
    aspects.ts      → Drishti (planetary aspects)
    dignity.ts      → exaltation / debilitation / friendships
    yogas.ts        → yoga detection
    interpret.ts    → turns the chart into readable, justified predictions
  data/             Knowledge base
    significations  → planet / sign / house / nakshatra meanings
    remedies        → per-planet remedies with justifications
    lessons         → teaching content
    cities          → offline birthplace gazetteer
  components/       React UI (charts, tables, tabs)
```

## A note on intent

Shastri presents classical Jyotisha for **learning and reflection**. It is not
a substitute for medical, legal, financial or psychological advice, and its
predictions and remedies are offered as traditional guidance and self-work, not
as guarantees.

## Tech

React + TypeScript + Vite. No astronomy or charting libraries — the ephemeris,
the sidereal conversion and the SVG charts are all implemented from scratch and
run entirely offline.
